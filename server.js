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
const Razorpay = require('razorpay');
const crypto = require('crypto');

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

// ── Razorpay ──
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

// ── OAuth2 for Google Photos ──
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://www.templecity.digital/auth/callback'
);

let photographerTokens = null;
const syncJobs = {};

// ── In-memory client database (use real DB later) ──
let clients = [];

// ════════════════════════════════════════
//  HELPER FUNCTIONS
// ════════════════════════════════════════

function generateOrderId() {
  return 'TC' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function makePublicAndGetLinks(fileId, fileName) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch(e) {}
  return {
    id: fileId, name: fileName,
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
    id: response.data.id, name: response.data.name,
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

// ── Admin Auth Middleware ──
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === process.env.ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
}

// ── Google Photos Sync ──
async function syncGooglePhotosToEvent(eventId, eventDate, tokens) {
  try {
    oauth2Client.setCredentials(tokens);
    const photosApi = google.photoslibrary({ version: 'v1', auth: oauth2Client });

    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and name='original' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) return { synced: 0, error: 'No original folder' };

    const originalFolderId = subfolders.data.files[0].id;
    const existingPhotos = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name)', pageSize: 1000,
    });

    const existingNames = new Set(existingPhotos.data.files.map(f => f.name));

    const dateParts = eventDate.split('-');
    const photosResponse = await photosApi.mediaItems.search({
      requestBody: {
        filters: { dateFilter: { dates: [{ year: parseInt(dateParts[0]), month: parseInt(dateParts[1]), day: parseInt(dateParts[2]) }] } },
        pageSize: 100,
      },
    });

    const mediaItems = photosResponse.data.mediaItems || [];
    let synced = 0;

    for (const item of mediaItems) {
      if (existingNames.has(item.filename)) continue;
      try {
        const imageResponse = await fetch(`${item.baseUrl}=d`);
        if (!imageResponse.ok) continue;
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const stream = Readable.from(imageBuffer);
        await drive.files.create({
          requestBody: { name: item.filename, mimeType: item.mimeType || 'image/jpeg', parents: [originalFolderId] },
          media: { mimeType: item.mimeType || 'image/jpeg', body: stream },
          fields: 'id',
        });
        synced++;
        existingNames.add(item.filename);
      } catch (err) {
        console.error(`❌ Error syncing ${item.filename}:`, err.message);
      }
    }

    return { synced, total: mediaItems.length };
  } catch (err) {
    return { synced: 0, error: err.message };
  }
}

function startAutoSync(eventId, eventDate, tokens) {
  if (syncJobs[eventId]) clearInterval(syncJobs[eventId]);
  syncGooglePhotosToEvent(eventId, eventDate, tokens);
  syncJobs[eventId] = setInterval(async () => {
    await syncGooglePhotosToEvent(eventId, eventDate, tokens);
  }, 2 * 60 * 1000);
  console.log(`🔄 Auto sync started: ${eventId}`);
}

function stopAutoSync(eventId) {
  if (syncJobs[eventId]) {
    clearInterval(syncJobs[eventId]);
    delete syncJobs[eventId];
  }
}

// ════════════════════════════════════════
//  ROUTES — PAGES
// ════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({
    status: 'PhotoFind Pro server is running ✅',
    hasGoogleCredentials: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasAWSKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasAWSSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasStabilityAI: !!process.env.STABILITY_API_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    hasOAuth: !!process.env.GOOGLE_CLIENT_ID,
    hasRazorpay: !!process.env.RAZORPAY_KEY_ID,
    photographerConnected: !!photographerTokens,
    activeSyncJobs: Object.keys(syncJobs).length,
    totalClients: clients.length,
    awsRegion: process.env.AWS_REGION || 'ap-south-1',
  });
});

// ════════════════════════════════════════
//  PAYMENT ROUTES
// ════════════════════════════════════════

// Create Razorpay Order
app.post('/payment/create-order', async (req, res) => {
  try {
    const { eventName, eventDate, studioName, phone, package: pkg } = req.body;

    if (!eventName || !eventDate || !studioName || !phone) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    const amount = pkg === 'standard' ? 499900 : pkg === 'premium' ? 799900 : 299900; // in paise

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: generateOrderId(),
      notes: { eventName, eventDate, studioName, phone },
    });

    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('❌ Payment order error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify Payment & Create Event
app.post('/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, eventName, eventDate, studioName, phone, amount } = req.body;

    // Verify signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign).digest('hex');

    if (expectedSign !== razorpay_signature) {
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    console.log(`✅ Payment verified: ${razorpay_payment_id}`);

    // Create event folder in Drive
    const studioSuffix = studioName ? `__${studioName.replace(/\s+/g, '-')}__${phone}` : '';
    const folderName = `${eventDate}_${eventName.replace(/\s+/g, '-').replace(/&/g, 'and')}${studioSuffix}`;
    const eventFolder = await createEventFolders(folderName);

    // Generate links
    const baseUrl = 'https://www.templecity.digital';
    const uploadLink = `${baseUrl}/upload.html?event=${eventFolder.id}`;
    const guestLink = `${baseUrl}?event=${eventFolder.id}`;
    const whatsappMsg = `📸 *PhotoFind Pro — Setup Complete!*\n\n*Event:* ${eventName}\n*Date:* ${eventDate}\n*Studio:* ${studioName}\n\n*📤 Upload Photos:*\n${uploadLink}\n\n*🎊 Guest QR Link:*\n${guestLink}\n\n*Instructions:*\n1️⃣ Upload photos via upload link\n2️⃣ Share guest QR link or print QR card\n3️⃣ Guests scan → find their photos instantly!\n\n_Powered by Temple City Digital_\n🌐 www.templecity.digital`;
    const waLink = `https://wa.me/91${phone}?text=${encodeURIComponent(whatsappMsg)}`;

    // Save client
    const client = {
      id: eventFolder.id,
      eventName,
      eventDate,
      studioName,
      phone,
      amount: amount / 100,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      uploadLink,
      guestLink,
      createdAt: new Date().toISOString(),
      status: 'active',
      photoCount: 0,
    };
    clients.push(client);

    console.log(`✅ Event created: ${folderName} (${eventFolder.id})`);

    res.json({
      success: true,
      eventId: eventFolder.id,
      eventName,
      studioName,
      uploadLink,
      guestLink,
      waLink,
      whatsappMsg,
    });
  } catch (err) {
    console.error('❌ Payment verify error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════

// Admin Login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Get All Clients
app.get('/admin/clients', adminAuth, async (req, res) => {
  try {
    // Update photo counts from Drive
    for (const client of clients) {
      try {
        const statsRes = await fetch(`http://localhost:${process.env.PORT || 8080}/stats/${client.id}`);
        const statsData = await statsRes.json();
        client.photoCount = statsData.stats?.totalPhotos || 0;
        client.isSyncing = !!syncJobs[client.id];
      } catch(e) {}
    }

    // Also get events from Drive not in clients list
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

// Delete Event
app.delete('/admin/event/:eventId', adminAuth, async (req, res) => {
  try {
    const { eventId } = req.params;

    // Stop sync if running
    stopAutoSync(eventId);

    // Move to trash in Drive
    await drive.files.update({
      fileId: eventId,
      requestBody: { trashed: true },
    });

    // Remove from clients
    clients = clients.filter(c => c.id !== eventId);

    console.log(`🗑️ Event deleted: ${eventId}`);
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Client Status
app.put('/admin/client/:eventId', adminAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { status } = req.body;
    const client = clients.find(c => c.id === eventId);
    if (client) {
      client.status = status;
      res.json({ success: true, client });
    } else {
      res.status(404).json({ success: false, error: 'Client not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Dashboard Stats
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalRevenue = clients.reduce((sum, c) => sum + (c.amount || 0), 0);
    const activeEvents = clients.filter(c => c.status === 'active').length;
    const syncingEvents = Object.keys(syncJobs).length;

    res.json({
      success: true,
      stats: {
        totalClients: clients.length,
        totalRevenue,
        activeEvents,
        syncingEvents,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  GOOGLE OAUTH ROUTES
// ════════════════════════════════════════

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
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#07080A;color:white">
        <h2 style="color:#E8C07A">✅ Google Photos Connected!</h2>
        <p>Your Google account is now connected.</p>
        <a href="/dashboard.html" style="background:#E8C07A;color:#07080A;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Go to Dashboard →</a>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ connected: !!photographerTokens, activeSyncs: Object.keys(syncJobs).length });
});

// ════════════════════════════════════════
//  SYNC ROUTES
// ════════════════════════════════════════

app.post('/sync/start', async (req, res) => {
  try {
    const { eventId, eventDate } = req.body;
    if (!photographerTokens) return res.status(401).json({ success: false, error: 'Not authenticated', authUrl: '/auth/google' });
    startAutoSync(eventId, eventDate, photographerTokens);
    res.json({ success: true, message: 'Live sync started', syncInterval: '2 minutes' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/sync/stop', (req, res) => {
  stopAutoSync(req.body.eventId);
  res.json({ success: true, message: 'Sync stopped' });
});

app.post('/sync/now', async (req, res) => {
  try {
    const { eventId, eventDate } = req.body;
    if (!photographerTokens) return res.status(401).json({ success: false, error: 'Not authenticated', authUrl: '/auth/google' });
    const result = await syncGooglePhotosToEvent(eventId, eventDate, photographerTokens);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/sync/status/:eventId', (req, res) => {
  res.json({ success: true, isActive: !!syncJobs[req.params.eventId] });
});

// ════════════════════════════════════════
//  EVENT ROUTES
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
    res.json({ success: true, stats: { totalPhotos: originalCount, editedPhotos: editedCount, pendingPhotos: originalCount - editedCount, isSyncing: !!syncJobs[eventId] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/photos/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id, name)',
    });
    if (!subfolders.data.files.length) return res.status(404).json({ success: false, error: 'No original folder found' });
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

    res.json({ success: true, fileId: uploaded.data.id, fileName: uploaded.data.name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════
//  FACE MATCH ROUTE
// ════════════════════════════════════════

app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;
    if (!req.file) return res.status(400).json({ success: false, error: 'No selfie uploaded' });

    const selfieBuffer = req.file.buffer;
    const detectResult = await rekognition.send(new DetectFacesCommand({
      Image: { Bytes: selfieBuffer }, Attributes: ['DEFAULT'],
    }));

    if (!detectResult.FaceDetails?.length) {
      return res.status(400).json({ success: false, error: 'No face detected. Please retake in good lighting.' });
    }

    const subfolders = await drive.files.list({
      q: `'${eventId}' in parents and mimeType='application/vnd.google-apps.folder' and name='original' and trashed=false`,
      fields: 'files(id)',
    });

    if (!subfolders.data.files.length) return res.status(404).json({ success: false, error: 'Original folder not found' });

    const originalFolderId = subfolders.data.files[0].id;
    const photosRes = await drive.files.list({
      q: `'${originalFolderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id, name, mimeType)', pageSize: 1000,
    });

    const allPhotos = photosRes.data.files;
    const editedFolderId = await getOrCreateEditedFolder(eventId);
    const matchedPhotos = [];
    const batchSize = 5;

    for (let i = 0; i < allPhotos.length; i += batchSize) {
      const batch = allPhotos.slice(i, i + batchSize);
      await Promise.all(batch.map(async (photo) => {
        try {
          const photoStream = await drive.files.get({ fileId: photo.id, alt: 'media' }, { responseType: 'arraybuffer' });
          const photoBuffer = Buffer.from(photoStream.data);
          const compareResult = await rekognition.send(new CompareFacesCommand({
            SourceImage: { Bytes: selfieBuffer },
            TargetImage: { Bytes: photoBuffer },
            SimilarityThreshold: 70,
          }));

          if (compareResult.FaceMatches?.length > 0) {
            const similarity = compareResult.FaceMatches[0].Similarity;
            const finalPhoto = await makePublicAndGetLinks(photo.id, photo.name);
            matchedPhotos.push({ ...finalPhoto, similarity: similarity.toFixed(1) });
          }
        } catch (photoErr) {
          if (photoErr.name !== 'InvalidParameterException') {
            console.error(`❌ ${photo.name}:`, photoErr.message);
          }
        }
      }));
      console.log(`Progress: ${Math.min(i + batchSize, allPhotos.length)}/${allPhotos.length}`);
    }

    res.json({ success: true, totalScanned: allPhotos.length, matchedCount: matchedPhotos.length, photos: matchedPhotos });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   PhotoFind Pro Server Running               ║
  ║   http://localhost:${PORT}                      ║
  ║   Razorpay + Admin + Sync + AWS + Drive     ║
  ╚══════════════════════════════════════════════╝
  `);
});
