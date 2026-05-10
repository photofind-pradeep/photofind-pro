require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
  CreateCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  DeleteCollectionCommand,
  ListFacesCommand,
} = require('@aws-sdk/client-rekognition');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');

const sharp = require('sharp');

// ── Resize image for AWS Rekognition (5MB limit) ──
async function resizeForRekognition(buffer) {
  if (buffer.length <= 4 * 1024 * 1024) return buffer;
  try {
    const resized = await sharp(buffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    console.log(`📐 Resized: ${(buffer.length/1024/1024).toFixed(1)}MB → ${(resized.length/1024/1024).toFixed(1)}MB`);
    return resized;
  } catch(e) {
    console.error('⚠️ Resize failed:', e.message);
    return buffer;
  }
}
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ── Cloudinary setup ──
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();

app.use((req, res, next) => {
  const allowedOrigins = [
    'https://www.templecity.digital',
    'https://templecity.digital',
    'https://marvelous-sprite-93a0a2.netlify.app',
    'http://localhost:3000',
    'http://localhost:8080'
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

// ── Razorpay ──
let razorpay;
try {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (keyId && keySecret) {
    razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    console.log('✅ Razorpay initialized');
  }
} catch(e) {
  console.error('❌ Razorpay init error:', e.message);
}

// ── AWS Rekognition ──
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Face Collection (Pre-indexing) ──
function getCollectionId(eventId) {
  // AWS collection IDs must be alphanumeric + hyphens, max 255 chars
  return `photofind-${eventId.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50)}`;
}

async function ensureCollection(eventId) {
  const collectionId = getCollectionId(eventId);
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: collectionId }));
    console.log(`✅ Collection created: ${collectionId}`);
  } catch(e) {
    if (e.name === 'ResourceAlreadyExistsException') {
      console.log(`ℹ️ Collection exists: ${collectionId}`);
    } else {
      throw e;
    }
  }
  return collectionId;
}

async function indexPhotoFaces(photoBuffer, photoName, eventId) {
  try {
    const collectionId = getCollectionId(eventId);
    const resized = await resizeForRekognition(photoBuffer);

    const result = await rekognition.send(new IndexFacesCommand({
      CollectionId: collectionId,
      Image: { Bytes: resized },
      ExternalImageId: photoName.replace(/[^a-zA-Z0-9_.\-:]/g, '_').substring(0, 255),
      DetectionAttributes: ['DEFAULT'],
      MaxFaces: 10,
      QualityFilter: 'AUTO',
    }));

    const facesIndexed = result.FaceRecords?.length || 0;
    console.log(`📸 Indexed ${facesIndexed} face(s) from ${photoName}`);
    return facesIndexed;
  } catch(e) {
    console.error(`⚠️ Index failed for ${photoName}:`, e.message);
    return 0;
  }
}

async function searchFacesByImage(selfieBuffer, collectionId, threshold = 70) {
  try {
    const resized = await resizeForRekognition(selfieBuffer);
    const result = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: resized },
      MaxFaces: 100,
      FaceMatchThreshold: threshold,
    }));
    return result.FaceMatches || [];
  } catch(e) {
    console.error('❌ Search error:', e.message);
    return [];
  }
}

// ── Google Auth ──
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: './service-account.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }
  console.log('✅ Google Auth ready');
} catch (e) {
  console.error('❌ Google Auth failed:', e.message);
}

const drive = google.drive({ version: 'v3', auth });

// ── OAuth2 ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://www.templecity.digital/auth/callback'
);

let photographerTokens = null;
const syncJobs = {};
let clients = [];

// ── Package Config ──
const PACKAGES = {
  basic: {
    name: 'Basic',
    price: 300000, // ₹3,000
    maxPhotos: Infinity,
    aiEdit: false,
    reel: true,
    bgm: true,
    groupPhotos: true,
    duplicateDetection: true,
    bestPhotoAI: false,
    multiPhotographer: true,
    printOrder: true,
    whatsappBot: true,
    faceSwap: true,
    digitalAlbum: false,
    videoDelivery: false,
    virtualExhibition: false,
    albumDesigner: false,
    validity: '45 days',
    validityDays: 45,
  },
  advanced: {
    name: 'Advanced',
    price: 500000, // ₹5,000
    maxPhotos: Infinity,
    aiEdit: true,
    reel: true,
    bgm: true,
    groupPhotos: true,
    duplicateDetection: true,
    bestPhotoAI: false,
    multiPhotographer: true,
    printOrder: true,
    whatsappBot: true,
    faceSwap: true,
    digitalAlbum: true,
    videoDelivery: true,
    virtualExhibition: true,
    albumDesigner: false,
    validity: '90 days',
    validityDays: 90,
  },
  premium: {
    name: 'Premium',
    price: 800000, // ₹8,000
    maxPhotos: Infinity,
    aiEdit: true,
    reel: true,
    bgm: true,
    groupPhotos: true,
    duplicateDetection: true,
    bestPhotoAI: true,
    multiPhotographer: true,
    printOrder: true,
    whatsappBot: true,
    faceSwap: true,
    digitalAlbum: true,
    videoDelivery: true,
    virtualExhibition: true,
    albumDesigner: true,  // ← Smart Album Designer
    validity: '180 days',
    validityDays: 180,
  },
};

// ── Coupon System ──
const COUPONS = {
  'DISCOUNT1000': { discount: 100000, description: '₹1,000 off', type: 'fixed' },
  'DISCOUNT2000': { discount: 200000, description: '₹2,000 off', type: 'fixed' },
  'DISCOUNT3000': { discount: 300000, description: '₹3,000 off', type: 'fixed' },
  'PREMIUM50': { discount: 50, description: '50% off', type: 'percent' },
  'TRYFREE': { discount: 100, description: '100% off — Free Trial', type: 'percent' },
};

function applyCoupon(couponCode, originalAmount) {
  const code = (couponCode || '').toUpperCase().trim();
  const coupon = COUPONS[code];
  if (!coupon) return { valid: false, error: 'Invalid coupon code' };

  let discount = 0;
  if (coupon.type === 'fixed') {
    discount = Math.min(coupon.discount, originalAmount);
  } else if (coupon.type === 'percent') {
    discount = Math.round(originalAmount * coupon.discount / 100);
  }

  const finalAmount = Math.max(0, originalAmount - discount);
  return {
    valid: true,
    discount,
    finalAmount,
    description: coupon.description,
    isFree: finalAmount === 0,
  };
}

// ════════════════════════════════════════
//  HELPER FUNCTIONS
// ════════════════════════════════════════

function generateOrderId() {
  return 'TC' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function detectEventType(eventName) {
  const name = (eventName || '').toLowerCase();
  if (name.includes('wedding') || name.includes('marriage') || name.includes('shaadi') || name.includes('vivah') || name.includes('shadi')) return 'wedding';
  if (name.includes('sangeet') || name.includes('mehndi') || name.includes('haldi')) return 'sangeet';
  if (name.includes('birthday') || name.includes('bday') || name.includes('anni')) return 'birthday';
  if (name.includes('corporate') || name.includes('office') || name.includes('conference')) return 'corporate';
  if (name.includes('graduation') || name.includes('convocation')) return 'graduation';
  return 'wedding';
}

async function makePublicAndGetLinks(fileId, fileName) {
  try {
    await drive.permissions.create({
      fileId, requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch(e) {}
  return {
    id: fileId, name: fileName,
    viewLink: `https://drive.google.com/file/d/${fileId}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
    thumbnailLink: `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
  };
}

async function uploadBufferToDrive(buffer, fileName, folderId, mimeType = 'image/jpeg') {
  const stream = Readable.from(buffer);
  const response = await drive.files.create({
    requestBody: { name: fileName, mimeType, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: 'id, name',
  });
  await drive.permissions.create({
    fileId: response.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return {
    id: response.data.id, name: response.data.name,
    viewLink: `https://drive.google.com/file/d/${response.data.id}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
    thumbnailLink: `https://drive.google.com/thumbnail?id=${response.data.id}&sz=w400`,
  };
}

async function getOrCreateFolder(parentId, folderName) {
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (existing.data.files.length > 0) return existing.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return folder.data.id;
}

async function createEventFolders(name) {
  const eventFolder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [process.env.EVENT_FOLDER_ID] },
    fields: 'id, name',
  });
  await drive.files.create({
    requestBody: { name: 'original', mimeType: 'application/vnd.google-apps.folder', parents: [eventFolder.data.id] },
    fields: 'id',
  });
  await drive.files.create({
    requestBody: { name: 'edited', mimeType: 'application/vnd.google-apps.folder', parents: [eventFolder.data.id] },
    fields: 'id',
  });
  return eventFolder.data;
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ════════════════════════════════════════
//  CLOUDINARY AI PHOTO EDIT
// ════════════════════════════════════════
async function editPhotoWithCloudinary(imageBuffer, eventType = 'wedding') {
  try {
    console.log(`🎨 Cloudinary AI edit starting... (${eventType}) Buffer size: ${(imageBuffer.length/1024).toFixed(0)}KB`);

    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      console.error('❌ Cloudinary not configured!');
      return { buffer: imageBuffer, edited: false };
    }

    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'photofind-temp', resource_type: 'image' },
        (error, result) => {
          if (error) {
            console.error('❌ Cloudinary upload error:', error.message);
            reject(error);
          } else {
            resolve(result);
          }
        }
      );
      uploadStream.end(imageBuffer);
    });

    console.log('✅ Uploaded to Cloudinary:', uploadResult.public_id);

    // Apply AI transformations based on event type
    const transformations = {
      wedding: [
        { effect: 'improve:50' },
        { effect: 'sharpen:50' },
        { effect: 'saturation:20' },
        { effect: 'brightness:10' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      sangeet: [
        { effect: 'improve:60' },
        { effect: 'vibrance:30' },
        { effect: 'saturation:30' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      birthday: [
        { effect: 'improve:50' },
        { effect: 'vibrance:40' },
        { effect: 'saturation:25' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      corporate: [
        { effect: 'improve:40' },
        { effect: 'sharpen:40' },
        { effect: 'brightness:5' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
    };

    const transforms = transformations[eventType] || transformations.wedding;
    const editedUrl = cloudinary.url(uploadResult.public_id, { transformation: transforms });
    console.log('🎨 Downloading edited image from Cloudinary...');

    const editedResponse = await axios.get(editedUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const editedBuffer = Buffer.from(editedResponse.data);

    // Clean up from Cloudinary
    await cloudinary.uploader.destroy(uploadResult.public_id);

    console.log(`✅ Cloudinary AI edit complete! Size: ${(editedBuffer.length/1024).toFixed(0)}KB`);
    return { buffer: editedBuffer, edited: true };

  } catch (err) {
    console.error('⚠️ Cloudinary edit failed:', err.message);
    return { buffer: imageBuffer, edited: false };
  }
}

// ════════════════════════════════════════
//  AUTO BGM SELECTION
// ════════════════════════════════════════
async function getBGMForEvent(eventType) {
  // BGM tracks per event type from Pixabay
  const bgmSearchTerms = {
    wedding: 'romantic wedding instrumental',
    sangeet: 'bollywood festive dance',
    birthday: 'happy birthday celebration',
    corporate: 'corporate professional background',
    graduation: 'inspiring achievement',
  };

  const searchTerm = bgmSearchTerms[eventType] || bgmSearchTerms.wedding;

  try {
    console.log(`🎵 Fetching BGM for: ${eventType}`);

    const response = await axios.get('https://pixabay.com/api/videos/', {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: searchTerm,
        video_type: 'music',
        per_page: 5,
      },
    });

    if (response.data.hits && response.data.hits.length > 0) {
      const randomTrack = response.data.hits[Math.floor(Math.random() * response.data.hits.length)];
      return randomTrack.videos?.medium?.url || null;
    }
  } catch (err) {
    console.error('⚠️ BGM fetch failed:', err.message);
  }

  // Fallback — use local BGM file if exists
  const localBGM = path.join(__dirname, 'bgm', `${eventType}.mp3`);
  if (fs.existsSync(localBGM)) return localBGM;

  return null;
}

// ════════════════════════════════════════
//  FFMPEG REEL GENERATOR
// ════════════════════════════════════════
async function createReel(photoBuffers, eventName, eventType, bgmUrl) {
  const tmpDir = path.join('/tmp', 'reel_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`🎬 Creating AI Highlight Reel with ${photoBuffers.length} photos...`);

    // ── STEP 1: Smart photo selection ──
    // Score each photo by file size (larger = better quality usually)
    const scoredPhotos = photoBuffers.map((buf, i) => ({
      buf, idx: i,
      score: buf.length + (Math.random() * 50000), // slight randomness for variety
    }));

    // Sort by score, pick best ones
    scoredPhotos.sort((a, b) => b.score - a.score);

    // Determine reel length based on photo count
    let maxPhotos, photoDuration;
    if (photoBuffers.length <= 5) {
      maxPhotos = photoBuffers.length;
      photoDuration = 3.5;
    } else if (photoBuffers.length <= 15) {
      maxPhotos = Math.min(photoBuffers.length, 12);
      photoDuration = 3;
    } else if (photoBuffers.length <= 30) {
      maxPhotos = 18;
      photoDuration = 2.5;
    } else {
      maxPhotos = 24;
      photoDuration = 2;
    }

    // Take best photos but maintain original order for storytelling
    const selectedIdxs = new Set(scoredPhotos.slice(0, maxPhotos).map(p => p.idx));
    const selectedBuffers = photoBuffers.filter((_, i) => selectedIdxs.has(i));

    console.log(`📸 Selected ${selectedBuffers.length} best photos for reel`);

    // ── STEP 2: Save & resize photos ──
    const photoPaths = [];
    for (let i = 0; i < selectedBuffers.length; i++) {
      const photoPath = path.join(tmpDir, `photo_${String(i).padStart(3,'0')}.jpg`);
      // Resize to consistent 1080x1350 (4:5 ratio - best for Instagram/Reels)
      try {
        const resized = await sharp(selectedBuffers[i])
          .resize(1080, 1350, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 90 })
          .toBuffer();
        fs.writeFileSync(photoPath, resized);
      } catch(e) {
        fs.writeFileSync(photoPath, selectedBuffers[i]);
      }
      photoPaths.push(photoPath);
    }

    // ── STEP 3: Download BGM ──
    let bgmPath = null;
    if (bgmUrl && bgmUrl.startsWith('http')) {
      try {
        bgmPath = path.join(tmpDir, 'bgm.mp3');
        const bgmResponse = await axios.get(bgmUrl, { responseType: 'arraybuffer', timeout: 15000 });
        fs.writeFileSync(bgmPath, Buffer.from(bgmResponse.data));
        console.log('🎵 BGM downloaded');
      } catch(e) {
        console.log('⚠️ BGM download failed:', e.message);
        bgmPath = null;
      }
    }

    // ── STEP 4: Cinematic transition effects ──
    // Each photo gets a random Ken Burns effect (zoom/pan)
    const kenBurnsEffects = [
      'zoompan=z=\'min(zoom+0.0015,1.5)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=75:s=1080x1350',
      'zoompan=z=\'if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=75:s=1080x1350',
      'zoompan=z=\'min(zoom+0.002,1.5)\':x=\'0\':y=\'0\':d=75:s=1080x1350',
      'zoompan=z=\'min(zoom+0.002,1.5)\':x=\'iw-iw/zoom\':y=\'ih-ih/zoom\':d=75:s=1080x1350',
      'zoompan=z=\'min(zoom+0.001,1.3)\':x=\'iw/2-(iw/zoom/2)\':y=\'0\':d=75:s=1080x1350',
    ];

    // ── STEP 5: Build FFmpeg filter complex for cinematic reel ──
    const outputPath = path.join(tmpDir, 'reel_raw.mp4');

    // Create concat file with durations
    const photoListPath = path.join(tmpDir, 'photos.txt');
    const photoList = photoPaths.map(p => `file '${p}'\nduration ${photoDuration}`).join('\n');
    fs.writeFileSync(photoListPath, photoList + '\n' + `file '${photoPaths[photoPaths.length-1]}'`);

    // Build main reel with transitions
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg()
        .input(photoListPath)
        .inputOptions(['-f concat', '-safe 0']);

      const filters = [
        // Scale to consistent size
        'scale=1080:1350:force_original_aspect_ratio=increase',
        'crop=1080:1350',
        // Smooth framerate
        'fps=30',
        // Color grading by event type
        eventType === 'wedding' ? 'eq=brightness=0.05:saturation=1.15:contrast=1.05' :
        eventType === 'birthday' ? 'eq=brightness=0.08:saturation=1.25:contrast=1.08' :
        'eq=brightness=0.03:saturation=1.1:contrast=1.05',
        // Subtle vignette effect
        'vignette=PI/6',
      ].join(',');

      cmd.videoFilters(filters)
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-r 30',
          '-preset fast',
          '-crf 23',
          '-movflags +faststart',
        ]);

      // Add BGM
      if (bgmPath) {
        cmd.input(bgmPath)
          .audioCodec('aac')
          .audioBitrate('192k')
          .outputOptions(['-shortest', '-map 0:v:0', '-map 1:a:0']);
      } else {
        cmd.outputOptions(['-an']); // No audio if no BGM
      }

      cmd.output(outputPath)
        .on('start', cmd => console.log('🎬 FFmpeg started'))
        .on('progress', p => { if(p.percent) console.log(`🎬 Reel progress: ${Math.round(p.percent)}%`); })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // ── STEP 6: Add cinematic text overlays ──
    const finalPath = path.join(tmpDir, 'reel_final.mp4');
    const safeEventName = eventName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);

    const totalDuration = selectedBuffers.length * photoDuration;
    const textStartTime = totalDuration - 4; // Show text in last 4 seconds

    await new Promise((resolve, reject) => {
      ffmpeg(outputPath)
        .videoFilters([
          // Fade in at start
          'fade=t=in:st=0:d=1.5',
          // Fade out at end
          `fade=t=out:st=${totalDuration - 1.5}:d=1.5`,
          // Event name overlay at end
          `drawtext=text='${safeEventName}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.78:shadowcolor=black:shadowx=3:shadowy=3:enable='gte(t,${textStartTime})'`,
          // Tagline
          `drawtext=text='PhotoFind Pro':fontsize=28:fontcolor=rgba(232\\,200\\,122\\,200):x=(w-text_w)/2:y=h*0.86:shadowcolor=black:shadowx=2:shadowy=2:enable='gte(t,${textStartTime})'`,
          // Subtle border/frame
          `drawbox=x=0:y=0:w=iw:h=40:color=black@0.4:t=fill`,
          `drawbox=x=0:y=ih-40:w=iw:h=40:color=black@0.4:t=fill`,
        ])
        .outputOptions(['-c:a copy'])
        .output(finalPath)
        .on('end', resolve)
        .on('error', (err) => {
          console.log('⚠️ Text overlay failed, using raw:', err.message);
          fs.copyFileSync(outputPath, finalPath);
          resolve();
        })
        .run();
    });

    const reelBuffer = fs.readFileSync(finalPath);
    console.log(`✅ AI Highlight Reel created: ${(reelBuffer.length/1024/1024).toFixed(1)}MB | ${selectedBuffers.length} photos | ${totalDuration.toFixed(0)}s`);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return reelBuffer;

  } catch (err) {
    console.error('❌ Reel creation failed:', err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

app.get('/health', (req, res) => {
  res.json({
    status: 'PhotoFind Pro server is running ✅',
    hasGoogleCredentials: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasAWSKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasCloudinary: !!process.env.CLOUDINARY_CLOUD_NAME,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    hasOAuth: !!process.env.GOOGLE_CLIENT_ID,
    photographerConnected: !!photographerTokens,
    activeSyncJobs: Object.keys(syncJobs).length,
    totalClients: clients.length,
  });
});

// ── Validate Coupon ──
app.post('/coupon/validate', (req, res) => {
  const { couponCode, package: pkg } = req.body;
  const pkgConfig = PACKAGES[pkg] || PACKAGES.basic;
  const result = applyCoupon(couponCode, pkgConfig.price);

  if (!result.valid) {
    return res.json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    couponCode: couponCode.toUpperCase().trim(),
    description: result.description,
    originalAmount: pkgConfig.price,
    discount: result.discount,
    finalAmount: result.finalAmount,
    isFree: result.isFree,
    savings: `₹${(result.discount / 100).toLocaleString('en-IN')}`,
  });
});

// ── Add Coupon (Admin only) ──
app.post('/admin/coupon/add', adminAuth, (req, res) => {
  const { code, discount, type, description } = req.body;
  if (!code || !discount || !type) {
    return res.status(400).json({ success: false, error: 'Code, discount and type required' });
  }
  COUPONS[code.toUpperCase()] = { discount: type === 'fixed' ? discount * 100 : discount, type, description: description || `₹${discount} off` };
  res.json({ success: true, message: `Coupon ${code.toUpperCase()} added`, coupons: Object.keys(COUPONS) });
});

// ── List Coupons (Admin only) ──
app.get('/admin/coupons', adminAuth, (req, res) => {
  const couponList = Object.entries(COUPONS).map(([code, details]) => ({
    code,
    discount: details.type === 'fixed' ? `₹${details.discount / 100}` : `${details.discount}%`,
    type: details.type,
    description: details.description,
  }));
  res.json({ success: true, coupons: couponList });
});

// ── Payment Routes ──
app.post('/payment/create-order', async (req, res) => {
  try {
    console.log('💳 Creating order...');
    const { eventName, eventDate, studioName, phone, package: pkg, couponCode } = req.body;

    if (!eventName || !eventDate || !studioName || !phone) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    if (!razorpay) {
      return res.status(500).json({ success: false, error: 'Payment not configured' });
    }

    const pkgConfig = PACKAGES[pkg] || PACKAGES.basic;
    let finalAmount = pkgConfig.price;
    let couponApplied = null;

    // Apply coupon if provided
    if (couponCode) {
      const couponResult = applyCoupon(couponCode, pkgConfig.price);
      if (couponResult.valid) {
        finalAmount = couponResult.finalAmount;
        couponApplied = couponResult;
        console.log(`🎟️ Coupon applied: ${couponCode} — ${couponResult.description} — Final: ₹${finalAmount/100}`);
      } else {
        return res.status(400).json({ success: false, error: couponResult.error });
      }
    }

    // If 100% discount — skip Razorpay and create event directly
    if (finalAmount === 0) {
      console.log('🆓 Free order — skipping Razorpay');
      return res.json({
        success: true,
        isFree: true,
        orderId: 'FREE_' + generateOrderId(),
        amount: 0,
        currency: 'INR',
        keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
        package: pkg,
        packageName: pkgConfig.name,
        couponApplied,
      });
    }

    const order = await razorpay.orders.create({
      amount: finalAmount,
      currency: 'INR',
      receipt: generateOrderId(),
      notes: { eventName, eventDate, studioName, phone, package: pkg, couponCode: couponCode || '' },
    });

    console.log('✅ Order created:', order.id, '— Amount: ₹' + finalAmount/100);

    res.json({
      success: true,
      isFree: false,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: (process.env.RAZORPAY_KEY_ID || '').trim(),
      package: pkg,
      packageName: pkgConfig.name,
      couponApplied,
    });
  } catch (err) {
    console.error('❌ Order error:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Payment order creation failed' });
  }
});

app.post('/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, eventName, eventDate, studioName, phone, email, amount, package: pkg, isFree } = req.body;

    // Skip signature verification for free orders
    if (!isFree) {
      const sign = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSign = crypto.createHmac('sha256', (process.env.RAZORPAY_KEY_SECRET || '').trim()).update(sign).digest('hex');
      if (expectedSign !== razorpay_signature) {
        return res.status(400).json({ success: false, error: 'Payment verification failed' });
      }
      console.log(`✅ Payment verified: ${razorpay_payment_id}`);
    } else {
      console.log('🆓 Free order — skipping verification');
    }

    const pkgConfig = PACKAGES[pkg] || PACKAGES.basic;
    const eventType = detectEventType(eventName);
    const studioSuffix = studioName ? `__${studioName.replace(/\s+/g, '-')}__${phone}__${pkg}` : '';
    const folderName = `${eventDate}_${eventName.replace(/\s+/g, '-').replace(/&/g, 'and')}${studioSuffix}`;
    const eventFolder = await createEventFolders(folderName);

    // ── Auto share Drive folder with photographer ──
    let driveFolderShared = false;
    try {
      const subfolders = await drive.files.list({
        q: `'${eventFolder.id}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      });
      if (subfolders.data.files.length > 0) {
        // Make folder publicly accessible via link (anyone with link can upload)
        await drive.permissions.create({
          fileId: subfolders.data.files[0].id,
          requestBody: { role: 'writer', type: 'anyone' },
        });
        // Also share with their email if gmail
        if (email && email.toLowerCase().includes('gmail.com')) {
          await drive.permissions.create({
            fileId: subfolders.data.files[0].id,
            requestBody: { role: 'writer', type: 'user', emailAddress: email },
            sendNotificationEmail: true,
          });
        }
        driveFolderShared = true;
        console.log(`✅ Drive folder auto-shared!`);
      }
    } catch(e) {
      console.log(`⚠️ Drive share warning: ${e.message}`);
    }

    const baseUrl = 'https://www.templecity.digital';
    const uploadLink = `${baseUrl}/upload.html?event=${eventFolder.id}`;
    const guestLink = `${baseUrl}?event=${eventFolder.id}`;
    const driveLink = `https://drive.google.com/drive/folders/${eventFolder.id}`;
    const albumLink = `${baseUrl}/album.html?event=${eventFolder.id}&type=${eventType}`;
    const videoLink = `${baseUrl}/video.html?event=${eventFolder.id}`;
    const exhibitionLink = `${baseUrl}/exhibition.html?event=${eventFolder.id}`;
    const albumDesignerLink = pkgConfig.albumDesigner ? `${baseUrl}/albumdesigner.html?event=${eventFolder.id}` : null;
    const inviteCreatorLink = `${baseUrl}/invite-creator.html`;

    const whatsappMsg =
      `📸 *PhotoFind Pro — ${pkgConfig.name} Plan Ready!*\n\n` +
      `*Event:* ${eventName}\n` +
      `*Date:* ${eventDate}\n` +
      `*Studio:* ${studioName}\n\n` +
      `*━━━ UPLOAD YOUR PHOTOS ━━━*\n\n` +
      `*📤 Option 1 — Upload Link:*\n${uploadLink}\n` +
      `_Open link → Select photos → Upload directly_\n\n` +
      `*📁 Option 2 — Google Drive Folder:*\n${driveLink}\n` +
      `_Open Drive app → Upload to this folder_\n\n` +
      `*━━━ SHARE WITH GUESTS ━━━*\n\n` +
      `*🎊 Guest QR Link:*\n${guestLink}\n` +
      `_Guests scan face → find photos instantly!_\n\n` +
      `*━━━ CLIENT ALBUM ━━━*\n\n` +
      `*📖 Digital Flip Book Album:*\n${albumLink}\n` +
      `_Beautiful cinematic album with BGM — share with family!_\n\n` +
      `*🎬 Event Video Page:*\n${videoLink}\n` +
      `_Upload your final edited video here — family watches online!_\n\n` +
      `*🏛️ Virtual Exhibition:*\n${exhibitionLink}\n` +
      `_Beautiful gallery — guests browse all event photos online!_\n\n` +
      `${albumDesignerLink ? `*🎨 Smart Album Designer:*\n${albumDesignerLink}\n_AI auto-designs print-ready albums!_\n\n` : ''}` +
      `*━━━ BONUS SERVICES ━━━*\n\n` +
      `*💌 Digital Wedding Invitation:*\n${inviteCreatorLink}\n_Create beautiful animated invites — share on WhatsApp!_\n\n` +
      `*━━━ YOUR PLAN INCLUDES ━━━*\n\n` +
      `✅ AI Face Recognition\n` +
      `✅ Solo + Group Photos\n` +
      `✅ Instagram Reels + BGM\n` +
      `✅ Duplicate Detection\n` +
      `✅ Best Photo AI\n` +
      `✅ Multi Photographer\n` +
      `✅ Print Order\n` +
      `✅ Face Swap\n` +
      `${pkgConfig.aiEdit ? '✅ AI Photo Enhancement\n' : ''}` +
      `${pkgConfig.digitalAlbum ? '✅ Digital Flip Book Album\n' : ''}` +
      `${pkgConfig.videoDelivery ? '✅ Video Delivery Page\n' : ''}` +
      `${pkgConfig.virtualExhibition ? '✅ Virtual Exhibition\n' : ''}` +
      `${pkgConfig.albumDesigner ? '✅ Smart Album Designer (Print-Ready)\n' : ''}` +
      `${pkgConfig.bestPhotoAI ? '✅ Best Photo AI Selection\n' : ''}` +
      `\n*Plan:* ${pkgConfig.name} — ${pkgConfig.validity} days validity\n\n` +
      `_Powered by Temple City Digital_\n🌐 www.templecity.digital`;

    const waLink = `https://wa.me/91${phone}?text=${encodeURIComponent(whatsappMsg)}`;

    const client = {
      id: eventFolder.id,
      eventName, eventDate, studioName, phone, email,
      amount: amount / 100,
      package: pkg,
      packageName: pkgConfig.name,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      uploadLink, guestLink,
      createdAt: new Date().toISOString(),
      status: 'active',
      photoCount: 0,
      eventType,
    };
    clients.push(client);

    res.json({ success: true, eventId: eventFolder.id, eventName, studioName, uploadLink, guestLink, albumLink, waLink, package: pkg, packageConfig: pkgConfig });
  } catch (err) {
    console.error('❌ Verify error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin Routes ──
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.get('/admin/clients', adminAuth, async (req, res) => {
  try {
    const driveEvents = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json({ success: true, clients, driveEvents: driveEvents.data.files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/stats', adminAuth, (req, res) => {
  const totalRevenue = clients.reduce((sum, c) => sum + (c.amount || 0), 0);
  res.json({
    success: true,
    stats: {
      totalClients: clients.length,
      totalRevenue,
      activeEvents: clients.filter(c => c.status === 'active').length,
      syncingEvents: Object.keys(syncJobs).length,
    }
  });
});

app.delete('/admin/event/:eventId', adminAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    if (syncJobs[eventId]) { clearInterval(syncJobs[eventId]); delete syncJobs[eventId]; }
    await drive.files.update({ fileId: eventId, requestBody: { trashed: true } });
    clients = clients.filter(c => c.id !== eventId);
    res.json({ success: true, message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/admin/client/:eventId', adminAuth, (req, res) => {
  const client = clients.find(c => c.id === req.params.eventId);
  if (client) { client.status = req.body.status; res.json({ success: true, client }); }
  else res.status(404).json({ success: false, error: 'Not found' });
});

// ── Share Drive Folder with Photographer ──
app.post('/share-folder', async (req, res) => {
  try {
    const { eventId, email } = req.body;
    if (!eventId || !email) return res.status(400).json({ success: false, error: 'Event ID and email required' });

    // Find original folder
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'Event folder not found' });
    }

    const originalFolderId = subfolders.data.files[0].id;

    // Share original folder with photographer (writer access)
    await drive.permissions.create({
      fileId: originalFolderId,
      requestBody: {
        role: 'writer',
        type: 'user',
        emailAddress: email,
      },
      sendNotificationEmail: true,
    });

    console.log(`✅ Folder shared with ${email}: ${originalFolderId}`);

    res.json({
      success: true,
      message: `Folder shared with ${email}`,
      folderId: originalFolderId,
    });
  } catch (err) {
    console.error('❌ Share folder error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Auto Delete Expired Events ──
app.get('/admin/check-expiry', adminAuth, async (req, res) => {
  try {
    const expired = [];
    const expiringSoon = [];

    for (const client of clients) {
      const pkg = client.package || 'basic';
      const validity = pkg === 'advanced' ? 90 : 45;
      const createdDate = new Date(client.createdAt);
      const expiryDate = new Date(createdDate.getTime() + validity * 24 * 60 * 60 * 1000);
      const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));

      client.daysLeft = daysLeft;
      client.expiryDate = expiryDate.toISOString().split('T')[0];

      if (daysLeft <= 0) expired.push(client);
      else if (daysLeft <= 3) expiringSoon.push(client);
    }

    res.json({ success: true, expired, expiringSoon, total: clients.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/photoslibrary.readonly', 'https://www.googleapis.com/auth/drive'],
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    photographerTokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#07080A;color:white"><h2 style="color:#E8C07A">✅ Connected!</h2><a href="/dashboard.html" style="background:#E8C07A;color:#07080A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Go to Dashboard →</a></body></html>`);
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ connected: !!photographerTokens, activeSyncs: Object.keys(syncJobs).length });
});

// ── Sync Routes ──
app.post('/sync/start', async (req, res) => {
  try {
    const { eventId, eventDate } = req.body;
    if (!photographerTokens) return res.status(401).json({ success: false, error: 'Not authenticated', authUrl: '/auth/google' });

    oauth2Client.setCredentials(photographerTokens);
    const photosApi = google.photoslibrary({ version: 'v1', auth: oauth2Client });

    if (syncJobs[eventId]) clearInterval(syncJobs[eventId]);

    const syncFn = async () => {
      try {
        const subfolders = await drive.files.list({
          q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
        });
        if (!subfolders.data.files.length) return;

        const originalFolderId = subfolders.data.files[0].id;
        const existing = await drive.files.list({
          q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
          fields: 'files(id, name)', pageSize: 1000,
        });
        const existingNames = new Set(existing.data.files.map(f => f.name));

        const dateParts = (eventDate || new Date().toISOString().split('T')[0]).split('-');
        const photosRes = await photosApi.mediaItems.search({
          requestBody: {
            filters: { dateFilter: { dates: [{ year: parseInt(dateParts[0]), month: parseInt(dateParts[1]), day: parseInt(dateParts[2]) }] } },
            pageSize: 100,
          },
        });

        const items = photosRes.data.mediaItems || [];
        let synced = 0;
        for (const item of items) {
          if (existingNames.has(item.filename)) continue;
          try {
            const imgRes = await fetch(`${item.baseUrl}=d`);
            if (!imgRes.ok) continue;
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await drive.files.create({
              requestBody: { name: item.filename, mimeType: item.mimeType || 'image/jpeg', parents: [originalFolderId] },
              media: { mimeType: item.mimeType || 'image/jpeg', body: Readable.from(buf) },
              fields: 'id',
            });
            synced++;
            existingNames.add(item.filename);
          } catch(e) {}
        }
        if (synced > 0) console.log(`🔄 Synced ${synced} new photos for event ${eventId}`);
      } catch(e) {
        console.error('Sync error:', e.message);
      }
    };

    await syncFn();
    syncJobs[eventId] = setInterval(syncFn, 2 * 60 * 1000);
    res.json({ success: true, message: 'Live sync started' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/sync/stop', (req, res) => {
  const { eventId } = req.body;
  if (syncJobs[eventId]) { clearInterval(syncJobs[eventId]); delete syncJobs[eventId]; }
  res.json({ success: true });
});

app.post('/sync/now', async (req, res) => {
  res.json({ success: true, message: 'Use sync/start for immediate sync' });
});

app.get('/sync/status/:eventId', (req, res) => {
  res.json({ success: true, isActive: !!syncJobs[req.params.eventId] });
});

// ── Event Routes ──
app.get('/events', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json({ success: true, events: response.data.files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Generate AI Highlight Reel for Full Event ──
app.post('/generate-highlight/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { style = 'wedding', maxPhotos = 30 } = req.body;

    console.log(`🎬 Generating AI Highlight Reel for event: ${eventId}`);

    // Get event info
    const eventsRes = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });
    const eventFile = eventsRes.data.files.find(e => e.id === eventId);
    const eventName = eventFile?.name?.split('__')[0].replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/-/g, ' ') || 'Your Event';
    const eventType = detectEventType(eventFile?.name || '');

    // Get photos
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'No photos found' });
    }

    const photosRes = await drive.files.list({
      q: `'${subfolders.data.files[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, size)', pageSize: 500,
      orderBy: 'name',
    });

    const allPhotos = photosRes.data.files;
    console.log(`📸 Total photos: ${allPhotos.length}`);

    // Sample photos evenly across event
    const limit = Math.min(parseInt(maxPhotos), 50, allPhotos.length);
    const step = Math.floor(allPhotos.length / limit);
    const selectedPhotos = allPhotos.filter((_, i) => i % step === 0).slice(0, limit);

    console.log(`📸 Selected ${selectedPhotos.length} photos for highlight reel`);

    // Download selected photos
    const photoBuffers = [];
    for (const photo of selectedPhotos) {
      try {
        const stream = await drive.files.get(
          { fileId: photo.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        photoBuffers.push(Buffer.from(stream.data));
      } catch(e) {
        console.log(`⚠️ Skip ${photo.name}`);
      }
    }

    // Get BGM
    const bgmUrl = await getBGMForEvent(eventType);

    // Create highlight reel
    const reelBuffer = await createReel(photoBuffers, eventName, eventType, bgmUrl);

    // Upload to Drive
    const reelFolderId = await getOrCreateFolder(eventId, 'reels');
    const reelFile = await uploadBufferToDrive(
      reelBuffer,
      `highlight_reel_${Date.now()}.mp4`,
      reelFolderId,
      'video/mp4'
    );

    console.log(`✅ Highlight reel uploaded: ${reelFile.viewLink}`);
    res.json({
      success: true,
      reelLink: reelFile.viewLink,
      photoCount: photoBuffers.length,
      eventName,
    });

  } catch(err) {
    console.error('❌ Highlight reel error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
function buildInquiryMessage(data) {
  const { coupleName, couplePhone, budget, services, eventDays, message } = data;
  let msg = `📸 Booking Request from ${coupleName}\n📱 +91${couplePhone}\n💰 Budget: ${budget || 'TBD'}\n\n`;
  if(services?.length > 0) msg += `🎯 Services: ${services.map(s=>s.icon+' '+s.name).join(', ')}\n\n`;
  if(eventDays?.length > 0) {
    msg += `📅 Event Schedule:\n`;
    eventDays.forEach((day, i) => {
      const date = day.date ? new Date(day.date+'T12:00:00').toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric'}) : 'TBD';
      msg += `Day ${i+1} (${date}): ${(day.services||[]).map(s=>s.icon+' '+s.name).join(', ')}${day.venue?' @ '+day.venue:''}\n`;
    });
  }
  if(message) msg += `\n💬 ${message}`;
  return msg;
}

// ── Photographer Inquiry & Commission System ──
const inquiries = {}; // { photographerId: [inquiries] }
const bookings = [];  // confirmed bookings

// Send inquiry to photographer
app.post('/send-inquiry', async (req, res) => {
  try {
    const { photographerId, photographerPhone, photographerName,
            coupleName, couplePhone, eventDate, budget, eventType, message } = req.body;

    if (!photographerId || !coupleName || !couplePhone) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const inquiryId = `inq_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    const inquiry = {
      id: inquiryId,
      photographerId,
      photographerName,
      coupleName,
      couplePhone,
      eventDate,
      budget,
      eventType,
      services: req.body.services || [],
      eventDays: req.body.eventDays || [],
      message,
      status: 'new',
      messages: [
        {
          from: 'couple',
          name: coupleName,
          text: buildInquiryMessage(req.body),
          timestamp: new Date().toISOString(),
        }
      ],
      createdAt: new Date().toISOString(),
      commission: null,
    };

    if (!inquiries[photographerId]) inquiries[photographerId] = [];
    inquiries[photographerId].push(inquiry);

    console.log(`💬 New inquiry: ${coupleName} → ${photographerName}`);

    // Send WhatsApp notification to photographer
    if (photographerPhone) {
      const waMsg = `🔔 *New Inquiry — PhotoFind Pro*\n\n` +
        `👰 *From:* ${coupleName}\n` +
        `📱 *Phone:* +91${couplePhone}\n` +
        `📅 *Event Date:* ${eventDate || 'Not specified'}\n` +
        `🎯 *Event Type:* ${eventType || 'Wedding'}\n` +
        `💰 *Budget:* ${budget || 'Not specified'}\n\n` +
        `💬 *Message:* ${message}\n\n` +
        `📲 Reply on PhotoFind Pro:\n` +
        `https://www.templecity.digital/photographer-inbox.html?ph=${photographerId}\n\n` +
        `_Track all inquiries & mark bookings on your dashboard_`;

      console.log(`📱 WhatsApp to ${photographerPhone}: ${waMsg.substring(0,50)}...`);
    }

    res.json({ success: true, inquiryId, message: 'Inquiry sent successfully!' });
  } catch(err) {
    console.error('❌ Inquiry error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get inquiries for a photographer
app.get('/inquiries/:photographerId', (req, res) => {
  const phInquiries = inquiries[req.params.photographerId] || [];
  res.json({ success: true, inquiries: phInquiries, total: phInquiries.length });
});

// Reply to an inquiry
app.post('/reply-inquiry', (req, res) => {
  try {
    const { photographerId, inquiryId, replyText, photographerName } = req.body;
    const phInquiries = inquiries[photographerId] || [];
    const inquiry = phInquiries.find(i => i.id === inquiryId);

    if (!inquiry) return res.status(404).json({ success: false, error: 'Inquiry not found' });

    inquiry.messages.push({
      from: 'photographer',
      name: photographerName || 'Photographer',
      text: replyText,
      timestamp: new Date().toISOString(),
    });
    inquiry.status = 'replied';

    console.log(`💬 Reply sent: ${photographerName} → ${inquiry.coupleName}`);
    res.json({ success: true, message: 'Reply sent!' });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark as booked + calculate commission
app.post('/mark-booked', async (req, res) => {
  try {
    const { photographerId, inquiryId, bookingAmount, eventDate, coupleName, photographerName, photographerPhone } = req.body;
    const phInquiries = inquiries[photographerId] || [];
    const inquiry = phInquiries.find(i => i.id === inquiryId);

    if (!inquiry) return res.status(404).json({ success: false, error: 'Inquiry not found' });

    const commissionRate = 0.05; // 5%
    const commissionAmount = Math.round(bookingAmount * commissionRate);

    inquiry.status = 'booked';
    inquiry.commission = {
      bookingAmount: parseInt(bookingAmount),
      rate: commissionRate,
      amount: commissionAmount,
      status: 'pending', // pending, paid
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    };

    const booking = {
      id: `bk_${Date.now()}`,
      photographerId,
      photographerName,
      photographerPhone,
      inquiryId,
      coupleName: inquiry.coupleName,
      couplePhone: inquiry.couplePhone,
      eventDate,
      bookingAmount: parseInt(bookingAmount),
      commissionAmount,
      commissionStatus: 'pending',
      bookedAt: new Date().toISOString(),
    };
    bookings.push(booking);

    console.log(`✅ Booking confirmed! ${coupleName} × ${photographerName} — Commission: ₹${commissionAmount}`);

    // Send commission invoice via WhatsApp to photographer
    if (photographerPhone) {
      const invoiceMsg = `✅ *Booking Confirmed — PhotoFind Pro*\n\n` +
        `💑 *Couple:* ${inquiry.coupleName}\n` +
        `📅 *Event Date:* ${eventDate}\n` +
        `💰 *Booking Amount:* ₹${parseInt(bookingAmount).toLocaleString('en-IN')}\n\n` +
        `📊 *Platform Commission (5%):*\n` +
        `₹${commissionAmount.toLocaleString('en-IN')}\n\n` +
        `⏳ *Due within 7 days*\n\n` +
        `Pay commission:\nhttps://www.templecity.digital/booking.html\n\n` +
        `_Thank you for using PhotoFind Pro!_`;

      console.log(`💬 Commission invoice sent to ${photographerPhone}`);
    }

    res.json({
      success: true,
      booking,
      commission: commissionAmount,
      message: `Booking confirmed! Commission of ₹${commissionAmount} due within 7 days.`
    });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all bookings (admin)
app.get('/bookings', (req, res) => {
  const totalCommission = bookings.reduce((sum, b) => sum + b.commissionAmount, 0);
  const paidCommission = bookings.filter(b => b.commissionStatus === 'paid').reduce((sum, b) => sum + b.commissionAmount, 0);
  res.json({ success: true, bookings, total: bookings.length, totalCommission, paidCommission });
});

// Get booking stats for dashboard
app.get('/commission-stats', (req, res) => {
  const stats = {
    totalBookings: bookings.length,
    pendingCommission: bookings.filter(b => b.commissionStatus === 'pending').reduce((sum, b) => sum + b.commissionAmount, 0),
    paidCommission: bookings.filter(b => b.commissionStatus === 'paid').reduce((sum, b) => sum + b.commissionAmount, 0),
    totalCommission: bookings.reduce((sum, b) => sum + b.commissionAmount, 0),
  };
  res.json({ success: true, stats });
});
// ── Seedance 2.0 Video Generation ──
let replicate = null;
try {
  const Replicate = require('replicate');
  replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  console.log('✅ Replicate initialized');
} catch(e) {
  console.log('⚠️ Replicate not available:', e.message);
}

const VIDEO_PROMPTS = {
  wedding: 'Cinematic Indian wedding mandap, golden pillars with marigold garlands, sacred fire in center, rose petals falling slowly, warm golden light, oil lamps glowing, soft bokeh, ethereal atmosphere, slow motion, ultra detailed',
  floral: 'Beautiful Indian wedding decoration, pink and white roses, jasmine flower strings hanging, fairy lights twinkling, golden drapes, soft pink light, rose petals floating, dreamy romantic, slow gentle motion, cinematic',
  royal: 'Majestic Indian royal palace interior, gold ornate pillars, crystal chandeliers glowing, red and gold silk curtains swaying, marble floor reflection, candles flickering, royal wedding ambiance, cinematic wide shot, warm regal light',
  traditional: 'Traditional Odia wedding ceremony, tulsi plant with oil diyas, conch shell, alpana patterns on floor, banana leaves decoration, marigold strings, red and gold color scheme, sacred atmosphere, warm candlelight, slow cinematic motion',
  night: 'Outdoor Indian wedding at night, thousands of fairy lights on trees, starry sky above, marigold arch glowing golden, candles everywhere, fireflies floating, magical ethereal atmosphere, cinematic slow motion',
  rajasthani: 'Rajasthani desert wedding at golden sunset, sand dunes, ornate haveli, marigold decorations, traditional rangoli glowing, oil diyas, warm orange sky, gentle breeze moving fabric, cinematic drone shot, slow motion',
};

app.post('/generate-video-invite', async (req, res) => {
  try {
    if(!replicate) return res.status(500).json({success:false, error:'Replicate not configured'});
    const { prompt, style = 'wedding', duration = 8, aspectRatio = '9:16' } = req.body;
    const finalPrompt = prompt || VIDEO_PROMPTS[style] || VIDEO_PROMPTS.wedding;
    console.log(`🎬 Generating Seedance 2.0 video — style: ${style}`);

    const output = await replicate.run('bytedance/seedance-2.0', {
      input: {
        prompt: finalPrompt,
        duration: parseInt(duration),
        aspect_ratio: aspectRatio,
        resolution: '720p',
      }
    });

    console.log(`✅ Video ready: ${output}`);
    res.json({ success: true, videoUrl: output, style, prompt: finalPrompt });
  } catch(err) {
    console.error('❌ Seedance error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick GET test — open in browser directly!
app.get('/test-seedance', async (req, res) => {
  try {
    if(!replicate) return res.status(500).json({success:false, error:'Replicate not configured'});
    const style = req.query.style || 'wedding';
    const finalPrompt = VIDEO_PROMPTS[style] || VIDEO_PROMPTS.wedding;
    console.log(`🎬 TEST — Seedance 2.0 — style: ${style}`);

    const output = await replicate.run('bytedance/seedance-2.0', {
      input: {
        prompt: finalPrompt,
        duration: 5,
        aspect_ratio: '9:16',
        resolution: '480p',
      }
    });

    res.json({
      success: true,
      videoUrl: output,
      style,
      prompt: finalPrompt,
      message: '🎬 Seedance 2.0 working perfectly!'
    });
  } catch(err) {
    console.error('❌ Test error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Photographer Portfolio Management ──
const portfolios = {};

app.post('/save-portfolio', async (req, res) => {
  try {
    const { photographerId, service, photos, videos, driveLink } = req.body;
    if(!photographerId || !service) return res.status(400).json({success:false,error:'Missing fields'});
    if(!portfolios[photographerId]) portfolios[photographerId] = {};
    portfolios[photographerId][service] = {
      photos: photos || [], videos: videos || [],
      driveLink: driveLink || '', updatedAt: new Date().toISOString(),
    };
    console.log(`📸 Portfolio saved: ${photographerId} → ${service}`);
    res.json({success:true, message:'Portfolio saved!'});
  } catch(err) {
    res.status(500).json({success:false, error:err.message});
  }
});

app.get('/photographer-profile/:id', (req, res) => {
  const ph = photographers.find(p => p.id === req.params.id);
  if(!ph) return res.status(404).json({success:false, error:'Not found'});
  res.json({success:true, photographer:ph, portfolio: portfolios[req.params.id] || {}});
});

app.get('/portfolio/:photographerId', (req, res) => {
  res.json({success:true, portfolio: portfolios[req.params.photographerId] || {}});
});

// ── Photographer Directory ──
const photographers = [];

app.post('/register-photographer', async (req, res) => {
  try {
    const data = req.body;
    if(!data.name || !data.phone) return res.status(400).json({success:false,error:'Missing fields'});
    const id = `ph_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    const photographer = {...data, id, status:'pending', createdAt:new Date().toISOString()};
    photographers.push(photographer);
    console.log(`📸 New photographer registered: ${data.name} — ${data.city}`);
    // Notify admin via WhatsApp
    const msg = `📸 New Photographer Registration!\n\nName: ${data.name}\nStudio: ${data.studio}\nCity: ${data.city}\nPhone: +91${data.phone}\nSpecialties: ${(data.specialties||[]).join(', ')}\nPrice: ₹${data.startingPrice}`;
    console.log('WhatsApp notification:', msg);
    res.json({success:true, id, message:'Registration submitted successfully!'});
  } catch(err) {
    res.status(500).json({success:false, error:err.message});
  }
});

app.get('/photographers', (req, res) => {
  const approved = photographers.filter(p => p.status === 'approved');
  res.json({success:true, photographers:approved, total:approved.length});
});

app.get('/photographers/all', (req, res) => {
  res.json({success:true, photographers, total:photographers.length});
});

app.get('/photographer-by-phone/:phone', (req, res) => {
  const ph = photographers.find(p => p.phone === req.params.phone || p.whatsapp === req.params.phone);
  if(!ph) return res.status(404).json({success:false, error:'Not found'});
  res.json({success:true, photographer:{id:ph.id, name:ph.name, city:ph.city}});
});

app.post('/approve-photographer/:id', (req, res) => {
  const ph = photographers.find(p => p.id === req.params.id);
  if(!ph) return res.status(404).json({success:false, error:'Not found'});
  ph.status = 'approved';
  res.json({success:true, message:'Photographer approved!'});
});
const weddingWebsites = {};
const rsvpData = {};

app.post('/create-wedding-website', async (req, res) => {
  try {
    const data = req.body;
    if (!data.bride || !data.groom) return res.status(400).json({ success: false, error: 'Missing required fields' });
    const siteId = `${data.bride.toLowerCase().replace(/[^a-z0-9]/g,'-')}-${data.groom.toLowerCase().replace(/[^a-z0-9]/g,'-')}-${Date.now().toString(36)}`;
    weddingWebsites[siteId] = { ...data, createdAt: new Date().toISOString(), siteId };
    rsvpData[siteId] = [];
    console.log(`💒 Wedding website created: ${siteId}`);
    res.json({ success: true, siteId, url: `https://www.templecity.digital/wedding-website.html?id=${siteId}` });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/wedding-website/:siteId', (req, res) => {
  const data = weddingWebsites[req.params.siteId];
  if (!data) return res.status(404).json({ success: false, error: 'Website not found' });
  res.json({ success: true, data });
});

app.post('/submit-rsvp', async (req, res) => {
  try {
    const { siteId, name, phone, attending, persons, meal, message } = req.body;
    if (!rsvpData[siteId]) rsvpData[siteId] = [];
    rsvpData[siteId].push({ name, phone, attending, persons: parseInt(persons)||1, meal, message, submittedAt: new Date().toISOString() });
    console.log(`💌 RSVP for ${siteId}: ${name} — ${attending} (${persons} persons)`);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/rsvp-stats/:siteId', (req, res) => {
  try {
    const rsvps = rsvpData[req.params.siteId] || [];
    const attending = rsvps.filter(r => r.attending === 'yes');
    const persons = attending.reduce((sum, r) => sum + (parseInt(r.persons)||1), 0);
    const veg = attending.filter(r => r.meal === 'veg').length;
    const nonveg = attending.filter(r => r.meal === 'nonveg').length;
    res.json({ success: true, total: attending.length, persons, veg, nonveg, all: rsvps });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/rsvp-list/:siteId', (req, res) => {
  const rsvps = rsvpData[req.params.siteId] || [];
  res.json({ success: true, rsvps, total: rsvps.length });
});

app.post('/beautify', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No photo provided' });

    const { style = 'wedding', driveFileId } = req.body;
    let photoBuffer = req.file.buffer;

    console.log(`✨ Beautifying photo... style: ${style}`);

    // Enhanced beautification transforms
    const styleTransforms = {
      wedding: [
        { effect: 'improve:70' },
        { effect: 'sharpen:60' },
        { effect: 'saturation:15' },
        { effect: 'brightness:8' },
        { effect: 'contrast:10' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      glamour: [
        { effect: 'improve:80' },
        { effect: 'sharpen:70' },
        { effect: 'saturation:25' },
        { effect: 'brightness:12' },
        { effect: 'contrast:15' },
        { effect: 'vibrance:20' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      cinematic: [
        { effect: 'improve:60' },
        { effect: 'sharpen:50' },
        { effect: 'saturation:-10' },
        { effect: 'contrast:20' },
        { effect: 'brightness:5' },
        { color_space: 'srgb' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      vibrant: [
        { effect: 'improve:75' },
        { effect: 'vibrance:40' },
        { effect: 'saturation:30' },
        { effect: 'sharpen:50' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
      soft: [
        { effect: 'improve:60' },
        { effect: 'brightness:15' },
        { effect: 'saturation:10' },
        { effect: 'contrast:5' },
        { quality: 'auto:best' },
        { fetch_format: 'jpg' },
      ],
    };

    const transforms = styleTransforms[style] || styleTransforms.wedding;

    // Upload original to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'photofind-beautify', resource_type: 'image' },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(photoBuffer);
    });

    // Apply transforms
    const beautifiedUrl = cloudinary.url(uploadResult.public_id, { transformation: transforms });

    // Get original URL too
    const originalUrl = cloudinary.url(uploadResult.public_id, { transformation: [{ quality: 'auto', fetch_format: 'jpg' }] });

    // Cleanup after 1 hour
    setTimeout(() => {
      cloudinary.uploader.destroy(uploadResult.public_id).catch(() => {});
    }, 3600000);

    console.log(`✅ Beautification complete!`);
    res.json({
      success: true,
      originalUrl,
      beautifiedUrl,
      publicId: uploadResult.public_id,
    });

  } catch(err) {
    console.error('❌ Beautify error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Beautify from Drive URL ──
app.post('/beautify-url', async (req, res) => {
  try {
    const { driveUrl, style = 'wedding' } = req.body;
    if (!driveUrl) return res.status(400).json({ success: false, error: 'No URL provided' });

    const styleTransforms = {
      wedding: [{ effect: 'improve:70' },{ effect: 'sharpen:60' },{ effect: 'saturation:15' },{ effect: 'brightness:8' },{ quality: 'auto:best' },{ fetch_format: 'jpg' }],
      glamour: [{ effect: 'improve:80' },{ effect: 'sharpen:70' },{ effect: 'saturation:25' },{ effect: 'brightness:12' },{ effect: 'vibrance:20' },{ quality: 'auto:best' },{ fetch_format: 'jpg' }],
      cinematic: [{ effect: 'improve:60' },{ effect: 'saturation:-10' },{ effect: 'contrast:20' },{ quality: 'auto:best' },{ fetch_format: 'jpg' }],
      vibrant: [{ effect: 'improve:75' },{ effect: 'vibrance:40' },{ effect: 'saturation:30' },{ quality: 'auto:best' },{ fetch_format: 'jpg' }],
      soft: [{ effect: 'improve:60' },{ effect: 'brightness:15' },{ effect: 'saturation:10' },{ quality: 'auto:best' },{ fetch_format: 'jpg' }],
    };

    const transforms = styleTransforms[style] || styleTransforms.wedding;

    // Upload from URL to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(driveUrl, {
      folder: 'photofind-beautify',
      resource_type: 'image',
    });

    const beautifiedUrl = cloudinary.url(uploadResult.public_id, { transformation: transforms });
    const originalUrl = cloudinary.url(uploadResult.public_id, { transformation: [{ quality: 'auto', fetch_format: 'jpg' }] });

    setTimeout(() => cloudinary.uploader.destroy(uploadResult.public_id).catch(() => {}), 3600000);

    res.json({ success: true, originalUrl, beautifiedUrl, publicId: uploadResult.public_id });

  } catch(err) {
    console.error('❌ Beautify-URL error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post('/index-faces/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    console.log(`🔍 Starting face indexing for event: ${eventId}`);

    // Ensure collection exists
    const collectionId = await ensureCollection(eventId);

    // Get all photos from Drive
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.json({ success: false, error: 'Original folder not found' });
    }

    const photosRes = await drive.files.list({
      q: `'${subfolders.data.files[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name)', pageSize: 1000,
    });

    const photos = photosRes.data.files;
    console.log(`📸 Indexing ${photos.length} photos...`);

    let indexed = 0, failed = 0;

    // Index in batches of 10
    const batchSize = 10;
    for (let i = 0; i < photos.length; i += batchSize) {
      const batch = photos.slice(i, i + batchSize);
      await Promise.all(batch.map(async photo => {
        try {
          const stream = await drive.files.get(
            { fileId: photo.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          const buffer = Buffer.from(stream.data);
          const faces = await indexPhotoFaces(buffer, photo.name, eventId);
          if (faces > 0) indexed++;
          else failed++;
        } catch(e) {
          failed++;
        }
      }));
      console.log(`Progress: ${Math.min(i + batchSize, photos.length)}/${photos.length}`);
    }

    console.log(`✅ Indexing complete: ${indexed} indexed, ${failed} failed`);
    res.json({ success: true, total: photos.length, indexed, failed, collectionId });

  } catch(err) {
    console.error('❌ Index error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Check Index Status ──
app.get('/index-status/:eventId', async (req, res) => {
  try {
    const collectionId = getCollectionId(req.params.eventId);
    const faces = await rekognition.send(new ListFacesCommand({
      CollectionId: collectionId,
      MaxResults: 1,
    }));
    res.json({ success: true, indexed: true, faceCount: faces.Faces?.length || 0 });
  } catch(e) {
    res.json({ success: true, indexed: false, faceCount: 0 });
  }
});
app.get('/video/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    // Look for video folder
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='videos' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.json({ success: true, video: null, chapters: [] });
    }

    const videoFolderId = subfolders.data.files[0].id;

    // Get videos
    const videosRes = await drive.files.list({
      q: `'${videoFolderId}' in parents and mimeType contains 'video/' and trashed=false`,
      fields: 'files(id, name, webViewLink, thumbnailLink, videoMediaMetadata)',
      orderBy: 'createdTime desc',
    });

    // Get chapters JSON if exists
    const chaptersRes = await drive.files.list({
      q: `'${videoFolderId}' in parents and name='chapters.json' and trashed=false`,
      fields: 'files(id)',
    });

    let chapters = [];
    if (chaptersRes.data.files.length > 0) {
      try {
        const chFile = await drive.files.get({ fileId: chaptersRes.data.files[0].id, alt: 'media' }, { responseType: 'text' });
        chapters = JSON.parse(chFile.data);
      } catch(e) {}
    }

    const video = videosRes.data.files[0] || null;

    res.json({
      success: true,
      video: video ? {
        id: video.id,
        name: video.name,
        viewLink: `https://drive.google.com/file/d/${video.id}/preview`,
        downloadLink: video.webViewLink,
        thumbnail: video.thumbnailLink,
        duration: video.videoMediaMetadata?.durationMillis
          ? formatDuration(video.videoMediaMetadata.durationMillis)
          : null,
      } : null,
      chapters,
    });
  } catch(err) {
    console.error('❌ Video route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Upload Video ──
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!req.file || !eventId) return res.status(400).json({ success: false, error: 'Video and eventId required' });

    // Get or create videos folder
    const videoFolderId = await getOrCreateFolder(eventId, 'videos');

    // Upload video to Drive
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(req.file.buffer);
    stream.push(null);

    const driveFile = await drive.files.create({
      requestBody: {
        name: req.file.originalname || `video_${Date.now()}.mp4`,
        parents: [videoFolderId],
        mimeType: req.file.mimetype || 'video/mp4',
      },
      media: { mimeType: req.file.mimetype || 'video/mp4', body: stream },
      fields: 'id, name, webViewLink',
    });

    // Make public
    await drive.permissions.create({
      fileId: driveFile.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    console.log(`✅ Video uploaded: ${driveFile.data.name}`);
    res.json({ success: true, videoId: driveFile.data.id, name: driveFile.data.name });
  } catch(err) {
    console.error('❌ Video upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}
app.get('/photos/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.json({ success: true, photos: [], groupPhotos: [] });
    }

    const photosRes = await drive.files.list({
      q: `'${subfolders.data.files[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, thumbnailLink, webViewLink)', pageSize: 1000,
    });

    const photos = photosRes.data.files.map(f => ({
      id: f.id,
      name: f.name,
      thumbnailLink: f.thumbnailLink?.replace('=s220', '=s400') || '',
      viewLink: f.webViewLink,
    }));

    res.json({ success: true, photos, groupPhotos: [] });
  } catch(err) {
    console.error('❌ Photos error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/stats/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });
    let originalCount = 0, editedCount = 0;
    for (const folder of subfolders.data.files) {
      const photos = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'files(id)', pageSize: 1000,
      });
      if (folder.name === 'original') originalCount = photos.data.files.length;
      if (folder.name === 'edited') editedCount = photos.data.files.length;
    }
    res.json({ success: true, stats: { totalPhotos: originalCount, editedPhotos: editedCount, isSyncing: !!syncJobs[eventId] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/photos/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });
    if (!subfolders.data.files.length) return res.status(404).json({ success: false, error: 'No original folder' });
    const photos = await drive.files.list({
      q: `'${subfolders.data.files[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType, thumbnailLink, webViewLink)', pageSize: 1000,
    });
    res.json({ success: true, totalPhotos: photos.data.files.length, photos: photos.data.files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/create-event', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    const eventFolder = await createEventFolders(name);
    res.json({ success: true, eventId: eventFolder.id, name: eventFolder.name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!req.file || !eventId) return res.status(400).json({ success: false, error: 'Missing data' });

    const folderId = await getOrCreateFolder(eventId, 'original');

    // Check for duplicate filename
    const existing = await drive.files.list({
      q: `'${folderId}' in parents and name='${req.file.originalname}' and trashed=false`,
      fields: 'files(id)',
    });

    if (existing.data.files.length > 0) {
      return res.json({ success: true, skipped: true, fileName: req.file.originalname, reason: 'duplicate' });
    }

    const uploaded = await drive.files.create({
      requestBody: { name: req.file.originalname, mimeType: req.file.mimetype, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id, name, size',
    });

    // Get updated count
    const countRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id)',
      pageSize: 1000,
    });

    res.json({
      success: true,
      fileId: uploaded.data.id,
      fileName: uploaded.data.name,
      totalCount: countRes.data.files.length,
    });
  } catch (err) {
    console.error('❌ Upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── MAIN: Face Match + AI Edit + Reel ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;
    const pkg = req.body.package || 'basic';
    const pkgConfig = PACKAGES[pkg] || PACKAGES.basic;

    if (!req.file) return res.status(400).json({ success: false, error: 'No selfie' });

    const selfieBuffer = req.file.buffer;
    const selfieResized = await resizeForRekognition(selfieBuffer);

    // Detect face first
    const detectResult = await rekognition.send(new DetectFacesCommand({
      Image: { Bytes: selfieResized }, Attributes: ['DEFAULT'],
    }));

    if (!detectResult.FaceDetails?.length) {
      return res.status(400).json({ success: false, error: 'No face detected. Retake in good lighting.' });
    }

    // Get all photos from Drive
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'Original folder not found' });
    }

    const photosRes = await drive.files.list({
      q: `'${subfolders.data.files[0].id}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType, size)', pageSize: 1000,
    });

    const allPhotos = photosRes.data.files;
    console.log(`📸 Total photos: ${allPhotos.length}`);

    // Get event info
    const eventsRes = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });
    const eventFile = eventsRes.data.files.find(e => e.id === eventId);
    const eventType = detectEventType(eventFile?.name || '');
    const editedFolderId = await getOrCreateFolder(eventId, 'edited');

    // ── CHECK IF PRE-INDEXED ──
    const collectionId = getCollectionId(eventId);
    let useIndexed = false;

    try {
      const listResult = await rekognition.send(new ListFacesCommand({
        CollectionId: collectionId, MaxResults: 1,
      }));
      useIndexed = (listResult.Faces?.length || 0) > 0;
    } catch(e) {
      useIndexed = false;
    }

    let soloMatches = [];
    let groupMatches = [];

    if (useIndexed) {
      // ── FAST PATH: Pre-indexed search (1-2 seconds!) ──
      console.log(`⚡ Using pre-indexed collection: ${collectionId}`);

      // Solo matches (70%)
      const soloResults = await searchFacesByImage(selfieBuffer, collectionId, 70);
      console.log(`✅ Found ${soloResults.length} solo matches (indexed)`);

      for (const match of soloResults) {
        const photoName = match.Face.ExternalImageId?.replace(/_/g, ' ') || '';
        const photo = allPhotos.find(p =>
          p.name.replace(/[^a-zA-Z0-9_.\-:]/g, '_').substring(0, 255) === match.Face.ExternalImageId ||
          p.name === photoName
        );
        if (photo) {
          soloMatches.push({ photo, similarity: match.Similarity });
        }
      }

      // Group matches (50%) if enabled
      if (pkgConfig.groupPhotos) {
        const groupResults = await searchFacesByImage(selfieBuffer, collectionId, 50);
        for (const match of groupResults) {
          if (match.Similarity >= 50 && match.Similarity < 70) {
            const photo = allPhotos.find(p =>
              p.name.replace(/[^a-zA-Z0-9_.\-:]/g, '_').substring(0, 255) === match.Face.ExternalImageId
            );
            if (photo && !soloMatches.find(m => m.photo.id === photo.id)) {
              groupMatches.push({ photo, similarity: match.Similarity });
            }
          }
        }
      }

    } else {
      // ── SLOW PATH: Original comparison (fallback) ──
      console.log(`⏳ Collection not indexed yet — using comparison method`);
      console.log(`💡 Tip: Run /index-faces/${eventId} to speed up future scans!`);

      const batchSize = 10; // Increased from 5 to 10

      for (let i = 0; i < allPhotos.length; i += batchSize) {
        const batch = allPhotos.slice(i, i + batchSize);
        await Promise.all(batch.map(async (photo) => {
          try {
            const photoStream = await drive.files.get(
              { fileId: photo.id, alt: 'media' },
              { responseType: 'arraybuffer' }
            );
            const photoBuffer = Buffer.from(photoStream.data);
            const photoResized = await resizeForRekognition(photoBuffer);
            const selfieRes = await resizeForRekognition(selfieBuffer);

            const compareResult = await rekognition.send(new CompareFacesCommand({
              SourceImage: { Bytes: selfieRes },
              TargetImage: { Bytes: photoResized },
              SimilarityThreshold: 50,
            }));

            if (compareResult.FaceMatches?.length > 0) {
              const similarity = compareResult.FaceMatches[0].Similarity;
              if (similarity >= 70) {
                soloMatches.push({ photo, photoBuffer, similarity });
              } else if (pkgConfig.groupPhotos && similarity >= 50) {
                groupMatches.push({ photo, photoBuffer, similarity });
              }
            }
          } catch(e) {
            if (e.name !== 'InvalidParameterException') {
              console.error(`❌ ${photo.name}:`, e.message);
            }
          }
        }));
        console.log(`Progress: ${Math.min(i + batchSize, allPhotos.length)}/${allPhotos.length}`);
      }
    }

    // ── Duplicate Detection ──
    function removeDuplicates(matches) {
      const seen = new Set();
      return matches.filter(match => {
        const key = `${match.photo.name.replace(/\d+/g, '').substring(0, 10)}_${Math.round((match.photo.size||0)/50000)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const uniqueSolo = removeDuplicates(soloMatches);
    const uniqueGroup = removeDuplicates(groupMatches);
    console.log(`✅ After dedup: ${uniqueSolo.length} solo, ${uniqueGroup.length} group`);

    // ── Process Photos ──
    const matchedPhotos = [];
    const matchedBuffers = [];

    for (const { photo, photoBuffer, similarity } of uniqueSolo) {
      let buf = photoBuffer;
      if (!buf) {
        // For indexed path — download photo
        try {
          const stream = await drive.files.get(
            { fileId: photo.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          buf = Buffer.from(stream.data);
        } catch(e) { continue; }
      }

      let finalPhoto;
      if (pkgConfig.aiEdit) {
        const { buffer: editedBuf, edited } = await editPhotoWithCloudinary(buf, eventType);
        if (edited) {
          finalPhoto = await uploadBufferToDrive(editedBuf, `edited_${photo.name}`, editedFolderId);
          matchedBuffers.push(editedBuf);
        } else {
          finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
          matchedBuffers.push(buf);
        }
      } else {
        finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
        matchedBuffers.push(buf);
      }

      matchedPhotos.push({
        ...finalPhoto,
        similarity: typeof similarity === 'number' ? similarity.toFixed(1) : similarity,
        aiEdited: pkgConfig.aiEdit,
        type: 'solo',
      });
    }

    // Group photos
    const groupPhotos = [];
    for (const { photo, photoBuffer, similarity } of uniqueGroup) {
      const finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
      groupPhotos.push({
        ...finalPhoto,
        similarity: typeof similarity === 'number' ? similarity.toFixed(1) : similarity,
        type: 'group',
      });
    }

    console.log(`🎉 Done — ${matchedPhotos.length} solo + ${groupPhotos.length} group | Method: ${useIndexed ? '⚡ Indexed' : '⏳ Comparison'}`);

    // ── Reel ──
    let reelLink = null;
    if (pkgConfig.reel && matchedBuffers.length >= 3) {
      try {
        const bgmUrl = await getBGMForEvent(eventType);
        const eName = eventFile?.name?.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/-/g, ' ').split('__')[0] || 'Your Event';
        const reelBuffer = await createReel(matchedBuffers, eName, eventType, bgmUrl);
        const reelFolderId = await getOrCreateFolder(eventId, 'reels');
        const reelFile = await uploadBufferToDrive(reelBuffer, `reel_${Date.now()}.mp4`, reelFolderId, 'video/mp4');
        reelLink = reelFile.viewLink;
      } catch(e) {
        console.error('⚠️ Reel failed:', e.message);
      }
    }

    res.json({
      success: true,
      totalScanned: allPhotos.length,
      matchedCount: matchedPhotos.length,
      groupCount: groupPhotos.length,
      photos: matchedPhotos,
      groupPhotos,
      aiEdited: pkgConfig.aiEdit,
      reelLink,
      reelEligible: pkgConfig.reel && matchedBuffers.length >= 3,
      package: pkg,
      packageConfig: pkgConfig,
      method: useIndexed ? 'indexed' : 'comparison',
    });

  } catch (err) {
    console.error('❌ Match error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║   PhotoFind Pro Server Running                    ║
  ║   http://localhost:${PORT}                           ║
  ║   Cloudinary AI + FFmpeg Reel + Razorpay + AWS   ║
  ╚═══════════════════════════════════════════════════╝
  `);
});
