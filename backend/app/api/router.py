from fastapi import APIRouter

from app.api.routes import agent, agent_profile, agent_prompts, config, events, scenarios, stt, token, transcripts

router = APIRouter()

router.include_router(token.router, tags=["token"])
router.include_router(config.router, tags=["config"])
router.include_router(events.router, tags=["events"])
router.include_router(transcripts.router, tags=["transcripts"])
router.include_router(stt.router, tags=["stt"])
router.include_router(scenarios.router, tags=["scenarios"])
router.include_router(agent.router, tags=["agent"])
router.include_router(agent_profile.router, tags=["agent-profile"])
router.include_router(agent_prompts.router, tags=["agent-prompts"])

