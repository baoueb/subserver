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

// Smart /list endpoint: HTML for browsers, JSON for code
app.get('/list', async (req, res) => {
  // Check if the client expects HTML
  const acceptHeader = req.get('Accept') || '';
  if (acceptHeader.includes('text/html')) {
    // Serve a styled HTML page that fetches and displays the JSON data
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Subtitle Catalog</title>
        <style>
          body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #e0e0e0; line-height: 1.6; margin: 0; padding: 20px; }
          .container { max-width: 1200px; margin: 0 auto; }
          h1 { color: #4ade80; border-bottom: 2px solid #333; padding-bottom: 10px; }
          .show { background: #2a2a2a; border-radius: 8px; margin-bottom: 20px; padding: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
          .show h2 { margin: 0 0 10px 0; color: #ffd966; font-size: 1.5rem; }
          .season { margin-left: 20px; margin-bottom: 15px; }
          .season h3 { color: #9ca3af; margin: 10px 0 5px 0; font-size: 1.2rem; }
          .episodes { display: flex; flex-wrap: wrap; gap: 8px; }
          .episode { background: #374151; padding: 5px 12px; border-radius: 20px; font-size: 0.9rem; border: 1px solid #4b5563; color: #d1d5db; }
          .episode:hover { background: #4b5563; }
          .no-season { margin-left: 20px; }
          .loading, .error { text-align: center; padding: 40px; font-size: 1.2rem; }
          .error { color: #f87171; }
          .footer { margin-top: 30px; text-align: center; color: #6b7280; font-size: 0.9rem; border-top: 1px solid #333; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>📚 Subtitle Catalog</h1>
          <div id="content" class="loading">Loading catalog...</div>
        </div>
        <script>
          async function loadCatalog() {
            try {
              const response = await fetch('/list', { headers: { 'Accept': 'application/json' } });
              if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
              const data = await response.json();
              renderCatalog(data.shows);
            } catch (err) {
              document.getElementById('content').innerHTML = \`<div class="error">❌ Failed to load: \${err.message}</div>\`;
            }
          }

          function renderCatalog(shows) {
            const container = document.getElementById('content');
            if (!shows || Object.keys(shows).length === 0) {
              container.innerHTML = '<div class="error">📭 No subtitles found in the catalog.</div>';
              return;
            }

            let html = '';
            for (const [showName, showData] of Object.entries(shows)) {
              html += \`<div class="show"><h2>\${escapeHtml(showName)}</h2>\`;

              if (Array.isArray(showData)) {
                // No seasons: direct episode list
                html += \`<div class="no-season episodes">\`;
                showData.sort().forEach(ep => {
                  html += \`<span class="episode">\${escapeHtml(ep)}</span>\`;
                });
                html += \`</div>\`;
              } else {
                // Has seasons
                for (const [seasonName, episodes] of Object.entries(showData)) {
                  html += \`<div class="season"><h3>\${escapeHtml(seasonName)}</h3>\`;
                  html += \`<div class="episodes">\`;
                  episodes.sort().forEach(ep => {
                    html += \`<span class="episode">\${escapeHtml(ep)}</span>\`;
                  });
                  html += \`</div></div>\`;
                }
              }
              html += \`</div>\`;
            }

            html += \`<div class="footer">✨ Found \${Object.keys(shows).length} shows in your cloud bucket.</div>\`;
            container.innerHTML = html;
          }

          function escapeHtml(unsafe) {
            return unsafe.replace(/[&<>"']/g, function(m) {
              if (m === '&') return '&amp;';
              if (m === '<') return '&lt;';
              if (m === '>') return '&gt;';
              if (m === '"') return '&quot;';
              return '&#039;';
            });
          }

          loadCatalog();
        </script>
      </body>
      </html>
    `);
    return;
  }

  // For non-browser requests (like your extension), continue to your existing JSON logic
  // (This is where you would put your current /list code, or you can reuse the same logic)
  try {
    const [files] = await bucket.getFiles({ prefix: 'shows/' });
    // ... your existing JSON building logic here (the one you already have in your /list route)
    // I'm omitting it here for brevity, but keep your full existing /list logic below.
  } catch (err) {
    res.status(500).json({ error: err.message });
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
