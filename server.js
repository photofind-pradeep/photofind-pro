require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const {
  RekognitionClient,
  CompareFacesCommand,
  DetectFacesCommand,
} = require('@aws-sdk/client-rekognition');

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
    console.log('✅ Google Auth: GOOGLE_CREDENTIALS_JSON');
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: './service-account.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log('✅ Google Auth: service-account.json');
  }
} catch (e) {
  console.error('❌ Google Auth failed:', e.message);
}

const drive = google.drive({ version: 'v3', auth });

// ════════════════════════════════════════
//  AI PHOTO EDIT — Stability AI
//  Uses only built-in fetch, no extra packages
// ════════════════════════════════════════
async function editPhotoWithStabilityAI(imageBuffer) {
  const stabilityKey = process.env.STABILITY_API_KEY;

  if (!stabilityKey) {
    console.log('⚠️ No Stability AI key — returning original');
    return { buffer: imageBuffer, edited: false };
  }

  try {
    console.log('🎨 Calling Stability AI...');

    // Convert image to base64
    const base64Image = imageBuffer.toString('base64');

    // Call Stability AI enhance API
    const response = await fetch(
      'https://api.stability.ai/v2beta/stable-image/edit/enhance',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stabilityKey}`,
          'Content-Type': 'application/json',
          'Accept': 'image/*',
        },
        body: JSON.stringify({
          image: base64Image,
          prompt: 'professional wedding photography, cinematic warm lighting, smooth skin, vibrant colors, sharp details, high quality',
          negative_prompt: 'blurry, grainy, dark, overexposed, ugly, low quality',
          output_format: 'jpeg',
          strength: 0.3,
        }),
      }
    );

    console.log('Stability AI status:', response.status);

    if (!response.ok) {
      const errText = await response.text();
      console.error('❌ Stability AI error:', errText);
      return { buffer: imageBuffer, edited: false };
    }

    const editedArrayBuffer = await response.arrayBuffer();
    const editedBuffer = Buffer.from(editedArrayBuffer);
    console.log('✅ Stability AI edit complete — size:', editedBuffer.length);
    return { buffer: editedBuffer, edited: true };

  } catch (err) {
    console.error('⚠️ Stability AI failed:', err.message);
    return { buffer: imageBuffer, edited: false };
  }
}

// ── Upload photo buffer to Google Drive ──
async function uploadToDrive(buffer, fileName, folderId) {
  const stream = Readable.from(buffer);
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'image/jpeg',
      parents: [folderId],
    },
    media: { mimeType: 'image/jpeg', body: stream },
    fields: 'id, name',
  });

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
}

// ── Get or create edited folder ──
async function getOrCreateEditedFolder(eventId) {
  const existing = await drive.files.list({
    q: `'${eventId}' in parents and name='edited' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (existing.data.files.length > 0) return existing.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name: 'edited',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [eventId],
    },
    fields: 'id',
  });
  return folder.data.id;
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
    hasAWSSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasStabilityAI: !!process.env.STABILITY_API_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    awsRegion: process.env.AWS_REGION || 'ap-south-1',
  });
});

app.get('/events', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json({ success: true, events: response.data.files });
  } catch (err) {
    console.error('❌ Events:', err.message);
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
    res.json({ success: true, stats: { totalPhotos: originalCount, editedPhotos: editedCount } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── MAIN: Face Match + AI Edit ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No selfie uploaded' });
    }

    console.log('🔍 Starting face match for event:', eventId);
    console.log('📸 Selfie:', req.file.size, 'bytes');

    const selfieBuffer = req.file.buffer;

    // ── Detect face in selfie ──
    const detectResult = await rekognition.send(new DetectFacesCommand({
      Image: { Bytes: selfieBuffer },
      Attributes: ['DEFAULT'],
    }));

    console.log('👤 Faces detected:', detectResult.FaceDetails.length);

    if (!detectResult.FaceDetails || detectResult.FaceDetails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No face detected. Please retake in good lighting.',
      });
    }

    // ── Get event photos ──
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id, name)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'Original folder not found' });
    }

    const originalFolderId = subfolders.data.files[0].id;
    const photosRes = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
    });

    const allPhotos = photosRes.data.files;
    console.log(`📸 Total photos: ${allPhotos.length}`);

    // ── Get edited folder ──
    const editedFolderId = await getOrCreateEditedFolder(eventId);

    // ── Match + Edit each photo ──
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
        const compareResult = await rekognition.send(new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: photoBuffer },
          SimilarityThreshold: 70,
        }));

        if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
          const similarity = compareResult.FaceMatches[0].Similarity;
          console.log(`✅ Match: ${photo.name} — ${similarity.toFixed(1)}%`);

          // AI Edit
          const { buffer: editedBuffer, edited } = await editPhotoWithStabilityAI(photoBuffer);
          console.log(`🎨 AI edit: ${edited ? 'Success' : 'Skipped (original used)'}`);

          // Upload to edited folder
          const fileName = edited ? `edited_${photo.name}` : photo.name;
          let uploadedPhoto;

          if (edited) {
            uploadedPhoto = await uploadToDrive(editedBuffer, fileName, editedFolderId);
          } else {
            // Just share original
            await drive.permissions.create({
              fileId: photo.id,
              requestBody: { role: 'reader', type: 'anyone' },
            });
            uploadedPhoto = {
              id: photo.id,
              name: photo.name,
              viewLink: `https://drive.google.com/file/d/${photo.id}/view`,
              downloadLink: `https://drive.google.com/uc?export=download&id=${photo.id}`,
              thumbnailLink: `https://drive.google.com/thumbnail?id=${photo.id}&sz=w400`,
            };
          }

          matchedPhotos.push({
            ...uploadedPhoto,
            similarity: similarity.toFixed(1),
            aiEdited: edited,
          });
        }

        console.log(`Progress: ${i + 1}/${allPhotos.length}`);

      } catch (photoErr) {
        if (photoErr.name === 'InvalidParameterException') {
          console.log(`⚠️ No face in: ${photo.name}`);
        } else {
          console.error(`❌ Error ${photo.name}:`, photoErr.message);
        }
      }
    }

    console.log(`🎉 Complete — ${matchedPhotos.length} photos matched & edited`);

    res.json({
      success: true,
      totalScanned: allPhotos.length,
      matchedCount: matchedPhotos.length,
      photos: matchedPhotos,
      aiEdited: matchedPhotos.some(p => p.aiEdited),
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
  ╔══════════════════════════════════════════╗
  ║   PhotoFind Pro Server Running           ║
  ║   http://localhost:${PORT}                  ║
  ║   AWS Rekognition + Stability AI 🧠🎨   ║
  ╚══════════════════════════════════════════╝
  `);
});
