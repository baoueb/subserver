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
const bucketName = process.env.BUCKET_NAME || 'subserver-subtitles';
const bucket = storage.bucket(bucketName);

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // optional, for write operations

app.use(cors());
app.use(express.json());

// Configure multer for file uploads (store in memory)
const upload = multer({ storage: multer.memoryStorage() });

// Helper to sanitise folder names
function sanitise(str) {
  return slugify(str, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
}

// Helper to extract episode number from filename (e.g., "12.srt" or "ep12.srt")
function extractEpisodeNumber(filename) {
  const match = filename.match(/(?:^|\D)(\d{1,3})(?:\.srt|$)/);
  return match ? parseInt(match[1], 10) : null;
}

// Helper to parse versioned filename
function parseVersionedFilename(filename) {
  // Format: episode_v{version}_{source}.srt
  const base = path.basename(filename, '.srt');
  const parts = base.split('_v');
  if (parts.length !== 2) return null;
  const [episodePart, rest] = parts;
  const versionSource = rest.split('_');
  if (versionSource.length !== 2) return null;
  const version = parseInt(versionSource[0], 10);
  const source = versionSource[1];
  const episode = parseInt(episodePart, 10);
  if (isNaN(episode) || isNaN(version) || !source) return null;
  return { episode, version, source };
}

// Helper to build versioned filename
function buildVersionedFilename(episode, version, source) {
  return `${episode}_v${version}_${source}.srt`;
}

// Middleware to check API key for uploads (optional)
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  next();
}


// Helper to delete files matching a prefix
async function deleteFilesByPrefix(prefix) {
  const [files] = await bucket.getFiles({ prefix });
  const deletePromises = files.map(file => file.delete());
  await Promise.all(deletePromises);
  return files.length;
}

// Clear entire catalog
app.delete('/clear-all', requireApiKey, async (req, res) => {
  try {
    const count = await deleteFilesByPrefix('shows/');
    res.json({ success: true, deletedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete whole show
app.delete('/shows/:show', requireApiKey, async (req, res) => {
  try {
    const { show } = req.params;
    const safeShow = sanitise(show);
    const prefix = `shows/${safeShow}/`;
    const count = await deleteFilesByPrefix(prefix);
    res.json({ success: true, deletedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific version (without season)
app.delete('/shows/:show/episode/:episode/version/:version', requireApiKey, async (req, res) => {
  try {
    const { show, episode, version } = req.params;
    const safeShow = sanitise(show);
    const ep = parseInt(episode, 10);
    const ver = parseInt(version, 10);
    const prefix = `shows/${safeShow}/${ep}_v${ver}_`;  // source wildcard
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return res.status(404).json({ error: 'Version not found' });
    await files[0].delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific version with season
app.delete('/shows/:show/:season/episode/:episode/version/:version', requireApiKey, async (req, res) => {
  try {
    const { show, season, episode, version } = req.params;
    const safeShow = sanitise(show);
    const safeSeason = `season-${sanitise(season)}`;
    const ep = parseInt(episode, 10);
    const ver = parseInt(version, 10);
    const prefix = `shows/${safeShow}/${safeSeason}/${ep}_v${ver}_`;
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return res.status(404).json({ error: 'Version not found' });
    await files[0].delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all versions of a specific episode (without season)
app.delete('/shows/:show/episode/:episode', requireApiKey, async (req, res) => {
  try {
    const { show, episode } = req.params;
    const safeShow = sanitise(show);
    const ep = parseInt(episode, 10);
    const prefix = `shows/${safeShow}/${ep}_v`;  // all versions
    const count = await deleteFilesByPrefix(prefix);
    res.json({ success: true, deletedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all versions of a specific episode with season
app.delete('/shows/:show/:season/episode/:episode', requireApiKey, async (req, res) => {
  try {
    const { show, season, episode } = req.params;
    const safeShow = sanitise(show);
    const safeSeason = `season-${sanitise(season)}`;
    const ep = parseInt(episode, 10);
    const prefix = `shows/${safeShow}/${safeSeason}/${ep}_v`;
    const count = await deleteFilesByPrefix(prefix);
    res.json({ success: true, deletedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Delete all versions of a whole season
app.delete('/shows/:show/:season', requireApiKey, async (req, res) => {
  try {
    const { show, season } = req.params;
    const safeShow = sanitise(show);
    const safeSeason = `season-${sanitise(season)}`;   // season is raw number
    const prefix = `shows/${safeShow}/${safeSeason}/`;
    const count = await deleteFilesByPrefix(prefix);
    res.json({ success: true, deletedCount: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload endpoint
app.post('/upload', requireApiKey, upload.single('file'), async (req, res) => {
  try {
    const { title, season, source } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });
    if (!source) return res.status(400).json({ error: 'Missing source' });

    const safeTitle = sanitise(title);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const uploadedFiles = [];

    if (file.originalname.endsWith('.zip')) {
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.name.toLowerCase().endsWith('.srt')) {
          const episode = extractEpisodeNumber(entry.name);
          if (!episode) {
            console.warn(`Skipping ${entry.name} – cannot detect episode`);
            continue;
          }

          // Determine next version for this episode
          let prefix = `shows/${safeTitle}`;
          if (season) prefix += `/season-${sanitise(String(season))}`;
          prefix += `/${episode}_v`;

          const [files] = await bucket.getFiles({ prefix });
          let maxVersion = 0;
          for (const f of files) {
            const parsed = parseVersionedFilename(f.name.split('/').pop());
            if (parsed && parsed.episode === episode) {
              maxVersion = Math.max(maxVersion, parsed.version);
            }
          }
          const version = maxVersion + 1;

          const destFilename = buildVersionedFilename(episode, version, source);
          let destPath = `shows/${safeTitle}`;
          if (season) destPath += `/season-${sanitise(String(season))}`;
          destPath += `/${destFilename}`;

          const blob = bucket.file(destPath);
          await blob.save(entry.getData(), {
            contentType: 'text/plain',
            public: true,
            metadata: {
              source,
              uploadedAt: new Date().toISOString(),
            },
          });

          uploadedFiles.push({ filename: destFilename, episode, version, source });
        }
      }
    } else if (file.originalname.toLowerCase().endsWith('.srt')) {
      const episode = req.body.episode || extractEpisodeNumber(file.originalname);
      if (!episode) {
        return res.status(400).json({ error: 'Could not detect episode number; provide it explicitly' });
      }

      // Determine next version
      let prefix = `shows/${safeTitle}`;
      if (season) prefix += `/season-${sanitise(String(season))}`;
      prefix += `/${episode}_v`;

      const [files] = await bucket.getFiles({ prefix });
      let maxVersion = 0;
      for (const f of files) {
        const parsed = parseVersionedFilename(f.name.split('/').pop());
        if (parsed && parsed.episode === episode) {
          maxVersion = Math.max(maxVersion, parsed.version);
        }
      }
      const version = maxVersion + 1;

      const destFilename = buildVersionedFilename(episode, version, source);
      let destPath = `shows/${safeTitle}`;
      if (season) destPath += `/season-${sanitise(String(season))}`;
      destPath += `/${destFilename}`;

      const blob = bucket.file(destPath);
      await blob.save(file.buffer, {
        contentType: 'text/plain',
        public: true,
        metadata: {
          source,
          uploadedAt: new Date().toISOString(),
        },
      });

      uploadedFiles.push({ filename: destFilename, episode, version, source });
    } else {
      return res.status(400).json({ error: 'Only .srt or .zip files allowed' });
    }

    res.json({ success: true, uploaded: uploadedFiles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch a specific version
app.get('/subtitles/:title/:episode/:version', async (req, res) => {
  const { title, episode, version } = req.params;
  const safeTitle = sanitise(title);
  const prefix = `shows/${safeTitle}/${episode}_v${version}_`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return res.status(404).send('Not found');
    // There should be exactly one file matching that version (source could be anything)
    const file = files[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    file.createReadStream().pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Fetch with season
app.get('/subtitles/:title/:season/:episode/:version', async (req, res) => {
  const { title, season, episode, version } = req.params;
  const safeTitle = sanitise(title);
  const safeSeason = `season-${sanitise(season)}`;
  const prefix = `shows/${safeTitle}/${safeSeason}/${episode}_v${version}_`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    if (files.length === 0) return res.status(404).send('Not found');
    const file = files[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    file.createReadStream().pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Versions endpoint: return list of versions for an episode
app.get('/versions/:title/:episode', async (req, res) => {
  const { title, episode } = req.params;
  const safeTitle = sanitise(title);
  const prefix = `shows/${safeTitle}/${episode}_v`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    const versions = [];
    for (const file of files) {
      const parsed = parseVersionedFilename(file.name.split('/').pop());
      if (parsed && parsed.episode === parseInt(episode, 10)) {
        const [metadata] = await file.getMetadata();
        versions.push({
          version: parsed.version,
          source: parsed.source,
          filename: file.name.split('/').pop(),
          uploadedAt: metadata.metadata?.uploadedAt || metadata.timeCreated,
        });
      }
    }
    versions.sort((a, b) => a.version - b.version);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Versions with season
app.get('/versions/:title/:season/:episode', async (req, res) => {
  const { title, season, episode } = req.params;
  const safeTitle = sanitise(title);
  const safeSeason = `season-${sanitise(season)}`;
  const prefix = `shows/${safeTitle}/${safeSeason}/${episode}_v`;
  try {
    const [files] = await bucket.getFiles({ prefix });
    const versions = [];
    for (const file of files) {
      const parsed = parseVersionedFilename(file.name.split('/').pop());
      if (parsed && parsed.episode === parseInt(episode, 10)) {
        const [metadata] = await file.getMetadata();
        versions.push({
          version: parsed.version,
          source: parsed.source,
          filename: file.name.split('/').pop(),
          uploadedAt: metadata.metadata?.uploadedAt || metadata.timeCreated,
        });
      }
    }
    versions.sort((a, b) => a.version - b.version);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HEAD: check if any version exists for a given title and episode (no season)
app.head('/subtitles/:title/:episode', async (req, res) => {
  const { title, episode } = req.params;
  const safeTitle = sanitise(title);
  const ep = parseInt(episode, 10);
  if (isNaN(ep)) return res.sendStatus(400);

  const prefix = `shows/${safeTitle}/${ep}_v`; // matches all versions for this episode
  try {
    const [files] = await bucket.getFiles({ prefix, maxResults: 1 }); // we only need one
    if (files.length > 0) {
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error('HEAD /subtitles/:title/:episode error:', err);
    res.sendStatus(500);
  }
});
// HEAD: check if any version exists for a given title, season, and episode
app.head('/subtitles/:title/:season/:episode', async (req, res) => {
  const { title, season, episode } = req.params;
  const safeTitle = sanitise(title);
  const safeSeason = `season-${sanitise(season)}`;
  const ep = parseInt(episode, 10);
  if (isNaN(ep)) return res.sendStatus(400);

  const prefix = `shows/${safeTitle}/${safeSeason}/${ep}_v`; // all versions for this episode in that season
  try {
    const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
    if (files.length > 0) {
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error('HEAD /subtitles/:title/:season/:episode error:', err);
    res.sendStatus(500);
  }
});

// List endpoint with full version info
app.get('/list', async (req, res) => {
  const acceptHeader = req.get('Accept') || '';
  if (acceptHeader.includes('text/html')) {
    // Client‑side script – defined as a raw string to avoid server interpolation
    const clientScript = `
      let currentContext = null; // { type, show, season, episode, version }

      // Load API key from localStorage (if any)
      let apiKey = localStorage.getItem('catalogApiKey') || '';

      function promptApiKey() {
        const key = prompt('Enter API key (if required):');
        if (key !== null) {
          apiKey = key;
          localStorage.setItem('catalogApiKey', key);
        }
        return key;
      }

      async function fetchWithKey(url, options = {}) {
        if (apiKey) {
          options.headers = { ...(options.headers || {}), 'x-api-key': apiKey };
        }
        const response = await fetch(url, options);
        if (response.status === 403) {
          alert('Invalid API key or permission denied.');
          return null;
        }
        return response;
      }
      // Delete show button handler
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.delete-show-btn');
        if (!btn) return;
        const show = btn.dataset.show;
        if (!confirm(`Delete entire show "${show}"?`)) return;
        const response = await fetchWithKey(`/shows/${encodeURIComponent(show)}`, { method: 'DELETE' });
        if (response && response.ok) {
          alert('Show deleted.');
          loadCatalog();
        } else if (response) {
          const err = await response.json();
          alert('Error: ' + err.error);
        }
      });
      async function loadCatalog() {
        try {
          const response = await fetch('/list', { headers: { 'Accept': 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          window.catalogShows = data.shows; // store for pagination
          renderCatalog(data.shows);
          attachPaginationHandlers();
        } catch (err) {
          document.getElementById('content').innerHTML = '<div class=\"error\">❌ Failed to load: ' + err.message + '</div>';
        }
      }

      function renderCatalog(shows) {
        const container = document.getElementById('content');
        if (!shows || Object.keys(shows).length === 0) {
          container.innerHTML = '<div class=\"error\">📭 No subtitles found in the catalog.</div>';
          return;
        }

        let html = '';
        for (const [showName, showData] of Object.entries(shows)) {
          html += \`<div class=\"show\" data-show=\"\${escapeHtml(showName)}\"><h2>\${escapeHtml(showName)}<button class=\"delete-show-btn\" data-show=\"\${escapeHtml(showName)}\" title=\"Delete this show\">🗑️</button></h2>`;
          if (Array.isArray(showData)) {
            // No seasons
            html += renderEpisodesHtml(showName, null, showData);
          } else {
            // Has seasons
            for (const [seasonKey, episodes] of Object.entries(showData)) {
              const seasonNumber = seasonKey.replace(/^season-/i, '');
              html += \`<div class=\"season\" data-season=\"\${escapeHtml(seasonNumber)}\">\`;
              html += \`<h3>\${escapeHtml(seasonKey.replace(/^season-/i,'Season '))}</h3>\`;
              html += renderEpisodesHtml(showName, seasonKey, episodes);
              html += '</div>';
            }
          }
          html += '</div>';
        }

        html += '<div class=\"footer\">✨ Found ' + Object.keys(shows).length + ' shows in your cloud bucket.</div>';
        container.innerHTML = html;
      }

      function renderEpisodesHtml(showName, seasonKey, episodes) {
        // Sort numerically
        const sorted = episodes.slice().sort((a,b) => a.episode - b.episode);
        const total = sorted.length;
        const pageSize = 100;
        const pages = Math.ceil(total / pageSize);

        let output = '<div class=\"episodes-container\">';

        if (pages > 1) {
          output += \`
              <div style=\"display:flex; align-items:center; gap:8px; margin-bottom:8px;\">
                  <span style=\"color:#aaa;\">Episodes:</span>
                  <select class=\"episode-page-select\" data-show=\"\${escapeHtml(showName)}\" data-season=\"\${escapeHtml(seasonKey || '')}\" style=\"background:#1e1e1e; color:#fff; border:1px solid #4b5563; border-radius:4px; padding:4px 8px;\">
          \`;
          for (let i = 0; i < pages; i++) {
            const start = i * pageSize + 1;
            const end = Math.min((i + 1) * pageSize, total);
            output += \`<option value=\"\${i}\">\${start}–\${end}</option>\`;
          }
          output += '</select></div>';
        }

        // Render first page
        const firstPageEpisodes = sorted.slice(0, pageSize);
        output += '<div class=\"episodes-grid\">';
        firstPageEpisodes.forEach(ep => {
          if (!ep || !Array.isArray(ep.versions)) return;
          const epNum = ep.episode;
          const versions = ep.versions.sort((a,b) => a.version - b.version);
          output += \`
              <div class=\"episode-block\" data-episode=\"\${epNum}\">
                  <div class=\"episode-title\">Ep \${epNum}</div>
                  <div class=\"version-row\">
          \`;
          versions.forEach(v => {
            const sourceClass = v.source === 'kitsu' ? 'source-kitsu' : 'source-cloud';
            output += \`
                  <button class=\"version-btn \${sourceClass}\" data-version=\"\${v.version}\" data-source=\"\${v.source}\" title=\"\${escapeHtml(v.filename)}\" data-show=\"\${escapeHtml(showName)}\" data-season=\"\${escapeHtml(seasonKey || '')}\" data-episode=\"\${epNum}\">
                      \${v.source} #\${v.version}
                  </button>
            \`;
          });
          output += '</div></div>';
        });
        output += '</div></div>';

        return output;
      }

      function attachPaginationHandlers() {
        document.querySelectorAll('.episode-page-select').forEach(select => {
          select.addEventListener('change', function() {
            const show = this.dataset.show;
            const season = this.dataset.season;
            const page = parseInt(this.value, 10);
            const pageSize = 100;

            const parentShow = this.closest('.show');
            const seasonDiv = this.closest('.season');
            let container = parentShow;
            if (seasonDiv) container = seasonDiv;
            const episodesContainer = container.querySelector('.episodes-container');
            if (!episodesContainer) return;

            const showData = window.catalogShows[show];
            if (!showData) return;
            let episodes;
            if (season) {
              const seasonKey = \`season-\${season}\`;
              episodes = showData[seasonKey];
            } else {
              episodes = showData;
            }
            if (!episodes || !Array.isArray(episodes)) return;

            const sorted = episodes.slice().sort((a,b) => a.episode - b.episode);
            const start = page * pageSize;
            const end = Math.min(start + pageSize, sorted.length);
            const pageEpisodes = sorted.slice(start, end);

            let gridHtml = '<div class=\"episodes-grid\">';
            pageEpisodes.forEach(ep => {
              if (!ep || !Array.isArray(ep.versions)) return;
              const epNum = ep.episode;
              const versions = ep.versions.sort((a,b) => a.version - b.version);
              gridHtml += \`
                  <div class=\"episode-block\" data-episode=\"\${epNum}\">
                      <div class=\"episode-title\">Ep \${epNum}</div>
                      <div class=\"version-row\">
              \`;
              versions.forEach(v => {
                const sourceClass = v.source === 'kitsu' ? 'source-kitsu' : 'source-cloud';
                gridHtml += \`
                      <button class=\"version-btn \${sourceClass}\" data-version=\"\${v.version}\" data-source=\"\${v.source}\" title=\"\${escapeHtml(v.filename)}\" data-show=\"\${escapeHtml(show)}\" data-season=\"\${escapeHtml(season || '')}\" data-episode=\"\${epNum}\">
                          \${v.source} #\${v.version}
                      </button>
                \`;
              });
              gridHtml += '</div></div>';
            });
            gridHtml += '</div>';

            const oldGrid = episodesContainer.querySelector('.episodes-grid');
            if (oldGrid) {
              const newGrid = document.createElement('div');
              newGrid.innerHTML = gridHtml;
              oldGrid.parentNode.replaceChild(newGrid.firstChild, oldGrid);
            } else {
              episodesContainer.insertAdjacentHTML('beforeend', gridHtml);
            }
          });
        });
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

      // --- Context menu logic (unchanged) ---
      const menu = document.getElementById('context-menu');

      document.addEventListener('contextmenu', (e) => {
        const target = e.target.closest('[data-show], [data-season], [data-episode], [data-version]');
        if (!target) return;

        e.preventDefault();

        const showEl = target.closest('[data-show]');
        const seasonEl = target.closest('[data-season]');
        const episodeEl = target.closest('[data-episode]');
        const versionEl = target.closest('[data-version]');

        let type = 'show';
        let show = showEl?.dataset.show;
        let season = seasonEl?.dataset.season;
        let episode = episodeEl?.dataset.episode;
        let version = versionEl?.dataset.version;
        let source = versionEl?.dataset.source;

        if (version) {
          type = 'version';
        } else if (episode) {
          type = 'episode';
        } else if (season) {
          type = 'season';
        } else if (show) {
          type = 'show';
        }

        currentContext = { type, show, season, episode, version, source };

        let menuHtml = '';
        if (type === 'version') {
          menuHtml += '<button data-action=\"delete-version\">Delete this version</button>';
          menuHtml += '<button data-action=\"delete-episode\">Delete all versions of episode ' + episode + '</button>';
          menuHtml += '<hr>';
          menuHtml += '<button data-action=\"delete-show\">Delete entire show \"' + show + '\"</button>';
        } else if (type === 'episode') {
          menuHtml += '<button data-action=\"delete-episode\">Delete all versions of episode ' + episode + '</button>';
          menuHtml += '<hr>';
          menuHtml += '<button data-action=\"delete-show\">Delete entire show \"' + show + '\"</button>';
        } else if (type === 'season') {
          menuHtml += '<button data-action=\"delete-season\">Delete entire season \"' + season + '\"</button>';
          menuHtml += '<hr>';
          menuHtml += '<button data-action=\"delete-show\">Delete entire show \"' + show + '\"</button>';
        } else if (type === 'show') {
          menuHtml += '<button data-action=\"delete-show\">Delete entire show \"' + show + '\"</button>';
        }
        menuHtml += '<hr><button data-action=\"cancel\">Cancel</button>';

        menu.innerHTML = menuHtml;
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
      });

      document.addEventListener('click', (e) => {
        if (!menu.contains(e.target)) {
          menu.style.display = 'none';
        }
      });

      menu.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        if (!action || action === 'cancel') {
          menu.style.display = 'none';
          return;
        }

        if (!currentContext) return;

        const { show, season, episode, version, source } = currentContext;
        let url = '';
        let confirmMsg = '';

        if (action === 'delete-show') {
          url = '/shows/' + encodeURIComponent(show);
          confirmMsg = 'Delete entire show \"' + show + '\"?';
        } else if (action === 'delete-season') {
          url = '/shows/' + encodeURIComponent(show) + '/' + encodeURIComponent(season);
          confirmMsg = 'Delete all subtitles in season \"' + season + '\" of \"' + show + '\"?';
        } else if (action === 'delete-episode') {
          if (season) {
            url = '/shows/' + encodeURIComponent(show) + '/' + encodeURIComponent(season) + '/episode/' + episode;
          } else {
            url = '/shows/' + encodeURIComponent(show) + '/episode/' + episode;
          }
          confirmMsg = 'Delete all versions of episode ' + episode + ' of \"' + show + '\"?';
        } else if (action === 'delete-version') {
          if (season) {
            url = '/shows/' + encodeURIComponent(show) + '/' + encodeURIComponent(season) + '/episode/' + episode + '/version/' + version;
          } else {
            url = '/shows/' + encodeURIComponent(show) + '/episode/' + episode + '/version/' + version;
          }
          confirmMsg = 'Delete ' + source + ' v' + version + ' of episode ' + episode + '?';
        }

        if (!url || !confirm(confirmMsg)) {
          menu.style.display = 'none';
          return;
        }

        menu.style.display = 'none';

        const response = await fetchWithKey(url, { method: 'DELETE' });
        if (!response) return;
        if (response.ok) {
          alert('Deleted successfully.');
          loadCatalog();
        } else {
          const err = await response.json();
          alert('Error: ' + err.error);
        }
      });

      document.getElementById('clearAllBtn').addEventListener('click', async () => {
        if (!confirm('⚠️ This will delete ALL subtitles from the catalog. Are you sure?')) return;
        const response = await fetchWithKey('/clear-all', { method: 'DELETE' });
        if (!response) return;
        if (response.ok) {
          alert('All subtitles cleared.');
          loadCatalog();
        } else {
          const err = await response.json();
          alert('Error: ' + err.error);
        }
      });

      loadCatalog();
    `;

    // Serve the complete HTML page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Subtitle Catalog</title>
        <style>
          body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; color: #e0e0e0; line-height: 1.6; margin: 0; padding: 20px; }
          .container { max-width: 1200px; margin: 0 auto; }
          h1 { color: #4ade80; border-bottom: 2px solid #333; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
          .clear-all { background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
          .clear-all:hover { background: #dc2626; }
          .show { background: #2a2a2a; border-radius: 8px; margin-bottom: 20px; padding: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
          .show h2 { margin: 0 0 10px 0; color: #ffd966; font-size: 1.5rem; cursor: context-menu; }
          .season { margin-left: 20px; margin-bottom: 15px; }
          .season h3 { color: #9ca3af; margin: 10px 0 5px 0; font-size: 1.2rem; cursor: context-menu; }
          .episodes-grid {
              display: flex;
              flex-wrap: wrap;
              gap: 12px;
              margin-top: 8px;
          }
          .episode-block {
              background: #1e1e1e;
              border-radius: 8px;
              padding: 8px;
              min-width: 180px;
              flex: 1 0 auto;
          }
          .episode-block .episode-title {
              font-weight: bold;
              color: #ffd966;
              margin-bottom: 6px;
          }
          .version-row {
              display: flex;
              flex-wrap: wrap;
              gap: 4px;
          }
          .version-btn {
              background: #374151;
              border: 1px solid #4b5563;
              border-radius: 20px;
              padding: 4px 10px;
              color: #d1d5db;
              font-size: 0.8rem;
              cursor: pointer;
              white-space: nowrap;
          }
          .version-btn:hover {
              background: #4b5563;
          }
          .source-kitsu { color: #ffa500; }
          .source-cloud { color: #4ade80; }
          .loading, .error { text-align: center; padding: 40px; font-size: 1.2rem; }
          .error { color: #f87171; }
          .footer { margin-top: 30px; text-align: center; color: #6b7280; font-size: 0.9rem; border-top: 1px solid #333; padding-top: 20px; }
          .show h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.delete-show-btn {
    background: none;
    border: none;
    color: #ef4444;
    font-size: 1.2rem;
    cursor: pointer;
}
.delete-show-btn:hover {
    color: #dc2626;
}
          /* Context menu */
          #context-menu {
            position: fixed;
            background: #1f1f1f;
            border: 1px solid #4b5563;
            border-radius: 6px;
            box-shadow: 0 8px 20px rgba(0,0,0,0.5);
            padding: 4px 0;
            z-index: 1000;
            display: none;
            min-width: 200px;
          }
          #context-menu button {
            display: block;
            width: 100%;
            text-align: left;
            background: none;
            border: none;
            padding: 8px 12px;
            color: #fff;
            font-size: 14px;
            cursor: pointer;
          }
          #context-menu button:hover {
            background: #374151;
          }
          #context-menu hr {
            margin: 4px 0;
            border: none;
            border-top: 1px solid #4b5563;
          }

        </style>
      </head>
      <body>
        <div class="container">
          <h1>📚 Subtitle Catalog
            <button class="clear-all" id="clearAllBtn">🗑️ Clear All</button>
          </h1>
          <div id="content" class="loading">Loading catalog...</div>
        </div>
        <div id="context-menu"></div>
        <script>${clientScript}</script>
      </body>
      </html>
    `);
    return;
  }

  // JSON response (unchanged)
  try {
    const [files] = await bucket.getFiles({ prefix: 'shows/' });
    const shows = {};

    for (const file of files) {
      const parts = file.name.split('/');
      if (parts.length < 3) continue;

      const show = parts[1];
      if (!shows[show]) shows[show] = {};

      const filename = parts[parts.length - 1];
      const parsed = parseVersionedFilename(filename);
      if (!parsed) continue;

      const { episode, version, source } = parsed;
      let [metadata] = await file.getMetadata();
      const uploadedAt = metadata.metadata?.uploadedAt || metadata.timeCreated;

      if (parts.length === 3) {
        if (!Array.isArray(shows[show])) shows[show] = [];
        let epObj = shows[show].find(e => e.episode === episode);
        if (!epObj) {
          epObj = { episode, versions: [] };
          shows[show].push(epObj);
        }
        epObj.versions.push({ version, source, filename, uploadedAt });
      } else if (parts.length === 4 && parts[2].startsWith('season-')) {
        const season = parts[2];
        if (!shows[show][season]) shows[show][season] = [];
        let epObj = shows[show][season].find(e => e.episode === episode);
        if (!epObj) {
          epObj = { episode, versions: [] };
          shows[show][season].push(epObj);
        }
        epObj.versions.push({ version, source, filename, uploadedAt });
      }
    }

    for (const show in shows) {
      if (Array.isArray(shows[show])) {
        shows[show].forEach(ep => ep.versions.sort((a,b) => a.version - b.version));
      } else {
        for (const season in shows[show]) {
          shows[show][season].forEach(ep => ep.versions.sort((a,b) => a.version - b.version));
        }
      }
    }

    res.json({ shows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  // ─────────────────────────────────────────────────────────────
// Wordlist backup endpoints (JSON)
// ─────────────────────────────────────────────────────────────

// Upload/overwrite the global wordlist
app.put('/wordlist.json', requireApiKey, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid or missing JSON data' });
    }

    const blob = bucket.file('wordlist.json');
    await blob.save(JSON.stringify(data), {
      contentType: 'application/json',
      public: false,                // keep private; access only via API key
      metadata: {
        uploadedAt: new Date().toISOString(),
      },
    });

    res.json({ success: true, message: 'Wordlist saved' });
  } catch (err) {
    console.error('[PUT /wordlist.json]', err);
    res.status(500).json({ error: err.message });
  }
});

// Retrieve the stored wordlist
app.get('/wordlist.json', requireApiKey, async (req, res) => {
  try {
    const blob = bucket.file('wordlist.json');
    const [exists] = await blob.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Wordlist not found' });
    }

    const [data] = await blob.download();
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    console.error('[GET /wordlist.json]', err);
    res.status(500).json({ error: err.message });
  }

});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
