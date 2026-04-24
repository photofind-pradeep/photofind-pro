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
// ════════════════════════════════════════
async function editPhotoWithStabilityAI(imageBuffer) {
  const stabilityKey = process.env.STABILITY_API_KEY;
  if (!stabilityKey) {
    console.log('⚠️ No Stability AI key');
    return { buffer: imageBuffer, edited: false };
  }

  try {
    console.log('🎨 Calling Stability AI...');

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const parts = [];

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="photo.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    );
    parts.push(imageBuffer);
    parts.push('\r\n');

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="mode"\r\n\r\n` +
      `image-to-image\r\n`
    );

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
      `professional wedding photo, cinematic warm lighting, smooth skin, vibrant colors, sharp details, high quality photograph\r\n`
    );

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `sd3-turbo\r\n`
    );

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="strength"\r\n\r\n` +
      `0.3\r\n`
    );

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="output_format"\r\n\r\n` +
      `jpeg\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    const body = Buffer.concat(parts.map(p =>
      typeof p === 'string' ? Buffer.from(p) : p
    ));

    const response = await fetch(
      'https://api.stability.ai/v2beta/stable-image/generate/sd3',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stabilityKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Accept': 'image/*',
        },
        body,
      }
    );

    console.log('Stability AI status:', response.status);

    if (!response.ok) {
      const errText = await response.text();
      console.error('❌ Stability AI error:', errText);
      return { buffer: imageBuffer, edited: false };
    }

    const editedBuffer = Buffer.from(await response.arrayBuffer());
    console.log('✅ Stability AI edit complete — size:', editedBuffer.length);
    return { buffer: editedBuffer, edited: true };

  } catch (err) {
    console.error('⚠️ Stability AI failed:', err.message);
    return { buffer: imageBuffer, edited: false };
  }
}

// ── Upload to Google Drive ──
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

// ── Make file public and return links ──
async function makePublicAndGetLinks(fileId, fileName) {
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return {
    id: fileId,
    name: fileName,
    viewLink: `https://drive.google.com/file/d/${fileId}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
    thumbnailLink: `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
  };
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
    console.error('❌ Events error:', err.message);
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

// ── ROUTE: Create New Event ──
app.post('/create-event', async (req, res) => {
  try {
    const { name, date, clientName, venue } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Event name required' });

    const eventFolderName = `${date || new Date().toISOString().slice(0,10)}_${name}`;

    // Create event folder inside Events folder
    const eventFolder = await drive.files.create({
      requestBody: {
        name: eventFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.EVENT_FOLDER_ID],
      },
      fields: 'id, name',
    });

    // Create original subfolder
    await drive.files.create({
      requestBody: {
        name: 'original',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [eventFolder.data.id],
      },
    });

    // Create edited subfolder
    await drive.files.create({
      requestBody: {
        name: 'edited',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [eventFolder.data.id],
      },
    });

    console.log(`✅ Event created: ${eventFolderName}`);
    res.json({ success: true, eventId: eventFolder.data.id, name: eventFolderName });

  } catch (err) {
    console.error('❌ Create event error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROUTE: Upload Photo to Event ──
const uploadPhoto = multer({ storage: multer.memoryStorage() });
app.post('/upload-photo', uploadPhoto.single('photo'), async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });
    if (!eventId) return res.status(400).json({ success: false, error: 'No event ID provided' });

    // Find original folder
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    let originalFolderId;
    if (subfolders.data.files.length > 0) {
      originalFolderId = subfolders.data.files[0].id;
    } else {
      // Create original folder if missing
      const folder = await drive.files.create({
        requestBody: {
          name: 'original',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [eventId],
        },
        fields: 'id',
      });
      originalFolderId = folder.data.id;
    }

    // Upload photo
    const stream = Readable.from(req.file.buffer);
    const uploaded = await drive.files.create({
      requestBody: {
        name: req.file.originalname || `photo_${Date.now()}.jpg`,
        mimeType: req.file.mimetype || 'image/jpeg',
        parents: [originalFolderId],
      },
      media: { mimeType: req.file.mimetype || 'image/jpeg', body: stream },
      fields: 'id, name',
    });

    console.log(`📸 Photo uploaded: ${uploaded.data.name}`);
    res.json({ success: true, fileId: uploaded.data.id, name: uploaded.data.name });

  } catch (err) {
    console.error('❌ Upload error:', err.message);
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

    console.log('🔍 Face match started:', eventId);
    console.log('📸 Selfie size:', req.file.size, 'bytes');

    const selfieBuffer = req.file.buffer;

    // ── Step 1: Detect face in selfie ──
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

    // ── Step 2: Get ALL subfolders (original + edited) ──
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });

    let originalFolderId = null;
    for (const folder of subfolders.data.files) {
      if (folder.name === 'original') originalFolderId = folder.id;
    }

    if (!originalFolderId) {
      return res.status(404).json({ success: false, error: 'Original folder not found' });
    }

    // ── Step 3: Get all photos from original folder ──
    const photosRes = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 1000,
    });

    const allPhotos = photosRes.data.files;
    console.log(`📸 Total photos to scan: ${allPhotos.length}`);

    if (allPhotos.length === 0) {
      return res.status(404).json({ success: false, error: 'No photos found in event folder' });
    }

    // ── Step 4: Get edited folder ──
    const editedFolderId = await getOrCreateEditedFolder(eventId);

    // ── Step 5: Match face in each photo ──
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

        // Compare faces with AWS Rekognition
        const compareResult = await rekognition.send(new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: photoBuffer },
          SimilarityThreshold: 70,
        }));

        if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
          const similarity = compareResult.FaceMatches[0].Similarity;
          console.log(`✅ Match: ${photo.name} — ${similarity.toFixed(1)}%`);

          // ── AI Edit with Stability AI ──
          const { buffer: editedBuffer, edited } = await editPhotoWithStabilityAI(photoBuffer);

          let finalPhoto;
          if (edited) {
            // Upload AI edited photo to edited folder
            finalPhoto = await uploadToDrive(
              editedBuffer,
              `edited_${photo.name}`,
              editedFolderId
            );
            console.log(`🎨 AI edited photo saved: edited_${photo.name}`);
          } else {
            // Use original photo — just make it public
            finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
            console.log(`📷 Using original photo: ${photo.name}`);
          }

          matchedPhotos.push({
            ...finalPhoto,
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

    console.log(`🎉 Done — ${matchedPhotos.length}/${allPhotos.length} matched`);
    console.log(`🎨 AI edited: ${matchedPhotos.filter(p => p.aiEdited).length} photos`);

    if (matchedPhotos.length === 0) {
      return res.json({
        success: true,
        totalScanned: allPhotos.length,
        matchedCount: 0,
        photos: [],
        message: 'No matching photos found. Try retaking selfie in better lighting.',
      });
    }

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

// ── ROUTE: Create Event Folder ──
app.post('/create-event', async (req, res) => {
  try {
    const { name, displayName, date } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Event name required' });

    // Create event folder inside Events folder
    const eventFolder = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.EVENT_FOLDER_ID],
      },
      fields: 'id, name',
    });

    // Create original subfolder
    await drive.files.create({
      requestBody: {
        name: 'original',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [eventFolder.data.id],
      },
      fields: 'id',
    });

    // Create edited subfolder
    await drive.files.create({
      requestBody: {
        name: 'edited',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [eventFolder.data.id],
      },
      fields: 'id',
    });

    console.log(`✅ Event created: ${name} (${eventFolder.data.id})`);

    res.json({
      success: true,
      eventId: eventFolder.data.id,
      name: eventFolder.data.name,
    });
  } catch (err) {
    console.error('❌ Create event error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROUTE: Upload Photo to Event ──
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });
    if (!eventId) return res.status(400).json({ success: false, error: 'Event ID required' });

    console.log(`📸 Uploading: ${req.file.originalname} to event: ${eventId}`);

    // Find original folder
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    let originalFolderId;
    if (subfolders.data.files.length > 0) {
      originalFolderId = subfolders.data.files[0].id;
    } else {
      // Create original folder if missing
      const newFolder = await drive.files.create({
        requestBody: {
          name: 'original',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [eventId],
        },
        fields: 'id',
      });
      originalFolderId = newFolder.data.id;
    }

    // Upload photo to original folder
    const { Readable } = require('stream');
    const stream = Readable.from(req.file.buffer);

    const uploaded = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        parents: [originalFolderId],
      },
      media: {
        mimeType: req.file.mimetype,
        body: stream,
      },
      fields: 'id, name',
    });

    console.log(`✅ Uploaded: ${uploaded.data.name}`);

    res.json({
      success: true,
      fileId: uploaded.data.id,
      fileName: uploaded.data.name,
    });
  } catch (err) {
    console.error('❌ Upload error:', err.message);
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
