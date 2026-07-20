from pathlib import Path
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import router as api_router
from app.services.http_client import close_http_client

_env_path = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(_env_path)

logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not os.environ.get("OPENAI_API_KEY", "").strip():
        logger.warning(
            "OPENAI_API_KEY is not set — Echo LLM and TTS will fail. "
            "Copy backend/.env.example to backend/.env and add your key, then restart."
        )
    elif not _env_path.exists():
        logger.info("OPENAI_API_KEY loaded from environment (no backend/.env file).")
    yield
    close_http_client()


app = FastAPI(title="Agentic Meeting Backend", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://www.uib-study.com",
        "https://uib-study.com",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")
