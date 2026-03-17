from fastapi import APIRouter

from app.api.routes import config, events, token, transcripts

router = APIRouter()

router.include_router(token.router, tags=["token"])
router.include_router(config.router, tags=["config"])
router.include_router(events.router, tags=["events"])
router.include_router(transcripts.router, tags=["transcripts"])

