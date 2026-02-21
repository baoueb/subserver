from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import subliminal
from babelfish import Language
import time
import logging

# Import the download function
from subliminal import download_subtitles

# Import scores for normalisation (may not exist in all versions)
try:
    from subliminal.score import scores
except ImportError:
    scores = None

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
    try:
        # Build video object
        if req.season is not None and req.episode is not None:
            video = subliminal.Episode.fromname(f"{req.title} S{req.season:02d}E{req.episode:02d}")
        else:
            video = subliminal.Movie.fromname(req.title)

        # Convert language codes using fromietf (accepts both 'en' and 'eng')
        languages = set()
        for l in req.languages:
            try:
                languages.add(Language.fromietf(l))
            except Exception as e:
                logger.warning(f"Invalid language code '{l}': {e}")
        if not languages:
            # Fallback to English
            languages.add(Language.fromietf('en'))
            logger.info("No valid languages provided, falling back to English")

        # List subtitles from all providers
        try:
            subtitles = subliminal.list_subtitles([video], languages)[video]
        except Exception as e:
            logger.error(f"Error listing subtitles: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Subtitle listing failed: {str(e)}")

        results = []
        now = time.time()
        for sub in subtitles:
            try:
                # Compute score using the library's built‑in function
                raw_score = subliminal.compute_score(sub, video)

                # Normalise to 0‑1 if possible
                if scores and video.__class__.__name__ in scores:
                    max_score = scores[video.__class__.__name__]
                    norm_score = raw_score / max_score if max_score else 0.0
                else:
                    # Fallback: ratio of matched attributes
                    matches = sub.get_matches(video)
                    possible = len(subliminal.scores[video.__class__.__name__]) if hasattr(subliminal, 'scores') else 1
                    norm_score = len(matches) / possible if possible else 0.0

                # Safely get release_info and filename
                release = getattr(sub, 'release_info', '') or ''
                filename = getattr(sub, 'filename', None)

                item_id = f"{sub.provider_name}:{sub.id}"
                results.append(SubtitleItem(
                    id=item_id,
                    provider=sub.provider_name,
                    language=str(sub.language),
                    release=release,
                    score=norm_score,
                    filename=filename
                ))
                # Cache the subtitle object for later download
                subtitle_cache[item_id] = (sub, now + CACHE_TTL)
            except Exception as e:
                # Log and skip this subtitle so a single bad one doesn't break the response
                logger.warning(f"Skipping subtitle {sub.id} from {sub.provider_name}: {e}", exc_info=True)
                continue

        return results
    except HTTPException:
        # Re-raise HTTP exceptions as they are already handled
        raise
    except Exception as e:
        logger.error(f"Unexpected error in search_subtitles: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.get("/subliminal/download/{subtitle_id}")
async def download_subtitle(subtitle_id: str):
    # Check cache
    cached = subtitle_cache.get(subtitle_id)
    if cached is None:
        raise HTTPException(status_code=404, detail="Subtitle not found in cache (try searching again)")
    subtitle, expiry = cached
    if time.time() > expiry:
        del subtitle_cache[subtitle_id]
        raise HTTPException(status_code=404, detail="Cached subtitle expired (try searching again)")

    try:
        # Use the official download function to fetch the subtitle content
        # This works for all providers, unlike direct get_content()
        download_subtitles([subtitle])  # modifies subtitle in-place, adding 'content'

        if not hasattr(subtitle, 'content') or subtitle.content is None:
            raise Exception("Download did not produce content")

        # Content may be bytes; decode if needed
        content = subtitle.content
        if isinstance(content, bytes):
            content = content.decode('utf-8', errors='replace')

        return content
    except Exception as e:
        logger.error(f"Error downloading subtitle {subtitle_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Download failed: {str(e)}")
