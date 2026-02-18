const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const slugify = require('slugify');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your extension (allow any origin for simplicity)
app.use(cors());

// Configure multer for file uploads (store in memory for processing)
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
    const baseDir = path.join(__dirname, 'subtitles', safeTitle);
    if (season) {
      // season can be a number, e.g. "1"
      baseDir = path.join(baseDir, `season-${sanitise(String(season))}`);
    }
    fs.mkdirSync(baseDir, { recursive: true });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // Process based on file extension
    if (file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.srt')) {
          // Assume the entry name is already the episode number, e.g. "1.srt"
          const episodeName = path.basename(entry.name);
          const destPath = path.join(baseDir, episodeName);
          fs.writeFileSync(destPath, entry.getData());
        }
      }
    } else if (file.originalname.toLowerCase().endsWith('.srt')) {
      // Single file – need the episode number from user (we'll send it in the form)
      const episode = req.body.episode;
      if (!episode) return res.status(400).json({ error: 'Episode number required for single .srt file' });
      const destPath = path.join(baseDir, `${episode}.srt`);
      fs.writeFileSync(destPath, file.buffer);
    } else {
      return res.status(400).json({ error: 'Only .srt or .zip files allowed' });
    }

    res.json({ success: true, path: `/${safeTitle}/${episode ? episode : '...'}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve subtitle files
app.get('/subtitles/:title/:episode', (req, res) => {
  const { title, episode } = req.params;
  const safeTitle = sanitise(title);
  // Allow optional season parameter: /subtitles/:title/:season?/:episode
  // For simplicity we'll handle only title/episode here
  const filePath = path.join(__dirname, 'subtitles', safeTitle, `${episode}.srt`);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

// Optionally add a version with season
app.get('/subtitles/:title/:season/:episode', (req, res) => {
  const { title, season, episode } = req.params;
  const safeTitle = sanitise(title);
  const safeSeason = `season-${sanitise(season)}`;
  const filePath = path.join(__dirname, 'subtitles', safeTitle, safeSeason, `${episode}.srt`);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Not found');
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
