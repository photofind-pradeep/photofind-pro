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

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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

// ── Google Auth (Service Account) ──
let auth;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log('✅ Google Auth: Service Account');
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

// ── OAuth2 Client (for Google Photos) ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://www.templecity.digital/auth/callback'
);

// Store tokens in memory (in production use a database)
let photographerTokens = null;

// ── Active sync jobs ──
const syncJobs = {};

// ════════════════════════════════════════
//  HELPER FUNCTIONS
// ════════════════════════════════════════

async function makePublicAndGetLinks(fileId, fileName) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch(e) {}
  return {
    id: fileId,
    name: fileName,
    viewLink: `https://drive.google.com/file/d/${fileId}/view`,
    downloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
    thumbnailLink: `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`,
  };
}

async function uploadToDrive(buffer, fileName, folderId) {
  const stream = Readable.from(buffer);
  const response = await drive.files.create({
    requestBody: { name: fileName, mimeType: 'image/jpeg', parents: [folderId] },
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

async function getOrCreateEditedFolder(eventId) {
  const existing = await drive.files.list({
    q: `'${eventId}' in parents and name='edited' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
  });
  if (existing.data.files.length > 0) return existing.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: 'edited', mimeType: 'application/vnd.google-apps.folder', parents: [eventId] },
    fields: 'id',
  });
  return folder.data.id;
}

async function editPhotoWithStabilityAI(imageBuffer) {
  const stabilityKey = process.env.STABILITY_API_KEY;
  if (!stabilityKey) return { buffer: imageBuffer, edited: false };
  try {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    parts.push(imageBuffer);
    parts.push('\r\n');
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nimage-to-image\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nprofessional wedding photo, cinematic warm lighting, smooth skin, vibrant colors\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsd3-turbo\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="strength"\r\n\r\n0.3\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="output_format"\r\n\r\njpeg\r\n`);
    parts.push(`--${boundary}--\r\n`);
    const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));
    const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/sd3', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Accept': 'image/*' },
      body,
    });
    if (!response.ok) return { buffer: imageBuffer, edited: false };
    return { buffer: Buffer.from(await response.arrayBuffer()), edited: true };
  } catch (err) {
    return { buffer: imageBuffer, edited: false };
  }
}

// ════════════════════════════════════════
//  GOOGLE PHOTOS SYNC
// ════════════════════════════════════════

// Sync photos from Google Photos to Drive event folder
async function syncGooglePhotosToEvent(eventId, eventDate, tokens) {
  try {
    oauth2Client.setCredentials(tokens);
    const photosApi = google.photoslibrary({ version: 'v1', auth: oauth2Client });

    // Get original folder ID for this event
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) {
      console.log('❌ No original folder found for event:', eventId);
      return { synced: 0, error: 'No original folder found' };
    }

    const originalFolderId = subfolders.data.files[0].id;

    // Get existing photos in Drive to avoid duplicates
    const existingPhotos = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name)',
      pageSize: 1000,
    });

    const existingNames = new Set(existingPhotos.data.files.map(f => f.name));
    console.log(`📁 Existing photos in Drive: ${existingNames.size}`);

    // Search Google Photos for photos from event date
    const dateFilter = {
      dateFilter: {
        dates: [{
          year: parseInt(eventDate.split('-')[0]),
          month: parseInt(eventDate.split('-')[1]),
          day: parseInt(eventDate.split('-')[2]),
        }],
      },
    };

    const photosResponse = await photosApi.mediaItems.search({
      requestBody: {
        filters: dateFilter,
        pageSize: 100,
      },
    });

    const mediaItems = photosResponse.data.mediaItems || [];
    console.log(`📸 Found ${mediaItems.length} photos in Google Photos for ${eventDate}`);

    let synced = 0;

    for (const item of mediaItems) {
      // Skip if already in Drive
      if (existingNames.has(item.filename)) {
        console.log(`⏭️ Already synced: ${item.filename}`);
        continue;
      }

      try {
        // Download from Google Photos
        const imageUrl = `${item.baseUrl}=d`;
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) continue;

        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // Upload to Drive original folder
        const stream = Readable.from(imageBuffer);
        await drive.files.create({
          requestBody: {
            name: item.filename,
            mimeType: item.mimeType || 'image/jpeg',
            parents: [originalFolderId],
          },
          media: { mimeType: item.mimeType || 'image/jpeg', body: stream },
          fields: 'id',
        });

        synced++;
        existingNames.add(item.filename);
        console.log(`✅ Synced: ${item.filename} (${synced} total)`);
      } catch (err) {
        console.error(`❌ Error syncing ${item.filename}:`, err.message);
      }
    }

    return { synced, total: mediaItems.length };
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    return { synced: 0, error: err.message };
  }
}

// Auto sync every 2 minutes for active events
function startAutoSync(eventId, eventDate, tokens) {
  // Clear existing job if any
  if (syncJobs[eventId]) {
    clearInterval(syncJobs[eventId]);
  }

  console.log(`🔄 Auto sync started for event: ${eventId}`);

  // Sync immediately
  syncGooglePhotosToEvent(eventId, eventDate, tokens);

  // Then every 2 minutes
  syncJobs[eventId] = setInterval(async () => {
    console.log(`🔄 Auto syncing event: ${eventId}`);
    const result = await syncGooglePhotosToEvent(eventId, eventDate, tokens);
    console.log(`✅ Sync result: ${result.synced} new photos`);
  }, 2 * 60 * 1000); // 2 minutes
}

function stopAutoSync(eventId) {
  if (syncJobs[eventId]) {
    clearInterval(syncJobs[eventId]);
    delete syncJobs[eventId];
    console.log(`⏹️ Auto sync stopped for event: ${eventId}`);
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
    hasAWSSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasStabilityAI: !!process.env.STABILITY_API_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    hasOAuth: !!process.env.GOOGLE_CLIENT_ID,
    photographerConnected: !!photographerTokens,
    activeSyncJobs: Object.keys(syncJobs).length,
    awsRegion: process.env.AWS_REGION || 'ap-south-1',
  });
});

// ── Google OAuth Routes ──

// Step 1: Redirect photographer to Google login
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/photoslibrary.readonly',
      'https://www.googleapis.com/auth/drive',
    ],
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    photographerTokens = tokens;
    oauth2Client.setCredentials(tokens);
    console.log('✅ Photographer Google account connected!');
    res.send(`
      <html>
      <body style="font-family:sans-serif;text-align:center;padding:50px;background:#07080A;color:white">
        <h2 style="color:#E8C07A">✅ Google Photos Connected!</h2>
        <p>Your Google account is now connected to PhotoFind Pro.</p>
        <p>You can now sync live photos from your camera!</p>
        <a href="/dashboard.html" style="background:#E8C07A;color:#07080A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
          Go to Dashboard →
        </a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ OAuth error:', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// Check if photographer is connected
app.get('/auth/status', (req, res) => {
  res.json({
    connected: !!photographerTokens,
    activeSyncs: Object.keys(syncJobs).length,
  });
});

// ── Start Live Sync for Event ──
app.post('/sync/start', async (req, res) => {
  try {
    const { eventId, eventDate } = req.body;

    if (!eventId || !eventDate) {
      return res.status(400).json({ success: false, error: 'Event ID and date required' });
    }

    if (!photographerTokens) {
      return res.status(401).json({
        success: false,
        error: 'Photographer not authenticated',
        authUrl: '/auth/google'
      });
    }

    startAutoSync(eventId, eventDate, photographerTokens);

    res.json({
      success: true,
      message: `Live sync started for event ${eventId}`,
      syncInterval: '2 minutes',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Stop Live Sync ──
app.post('/sync/stop', (req, res) => {
  const { eventId } = req.body;
  stopAutoSync(eventId);
  res.json({ success: true, message: 'Sync stopped' });
});

// ── Manual Sync Now ──
app.post('/sync/now', async (req, res) => {
  try {
    const { eventId, eventDate } = req.body;

    if (!photographerTokens) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated',
        authUrl: '/auth/google'
      });
    }

    const result = await syncGooglePhotosToEvent(eventId, eventDate, photographerTokens);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get Sync Status ──
app.get('/sync/status/:eventId', (req, res) => {
  const { eventId } = req.params;
  res.json({
    success: true,
    isActive: !!syncJobs[eventId],
    eventId,
  });
});

// ── Events ──
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
    res.json({ success: true, stats: { totalPhotos: originalCount, editedPhotos: editedCount, pendingPhotos: originalCount - editedCount, isSyncing: !!syncJobs[eventId] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Photos ──
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
    res.json({ success: true, totalPhotos: photos.data.files.length, originalFolderId, photos: photos.data.files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create Event ──
app.post('/create-event', async (req, res) => {
  try {
    const { name, displayName, date } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });

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

    console.log(`✅ Event created: ${name} (${eventFolder.data.id})`);
    res.json({ success: true, eventId: eventFolder.data.id, name: eventFolder.data.name });
  } catch (err) {
    console.error('❌ Create event error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Upload Photo ──
app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!req.file) return res.status(400).json({ success: false, error: 'No photo' });
    if (!eventId) return res.status(400).json({ success: false, error: 'No event ID' });

    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    let folderId;
    if (subfolders.data.files.length > 0) {
      folderId = subfolders.data.files[0].id;
    } else {
      const f = await drive.files.create({
        requestBody: { name: 'original', mimeType: 'application/vnd.google-apps.folder', parents: [eventId] },
        fields: 'id',
      });
      folderId = f.data.id;
    }

    const uploaded = await drive.files.create({
      requestBody: { name: req.file.originalname, mimeType: req.file.mimetype, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id, name',
    });

    console.log(`✅ Uploaded: ${uploaded.data.name}`);
    res.json({ success: true, fileId: uploaded.data.id, fileName: uploaded.data.name });
  } catch (err) {
    console.error('❌ Upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Face Match ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!req.file) return res.status(400).json({ success: false, error: 'No selfie uploaded' });

    console.log('🔍 Face match started:', eventId);
    const selfieBuffer = req.file.buffer;

    const detectResult = await rekognition.send(new DetectFacesCommand({
      Image: { Bytes: selfieBuffer },
      Attributes: ['DEFAULT'],
    }));

    if (!detectResult.FaceDetails || detectResult.FaceDetails.length === 0) {
      return res.status(400).json({ success: false, error: 'No face detected. Please retake in good lighting.' });
    }

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
    console.log(`📸 Scanning ${allPhotos.length} photos...`);

    const editedFolderId = await getOrCreateEditedFolder(eventId);
    const matchedPhotos = [];
    const batchSize = 5;

    for (let i = 0; i < allPhotos.length; i += batchSize) {
      const batch = allPhotos.slice(i, i + batchSize);

      await Promise.all(batch.map(async (photo) => {
        try {
          const photoStream = await drive.files.get(
            { fileId: photo.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          const photoBuffer = Buffer.from(photoStream.data);

          const compareResult = await rekognition.send(new CompareFacesCommand({
            SourceImage: { Bytes: selfieBuffer },
            TargetImage: { Bytes: photoBuffer },
            SimilarityThreshold: 70,
          }));

          if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
            const similarity = compareResult.FaceMatches[0].Similarity;
            console.log(`✅ Match: ${photo.name} — ${similarity.toFixed(1)}%`);

            const { buffer: editedBuffer, edited } = await editPhotoWithStabilityAI(photoBuffer);
            let finalPhoto;

            if (edited) {
              finalPhoto = await uploadToDrive(editedBuffer, `edited_${photo.name}`, editedFolderId);
            } else {
              finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
            }

            matchedPhotos.push({ ...finalPhoto, similarity: similarity.toFixed(1), aiEdited: edited });
          }
        } catch (photoErr) {
          if (photoErr.name !== 'InvalidParameterException') {
            console.error(`❌ Error ${photo.name}:`, photoErr.message);
          }
        }
      }));

      console.log(`Progress: ${Math.min(i + batchSize, allPhotos.length)}/${allPhotos.length}`);
    }

    console.log(`🎉 Done — ${matchedPhotos.length} photos matched`);
    res.json({ success: true, totalScanned: allPhotos.length, matchedCount: matchedPhotos.length, photos: matchedPhotos });

  } catch (err) {
    console.error('❌ Match error:', err.message);
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
  ║   AWS Rekognition + Google Photos Sync  ║
  ╚══════════════════════════════════════════╝
  `);
});
