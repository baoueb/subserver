from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import subliminal
from babelfish import Language

app = FastAPI()

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

@app.post("/subliminal/search", response_model=List[SubtitleItem])
async def search_subtitles(req: SearchRequest):
    # Build video object
    if req.season is not None and req.episode is not None:
        video = subliminal.Episode.fromname(f"{req.title} S{req.season:02d}E{req.episode:02d}")
    else:
        video = subliminal.Movie.fromname(req.title)

    languages = {Language(l) for l in req.languages}

    # List subtitles from all providers
    subtitles = subliminal.list_subtitles([video], languages)[video]

    results = []
    for sub in subtitles:
        # Compute score (0-1)
        matches = sub.get_matches(video)
        score = sum(1 for m in matches) / len(subliminal.scores[video.__class__.__name__])
        results.append(SubtitleItem(
            id=f"{sub.provider_name}:{sub.id}",
            provider=sub.provider_name,
            language=str(sub.language),
            release=sub.release_info or "",
            score=score,
            filename=getattr(sub, "filename", None)
        ))
    return results

@app.get("/subliminal/download/{subtitle_id}")
async def download_subtitle(subtitle_id: str):
    provider_name, sub_id = subtitle_id.split(":", 1)
    # This is simplified – you'll need to re‑fetch the subtitle
    # or implement a cache. For a real service, consider storing
    # the subtitle object temporarily.
    raise NotImplementedError("Implement download logic using subliminal")
