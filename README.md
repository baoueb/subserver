# subserver

Subtitle backend for the **Continue Watching** Chrome extension. It stores and serves subtitle files and finds missing ones through a small Python service.

## Components

| Path | Stack | Purpose |
| --- | --- | --- |
| `server.js` | Node.js, Express | REST API for uploading, listing, and fetching subtitles, stored in Google Cloud Storage |
| `subliminal-service/` | Python, FastAPI | Subtitle search and download using [subliminal](https://github.com/Diaoul/subliminal) |

## Run the Node server

```bash
npm install
npm start
```

Environment variables:

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `BUCKET_NAME` | Google Cloud Storage bucket (default `subserver-subtitles`) |
| `GCS_KEY_JSON` | Service account key JSON, written to a temp file at startup |
| `API_KEY` | Optional. When set, write endpoints require an `x-api-key` header |

## Run the subtitle search service

```bash
cd subliminal-service
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## Main endpoints

- `POST /upload`: upload a subtitle file (API key required if set)
- `GET /list`: list stored shows
- `GET /subtitles/:title/:episode/:version`: fetch a subtitle
- `GET /versions/:title/:episode`: list available versions
- `DELETE /shows/:show`: remove a show (API key required if set)
- Python service: `GET /ping`, `POST /subliminal/search`, `GET /subliminal/download/{subtitle_id}`
