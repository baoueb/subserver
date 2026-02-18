const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const slugify = require('slugify');
const { Storage } = require('@google-cloud/storage');

// --- Google Cloud credentials setup ---
if (process.env.GCS_KEY_JSON) {
  const tmpFile = path.join(os.tmpdir(), 'gcs-key.json');
  fs.writeFileSync(tmpFile, process.env.GCS_KEY_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
}

// Initialize GCS client
const storage = new Storage();
const bucketName = 'subserver-subtitles';  // <-- REPLACE WITH YOUR BUCKET NAME
const bucket = storage.bucket(bucketName);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Configure multer for file uploads (store in memory)
const upload = multer({ storage: multer.memoryStorage() });

// Helper to sanitise folder names
function sanitise(str) {
  return slugify(str, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
}

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { title, season } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });

    const safeTitle = sanitise(title);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    let episode = null;

    if (file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.srt')) {
          const episodeName = path.basename(entry.name);
          // Build GCS destination path
          let destPath = `shows/${safeTitle}`;
          if (season) destPath += `/season-${sanitise(String(season))}`;
          destPath += `/${episodeName}`;

          const blob = bucket.file(destPath);
          await blob.save(entry.getData(), {
            contentType: 'text/plain',
            public: true,   // makes the file publicly readable
          });
        }
      }
      // episode stays null for zip uploads
    } else if (file.originalname.toLowerCase().endsWith('.srt')) {
      episode = req.body.episode;
      if (!episode) {
        return res.status(400).json({ error: 'Episode number required for single .srt file' });
      }
      // Build GCS destination path
      let destPath = `shows/${safeTitle}`;
      if (season) destPath += `/season-${sanitise(String(season))}`;
      destPath += `/${episode}.srt`;

      const blob = bucket.file(destPath);
      await blob.save(file.buffer, {
        contentType: 'text/plain',
        public: true,
      });
    } else {
      return res.status(400).json({ error: 'Only .srt or .zip files allowed' });
    }

    // Build response path (still returns a path string for compatibility)
    const responsePath = episode ? `/${safeTitle}/${episode}` : `/${safeTitle}/...`;
    res.json({ success: true, path: responsePath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve subtitle files (proxied from GCS)
app.get('/subtitles/:title/:episode', async (req, res) => {
  const { title, episode } = req.params;
  const safeTitle = sanitise(title);
  const filePath = `shows/${safeTitle}/${episode}.srt`;

  try {
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).send('Not found');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    file.createReadStream().pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Version with season
app.get('/subtitles/:title/:season/:episode', async (req, res) => {
  const { title, season, episode } = req.params;
  const safeTitle = sanitise(title);
  const safeSeason = `season-${sanitise(season)}`;
  const filePath = `shows/${safeTitle}/${safeSeason}/${episode}.srt`;

  try {
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).send('Not found');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    file.createReadStream().pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// List all uploaded subtitles (from GCS)
app.get('/list', async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: 'shows/' });
    const shows = {};

    for (const file of files) {
      const parts = file.name.split('/');
      // Expected structure: shows/{title}/[season-{n}/]{episode}.srt
      if (parts.length < 3) continue; // malformed

      const show = parts[1];
      if (!shows[show]) shows[show] = {};

      if (parts.length === 3) {
        // No season: shows/{title}/{episode}.srt
        const episode = parts[2].replace(/\.srt$/, '');
        if (!Array.isArray(shows[show])) shows[show] = [];
        shows[show].push(episode);
      } else if (parts.length === 4 && parts[2].startsWith('season-')) {
        // With season: shows/{title}/season-{n}/{episode}.srt
        const season = parts[2];
        const episode = parts[3].replace(/\.srt$/, '');
        if (!shows[show][season]) shows[show][season] = [];
        shows[show][season].push(episode);
      }
    }

    res.json({ shows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
