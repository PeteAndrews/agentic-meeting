import json
from pathlib import Path

from app.domain.models import AgentProfile, AgentPrompt, AgentPromptStatus
from app.services.agent_llm import build_transcript_user_prompt, merge_meeting_transcript


def _load_demo_segments() -> list[dict]:
    path = Path(__file__).resolve().parents[1] / "data" / "transcripts" / "am-demo-ha-trip.segments.jsonl"
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def _load_demo_prompts() -> list[AgentPrompt]:
    path = Path(__file__).resolve().parents[1] / "data" / "agent_prompts" / "am-demo-ha-trip.prompts.jsonl"
    prompts = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            prompts.append(AgentPrompt.model_validate(json.loads(line)))
    return prompts


def test_merge_includes_echo_spoken_lines():
    segments = _load_demo_segments()[:6]
    prompts = _load_demo_prompts()
    merged, trigger_idx = merge_meeting_transcript(segments, prompts, trigger_index=5)

    assert len(merged) > len(segments)
    agent_lines = [s for s in merged if s.get("role") == "agent"]
    assert len(agent_lines) >= 4
    assert any("Heathrow" in s["text"] for s in agent_lines)
    assert any("Soho" in s["text"] for s in agent_lines)
    assert trigger_idx is not None
    assert merged[trigger_idx]["text"] == "Hi Echo can you summarize this meeting"


def test_summarize_prompt_includes_agent_and_participant_lines():
    segments = _load_demo_segments()[:6]
    prompts = _load_demo_prompts()
    merged, trigger_idx = merge_meeting_transcript(segments, prompts, trigger_index=5)
    transcript = build_transcript_user_prompt(merged, trigger_index=trigger_idx)

    assert "[active/p-demo-B2]" in transcript
    assert "[agent/echo]" in transcript
    assert "Heathrow" in transcript
    assert "Chinese restaurant" in transcript
    assert "Beijing" not in transcript
    assert "[TRIGGER]" in transcript
