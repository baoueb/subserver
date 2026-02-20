from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import subliminal
from babelfish import Language
import time
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Simple in-memory cache for subtitle objects (id -> (subtitle, expiry))
# Expiry time: 30 minutes (1800 seconds)
CACHE_TTL = 1800
subtitle_cache = {}

class SearchRequest(BaseModel):
    title: str
    season: Optional[int] = None
    episode: Optional[int] = None
    languages: List[str] = ["ja"]

class SubtitleItem(BaseModel):
    id: str
    provider: str
    language: str
    release: str
    score: float
    filename: Optional[str] = None

@app.get("/ping")
async def ping():
    """Health check endpoint."""
    return {"status": "ok"}

@app.post("/subliminal/search", response_model=List[SubtitleItem])
async def search_subtitles(req: SearchRequest):
    # Build video object
    if req.season is not None and req.episode is not None:
        video = subliminal.Episode.fromname(f"{req.title} S{req.season:02d}E{req.episode:02d}")
    else:
        video = subliminal.Movie.fromname(req.title)

    languages = {Language(l) for l in req.languages}

    # List subtitles from all providers
    try:
        subtitles = subliminal.list_subtitles([video], languages)[video]
    except Exception as e:
        logger.error(f"Error listing subtitles: {e}")
        raise HTTPException(status_code=500, detail="Subtitle listing failed")

    results = []
    now = time.time()
    for sub in subtitles:
        # Compute score (0-1)
        matches = sub.get_matches(video)
        score = sum(1 for m in matches) / len(subliminal.scores[video.__class__.__name__])
        item_id = f"{sub.provider_name}:{sub.id}"
        results.append(SubtitleItem(
            id=item_id,
            provider=sub.provider_name,
            language=str(sub.language),
            release=sub.release_info or "",
            score=score,
            filename=getattr(sub, "filename", None)
        ))
        # Cache the subtitle object for later download
        subtitle_cache[item_id] = (sub, now + CACHE_TTL)

    # Clean expired cache entries (optional, but keep it simple)
    # In a production service you'd want a background cleanup task.
    return results

@app.get("/subliminal/download/{subtitle_id}")
async def download_subtitle(subtitle_id: str):
    # Check cache
    cached = subtitle_cache.get(subtitle_id)
    if cached is None:
        # Not in cache – could try to re‑fetch, but for simplicity we return 404
        raise HTTPException(status_code=404, detail="Subtitle not found in cache (try searching again)")
    subtitle, expiry = cached
    if time.time() > expiry:
        # Expired
        del subtitle_cache[subtitle_id]
        raise HTTPException(status_code=404, detail="Cached subtitle expired (try searching again)")

    try:
        # Download the subtitle content
        content = subtitle.get_content()
        return content
    except Exception as e:
        logger.error(f"Error downloading subtitle {subtitle_id}: {e}")
        raise HTTPException(status_code=500, detail="Download failed")
