require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { RekognitionClient, CompareFacesCommand, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

// ── AWS Rekognition ──
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Google Auth ──
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log('✅ Google Auth: Using GOOGLE_CREDENTIALS_JSON');
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: './service-account.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log('✅ Google Auth: Using service-account.json');
  }
} catch (e) {
  console.error('❌ Google Auth failed:', e.message);
}

const drive = google.drive({ version: 'v3', auth });

// ════════════════════════════════════════
//  AI PHOTO EDITING with Stability AI
// ════════════════════════════════════════
async function editPhotoWithAI(imageBuffer) {
  try {
    console.log('🎨 Starting AI edit...');

    // Step 1 — Pre-process with Sharp (brightness + contrast)
    const preprocessed = await sharp(imageBuffer)
      .modulate({
        brightness: 1.08,   // slight brightness boost
        saturation: 1.15,   // richer colors
      })
      .sharpen({ sigma: 0.8 }) // slight sharpening
      .toBuffer();

    console.log('✅ Sharp preprocessing done');

    // Step 2 — Stability AI for cinematic enhancement
    const stabilityKey = process.env.STABILITY_API_KEY;
    if (!stabilityKey) {
      console.log('⚠️ No Stability API key — returning sharp-enhanced photo');
      return preprocessed;
    }

    // Convert to base64 for Stability AI
    const base64Image = preprocessed.toString('base64');

    // Call Stability AI Image-to-Image API
    const response = await axios.post(
      'https://api.stability.ai/v2beta/stable-image/edit/enhance',
      {
        image: base64Image,
        prompt: 'professional wedding photo, cinematic lighting, skin smoothing, warm tones, elegant, high quality',
        negative_prompt: 'blurry, dark, noisy, overexposed, underexposed',
        output_format: 'jpeg',
        strength: 0.25, // subtle enhancement — keeps original look
      },
      {
        headers: {
          Authorization: `Bearer ${stabilityKey}`,
          'Content-Type': 'application/json',
          Accept: 'image/*',
        },
        responseType: 'arraybuffer',
        timeout: 60000,
      }
    );

    console.log('✅ Stability AI edit complete');
    return Buffer.from(response.data);

  } catch (err) {
    console.error('⚠️ AI edit error (using sharp fallback):', err.message);
    // Fallback — return sharp-processed image
    try {
      const fallback = await sharp(imageBuffer)
        .modulate({ brightness: 1.08, saturation: 1.15 })
        .sharpen({ sigma: 0.8 })
        .toBuffer();
      return fallback;
    } catch (sharpErr) {
      console.error('Sharp fallback failed:', sharpErr.message);
      return imageBuffer; // return original if all fails
    }
  }
}

// ── Upload edited photo to Google Drive ──
async function uploadEditedPhoto(photoBuffer, fileName, editedFolderId) {
  try {
    const { Readable } = require('stream');
    const stream = Readable.from(photoBuffer);

    const response = await drive.files.create({
      requestBody: {
        name: `edited_${fileName}`,
        mimeType: 'image/jpeg',
        parents: [editedFolderId],
      },
      media: {
        mimeType: 'image/jpeg',
        body: stream,
      },
      fields: 'id, name',
    });

    // Make it publicly accessible
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    return {
      id: response.data.id,
      name: response.data.name,
      viewLink: `https://drive.google.com/file/d/${response.data.id}/view`,
      downloadLink: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
      thumbnailLink: `https://drive.google.com/thumbnail?id=${response.data.id}&sz=w400`,
    };
  } catch (err) {
    console.error('❌ Upload error:', err.message);
    throw err;
  }
}

// ── Get or Create edited folder ──
async function getEditedFolder(eventId) {
  const existing = await drive.files.list({
    q: `'${eventId}' in parents and name='edited' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });

  if (existing.data.files.length > 0) return existing.data.files[0].id;

  const newFolder = await drive.files.create({
    requestBody: {
      name: 'edited',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [eventId],
    },
    fields: 'id',
  });

  return newFolder.data.id;
}

// ════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════

// ── Home ──
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ── Health Check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'PhotoFind Pro server is running ✅',
    hasGoogleCredentials: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasAWSKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasAWSSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasStabilityAI: !!process.env.STABILITY_API_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    awsRegion: process.env.AWS_REGION || 'ap-south-1',
  });
});

// ── List Events ──
app.get('/events', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json({ success: true, events: response.data.files });
  } catch (err) {
    console.error('❌ Events error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Stats ──
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

    res.json({
      success: true,
      stats: { totalPhotos: originalCount, editedPhotos: editedCount, pendingPhotos: originalCount - editedCount },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Face Match + AI Edit (MAIN ROUTE) ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No selfie uploaded' });
    }

    console.log('🔍 Face match + AI edit started for event:', eventId);
    console.log('📸 Selfie size:', req.file.size, 'bytes');

    const selfieBuffer = req.file.buffer;

    // ── Step 1: Detect face in selfie ──
    const detectCommand = new DetectFacesCommand({
      Image: { Bytes: selfieBuffer },
      Attributes: ['DEFAULT'],
    });

    const detectResult = await rekognition.send(detectCommand);
    console.log('👤 Faces in selfie:', detectResult.FaceDetails.length);

    if (!detectResult.FaceDetails || detectResult.FaceDetails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No face detected. Please retake in good lighting.',
      });
    }

    // ── Step 2: Get photos from Drive ──
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id, name)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'Event original folder not found' });
    }

    const originalFolderId = subfolders.data.files[0].id;
    const photosResponse = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
    });

    const allPhotos = photosResponse.data.files;
    console.log(`📸 Scanning ${allPhotos.length} photos...`);

    // ── Step 3: Get edited folder ──
    const editedFolderId = await getEditedFolder(eventId);

    // ── Step 4: Match + Edit each photo ──
    const matchedPhotos = [];

    for (let i = 0; i < allPhotos.length; i++) {
      const photo = allPhotos[i];
      try {
        // Download from Drive
        const photoStream = await drive.files.get(
          { fileId: photo.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const photoBuffer = Buffer.from(photoStream.data);

        // Compare faces
        const compareCommand = new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: photoBuffer },
          SimilarityThreshold: 70,
        });

        const compareResult = await rekognition.send(compareCommand);

        if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
          const similarity = compareResult.FaceMatches[0].Similarity;
          console.log(`✅ Match: ${photo.name} — ${similarity.toFixed(1)}% similar`);

          // AI Edit the photo
          console.log(`🎨 AI editing: ${photo.name}`);
          const editedBuffer = await editPhotoWithAI(photoBuffer);

          // Upload edited photo to Drive
          const editedPhoto = await uploadEditedPhoto(editedBuffer, photo.name, editedFolderId);

          matchedPhotos.push({
            id: editedPhoto.id,
            originalId: photo.id,
            name: editedPhoto.name,
            similarity: similarity.toFixed(1),
            viewLink: editedPhoto.viewLink,
            downloadLink: editedPhoto.downloadLink,
            thumbnailLink: editedPhoto.thumbnailLink,
          });
        }

        console.log(`Progress: ${i + 1}/${allPhotos.length}`);
      } catch (photoErr) {
        if (photoErr.name === 'InvalidParameterException') {
          console.log(`⚠️ No face in: ${photo.name}`);
        } else {
          console.error(`❌ Error: ${photo.name}:`, photoErr.message);
        }
      }
    }

    console.log(`🎉 Done — ${matchedPhotos.length} photos matched & edited`);

    res.json({
      success: true,
      totalScanned: allPhotos.length,
      matchedCount: matchedPhotos.length,
      photos: matchedPhotos,
      aiEdited: true,
    });

  } catch (err) {
    console.error('❌ Match route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start Server ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   PhotoFind Pro Server Running           ║
  ║   http://localhost:${PORT}                  ║
  ║   AWS Rekognition + Stability AI 🧠🎨   ║
  ╚══════════════════════════════════════════╝
  `);
});
