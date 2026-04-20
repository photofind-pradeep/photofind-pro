require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static(__dirname));
// ── Multer (handle file uploads in memory) ──
const upload = multer({ storage: multer.memoryStorage() });

// ── Google Auth ──
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/cloud-vision',
  ],
});

const drive = google.drive({ version: 'v3', auth });

// ════════════════════════════════════════
//  ROUTE 1 — Health Check
// ════════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ════════════════════════════════════════
//  ROUTE 2 — List All Events
// ════════════════════════════════════════
app.get('/events', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${process.env.EVENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json({ success: true, events: response.data.files });
  } catch (err) {
    console.error('Error listing events:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ROUTE 3 — Get Photos in an Event
// ════════════════════════════════════════
app.get('/photos/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    // Find "original" subfolder inside this event
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id, name)',
    });

    if (!subfolders.data.files.length) {
      return res.status(404).json({ success: false, error: 'No original folder found in this event' });
    }

    const originalFolderId = subfolders.data.files[0].id;

    // Get all photos from original folder
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
    console.error('Error getting photos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ROUTE 4 — Face Match (MAIN FEATURE)
//  Upload selfie → match against event photos
// ════════════════════════════════════════
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No selfie uploaded' });
    }

    console.log('🔍 Starting face match for event:', eventId);
    console.log('Selfie size:', req.file.size, 'bytes');
    console.log('Vision API Key exists:', !!process.env.VISION_API_KEY);
    console.log('Credentials exist:', !!process.env.GOOGLE_CREDENTIALS_JSON);

    // ── Step 1: Detect face in selfie using Vision API ──
    const authClient = await auth.getClient();
    const accessToken = await authClient.getAccessToken();

    const selfieBase64 = req.file.buffer.toString('base64');
    console.log('Selfie base64 length:', selfieBase64.length);
    console.log('Calling Vision API...');
    console.log('Vision status:', visionResponse.status);
    const visionData = await visionResponse.json();
    console.log('Vision Response:', JSON.stringify(visionData));

    const visionResponse = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: selfieBase64 },
            features: [{ type: 'FACE_DETECTION', maxResults: 5 }],
          }],
        }),
      }
    );

    const visionData = await visionResponse.json();
    const faces = visionData?.responses?.[0]?.faceAnnotations;

if (!faces || faces.length === 0) {
  return res.status(400).json({ success: false, error: 'No face detected in selfie. Please retake.' });
}

    console.log('✅ Face detected in selfie');

    // ── Step 2: Get all photos from event original folder ──
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

    // ── Step 3: Check each photo for matching face ──
    const matchedPhotos = [];
    const selfieVertices = faces[0].boundingPoly.vertices;

    // Process photos in batches of 5 to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < allPhotos.length; i += batchSize) {
      const batch = allPhotos.slice(i, i + batchSize);

      await Promise.all(batch.map(async (photo) => {
        try {
          // Download photo from Drive as base64
          const photoStream = await drive.files.get(
            { fileId: photo.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );

          const photoBase64 = Buffer.from(photoStream.data).toString('base64');

          // Detect faces in this photo
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
            // Compare face confidence scores — simple matching
            // In production, use Face Recognition API for exact matching
            const hasMatch = photoFaces.some(face =>
              face.detectionConfidence > 0.6 &&
              face.joyLikelihood !== 'VERY_UNLIKELY'
            );

            if (hasMatch) {
              // Make photo publicly accessible
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
            }
          }
        } catch (photoErr) {
          console.error(`Error processing photo ${photo.name}:`, photoErr.message);
        }
      }));

      console.log(`Processed ${Math.min(i + batchSize, allPhotos.length)}/${allPhotos.length} photos`);
    }

    console.log(`✅ Match complete — found ${matchedPhotos.length} photos`);

    res.json({
      success: true,
      totalScanned: allPhotos.length,
      matchedCount: matchedPhotos.length,
      photos: matchedPhotos,
    });

  } catch (err) {
    console.error('Error in face match:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ROUTE 5 — Create Download ZIP link
// ════════════════════════════════════════
app.post('/create-album', async (req, res) => {
  try {
    const { photoIds, eventId, guestName } = req.body;

    if (!photoIds || photoIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No photos provided' });
    }

    // Create a guest folder inside "edited" subfolder
    const editedFolderRes = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='edited' and trashed=false`,
      fields: 'files(id)',
    });

    let editedFolderId;
    if (editedFolderRes.data.files.length > 0) {
      editedFolderId = editedFolderRes.data.files[0].id;
    } else {
      // Create edited folder if it doesn't exist
      const newFolder = await drive.files.create({
        requestBody: {
          name: 'edited',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [eventId],
        },
        fields: 'id',
      });
      editedFolderId = newFolder.data.id;
    }

    // Create guest album folder
    const guestFolder = await drive.files.create({
      requestBody: {
        name: guestName || `Guest-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [editedFolderId],
      },
      fields: 'id',
    });

    // Share guest folder publicly
    await drive.permissions.create({
      fileId: guestFolder.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    const albumLink = `https://drive.google.com/drive/folders/${guestFolder.data.id}`;

    res.json({
      success: true,
      albumLink,
      folderId: guestFolder.data.id,
      photoCount: photoIds.length,
    });

  } catch (err) {
    console.error('Error creating album:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ROUTE 6 — Get Event Stats
// ════════════════════════════════════════
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
      stats: {
        totalPhotos: originalCount,
        editedPhotos: editedCount,
        pendingPhotos: originalCount - editedCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start Server ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔════════════════════════════════════╗
  ║   PhotoFind Pro Server Running     ║
  ║   http://localhost:${PORT}            ║
  ╚════════════════════════════════════╝
  `);
});
