require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { RekognitionClient, CompareFacesCommand, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
 
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(__dirname));
 
const upload = multer({ storage: multer.memoryStorage() });
 
// ── AWS Rekognition Client ──
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
 
// ── ROUTE 1: Home ──
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
 
// ── ROUTE 2: Health Check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'PhotoFind Pro server is running ✅',
    hasGoogleCredentials: !!process.env.GOOGLE_CREDENTIALS_JSON,
    hasAWSKey: !!process.env.AWS_ACCESS_KEY_ID,
    hasAWSSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
    hasEventFolder: !!process.env.EVENT_FOLDER_ID,
    awsRegion: process.env.AWS_REGION || 'ap-south-1',
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
 
// ── ROUTE 4: Stats ──
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
    console.error('❌ Stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
 
// ── ROUTE 5: Face Match using AWS Rekognition ──
app.post('/match/:eventId', upload.single('selfie'), async (req, res) => {
  try {
    const { eventId } = req.params;
 
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No selfie uploaded' });
    }
 
    console.log('🔍 Face match started for event:', eventId);
    console.log('📸 Selfie size:', req.file.size, 'bytes');
    console.log('🔑 AWS Key:', process.env.AWS_ACCESS_KEY_ID ? 'Present ✅' : 'MISSING ❌');
 
    const selfieBuffer = req.file.buffer;
 
    // ── Step 1: Detect face in selfie using AWS Rekognition ──
    console.log('🧠 Detecting face in selfie with AWS Rekognition...');
 
    try {
      const detectCommand = new DetectFacesCommand({
        Image: { Bytes: selfieBuffer },
        Attributes: ['DEFAULT'],
      });
 
      const detectResult = await rekognition.send(detectCommand);
      console.log('👤 Faces detected in selfie:', detectResult.FaceDetails.length);
 
      if (!detectResult.FaceDetails || detectResult.FaceDetails.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No face detected in selfie. Please retake in good lighting.',
        });
      }
    } catch (awsErr) {
      console.error('❌ AWS Rekognition error:', awsErr.message);
      return res.status(500).json({ success: false, error: 'AWS error: ' + awsErr.message });
    }
 
    // ── Step 2: Get all photos from Google Drive ──
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
    console.log(`📸 Total photos to scan: ${allPhotos.length}`);
 
    // ── Step 3: Compare selfie with each photo using Rekognition ──
    const matchedPhotos = [];
 
    for (let i = 0; i < allPhotos.length; i++) {
      const photo = allPhotos[i];
      try {
        // Download photo from Google Drive
        const photoStream = await drive.files.get(
          { fileId: photo.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
 
        const photoBuffer = Buffer.from(photoStream.data);
 
        // Compare faces using AWS Rekognition
        const compareCommand = new CompareFacesCommand({
          SourceImage: { Bytes: selfieBuffer },
          TargetImage: { Bytes: photoBuffer },
          SimilarityThreshold: 70, // 70% similarity = match
        });
 
        const compareResult = await rekognition.send(compareCommand);
 
        if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0) {
          const similarity = compareResult.FaceMatches[0].Similarity;
          console.log(`✅ Match found: ${photo.name} — ${similarity.toFixed(1)}% similar`);
 
          // Make photo publicly accessible
          await drive.permissions.create({
            fileId: photo.id,
            requestBody: { role: 'reader', type: 'anyone' },
          });
 
          matchedPhotos.push({
            id: photo.id,
            name: photo.name,
            similarity: similarity.toFixed(1),
            viewLink: `https://drive.google.com/file/d/${photo.id}/view`,
            downloadLink: `https://drive.google.com/uc?export=download&id=${photo.id}`,
            thumbnailLink: `https://drive.google.com/thumbnail?id=${photo.id}&sz=w400`,
          });
        } else {
          console.log(`❌ No match: ${photo.name}`);
        }
 
        console.log(`Progress: ${i + 1}/${allPhotos.length}`);
 
      } catch (photoErr) {
        // UnmatchedFaces error is normal — means no face in that photo
        if (photoErr.name === 'InvalidParameterException') {
          console.log(`⚠️ No face in photo: ${photo.name}`);
        } else {
          console.error(`❌ Error processing ${photo.name}:`, photoErr.message);
        }
      }
    }
 
    console.log(`🎉 Match complete — ${matchedPhotos.length}/${allPhotos.length} photos matched`);
 
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
 
// ── Start Server ──
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔════════════════════════════════════╗
  ║   PhotoFind Pro Server Running     ║
  ║   http://localhost:${PORT}            ║
  ║   Powered by AWS Rekognition 🧠    ║
  ╚════════════════════════════════════╝
  `);
});
