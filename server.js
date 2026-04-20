require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

// ── Google Auth ──
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/cloud-vision',
      ],
    });
    console.log('✅ Auth: Using GOOGLE_CREDENTIALS_JSON');
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: './service-account.json',
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/cloud-vision',
      ],
    });
    console.log('✅ Auth: Using service-account.json file');
  }
} catch (e) {
  console.error('❌ Auth setup failed:', e.message);
}

const drive = google.drive({ version: 'v3', auth });

// ── ROUTE 1: Home ──
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ── ROUTE 2: Health Check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'PhotoFind Pro server is running ✅',
    hasCredentials: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasVisionKey: !!process.env.VISION_API_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
  });
});

// ── ROUTE 3: List Events ──
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

// ── ROUTE 4: Get Photos ──
app.get('/photos/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id, name)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'No original folder found' });
    }

    const originalFolderId = subfolders.data.files[0].id;
    const photos = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType, thumbnailLink, webViewLink)',
      pageSize: 1000,
    });

    res.json({
      success: true,
      totalPhotos: photos.data.files.length,
      originalFolderId,
      photos: photos.data.files,
    });
  } catch (err) {
    console.error('❌ Photos error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROUTE 5: Stats ──
app.get('/stats/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });

    let originalCount = 0;
    let editedCount = 0;

    for (const folder of subfolders.data.files) {
      const photos = await drive.files.list({
        q: `'${folder.id}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'files(id)',
        pageSize: 1000,
      });
      if (folder.name === 'original') originalCount = photos.data.files.length;
      if (folder.name === 'edited') editedCount = photos.data.files.length;
    }

    res.json({
      success: true,
      stats: { totalPhotos: originalCount, editedPhotos: editedCount, pendingPhotos: originalCount - editedCount },
    });
  } catch (err) {
    console.error('❌ Stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROUTE 6: Face Match ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No selfie uploaded' });
    }

    console.log('🔍 Face match started for event:', eventId);
    console.log('📸 Selfie size:', req.file.size, 'bytes');
    console.log('🔑 Vision API Key:', process.env.VISION_API_KEY ? 'Present ✅' : 'MISSING ❌');
    console.log('🔑 Credentials:', process.env.GOOGLE_CREDENTIALS_JSON ? 'Present ✅' : 'MISSING ❌');

    const selfieBase64 = req.file.buffer.toString('base64');

    // ── Step 1: Detect face in selfie ──
    console.log('📡 Calling Vision API for selfie...');

    let visionRes, visionData;
    try {
      visionRes = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${process.env.VISION_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{
              image: { content: selfieBase64 },
              features: [{ type: 'FACE_DETECTION', maxResults: 10 }],
            }],
          }),
        }
      );

      visionData = await visionRes.json();
      console.log('Vision API HTTP status:', visionRes.status);
      console.log('Vision API response:', JSON.stringify(visionData).substring(0, 300));
    } catch (vErr) {
      console.error('❌ Vision API fetch failed:', vErr.message);
      return res.status(500).json({ success: false, error: 'Vision API failed: ' + vErr.message });
    }

    if (visionData.error) {
      console.error('❌ Vision API error:', visionData.error.message);
      return res.status(400).json({ success: false, error: 'Vision API: ' + visionData.error.message });
    }

    const faces = visionData?.responses?.[0]?.faceAnnotations;
    console.log('👤 Faces in selfie:', faces ? faces.length : 0);

    if (!faces || faces.length === 0) {
      return res.status(400).json({ success: false, error: 'No face detected. Please retake in good lighting.' });
    }

    // ── Step 2: Get photos ──
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

    // ── Step 3: Match face ──
    const matchedPhotos = [];

    for (let i = 0; i < allPhotos.length; i++) {
      const photo = allPhotos[i];
      try {
        const photoStream = await drive.files.get(
          { fileId: photo.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );

        const photoBase64 = Buffer.from(photoStream.data).toString('base64');

        const photoVisionRes = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${process.env.VISION_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [{
                image: { content: photoBase64 },
                features: [{ type: 'FACE_DETECTION', maxResults: 10 }],
              }],
            }),
          }
        );

        const photoVisionData = await photoVisionRes.json();
        const photoFaces = photoVisionData?.responses?.[0]?.faceAnnotations;

        if (photoFaces && photoFaces.length > 0) {
          const hasMatch = photoFaces.some(f => f.detectionConfidence > 0.6);
          if (hasMatch) {
            await drive.permissions.create({
              fileId: photo.id,
              requestBody: { role: 'reader', type: 'anyone' },
            });

            matchedPhotos.push({
              id: photo.id,
              name: photo.name,
              viewLink: `https://drive.google.com/file/d/${photo.id}/view`,
              downloadLink: `https://drive.google.com/uc?export=download&id=${photo.id}`,
              thumbnailLink: `https://drive.google.com/thumbnail?id=${photo.id}&sz=w400`,
            });
            console.log(`✅ Match: ${photo.name}`);
          }
        }
        console.log(`Progress: ${i + 1}/${allPhotos.length}`);
      } catch (e) {
        console.error(`❌ Photo error ${photo.name}:`, e.message);
      }
    }

    console.log(`🎉 Done — ${matchedPhotos.length} matches found`);
    res.json({
      success: true,
      totalScanned: allPhotos.length,
      matchedCount: matchedPhotos.length,
      photos: matchedPhotos,
    });

  } catch (err) {
    console.error('❌ Match route error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔════════════════════════════════════╗
  ║   PhotoFind Pro Server Running     ║
  ║   http://localhost:${PORT}            ║
  ╚════════════════════════════════════╝
  `);
});
