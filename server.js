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
    let baseDir = path.join(__dirname, 'subtitles', safeTitle);
    if (season) {
      baseDir = path.join(baseDir, `season-${sanitise(String(season))}`);
    }
    fs.mkdirSync(baseDir, { recursive: true });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    let episode = null; // ← declare once here, at the function level

    if (file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.srt')) {
          const episodeName = path.basename(entry.name);
          const destPath = path.join(baseDir, episodeName);
          fs.writeFileSync(destPath, entry.getData());
        }
      }
      // episode stays null for zip uploads
    } else if (file.originalname.toLowerCase().endsWith('.srt')) {
      episode = req.body.episode;
      if (!episode) {
        return res.status(400).json({ error: 'Episode number required for single .srt file' });
      }
      const destPath = path.join(baseDir, `${episode}.srt`);
      fs.writeFileSync(destPath, file.buffer);
    } else {
      return res.status(400).json({ error: 'Only .srt or .zip files allowed' });
    }

    // Build response path safely (episode may be null for zip)
    const responsePath = episode ? `/${safeTitle}/${episode}` : `/${safeTitle}/...`;
    res.json({ success: true, path: responsePath });
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

// List all uploaded subtitles
app.get('/list', (req, res) => {
  const baseDir = path.join(__dirname, 'subtitles');
  if (!fs.existsSync(baseDir)) return res.json({ shows: [] });

  const shows = fs.readdirSync(baseDir).filter(name => {
    const full = path.join(baseDir, name);
    return fs.statSync(full).isDirectory();
  });

  const result = {};
  shows.forEach(show => {
    const showPath = path.join(baseDir, show);
    const items = fs.readdirSync(showPath);

    // Check for season subfolders (named "season-1", "season-2", etc.)
    const seasons = items.filter(item => {
      const full = path.join(showPath, item);
      return fs.statSync(full).isDirectory() && item.startsWith('season-');
    });

    if (seasons.length > 0) {
      result[show] = {};
      seasons.forEach(season => {
        const seasonPath = path.join(showPath, season);
        const episodes = fs.readdirSync(seasonPath)
          .filter(f => f.endsWith('.srt'))
          .map(f => f.replace(/\.srt$/, ''));
        result[show][season] = episodes;
      });
    } else {
      // No season folders – episodes are directly under the show folder
      const episodes = items.filter(f => f.endsWith('.srt')).map(f => f.replace(/\.srt$/, ''));
      result[show] = episodes;
    }
  });

  res.json({ shows: result });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
