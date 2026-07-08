from app.domain.models import AgentPrompt, AgentPromptStatus
from app.services.agent_llm import build_transcript_user_prompt, merge_meeting_transcript


def _demo_segments() -> list[dict]:
    return [
        {
            "role": "active",
            "participantId": "p-demo-B2",
            "text": "Hi Echo when are they arriving?",
            "startMs": 1_000,
            "endMs": 1_000,
            "isFinal": True,
        },
        {
            "role": "active",
            "participantId": "p-demo-B2",
            "text": "Echo where are they going for dinner?",
            "startMs": 3_000,
            "endMs": 3_000,
            "isFinal": True,
        },
        {
            "role": "active",
            "participantId": "p-demo-B2",
            "text": "Hi Echo can you summarize this meeting",
            "startMs": 5_000,
            "endMs": 5_000,
            "isFinal": True,
        },
    ]


def _prompt(prompt_id: str, text: str, updated_at: str) -> AgentPrompt:
    return AgentPrompt(
        id=prompt_id,
        roomName="am-demo-ha-trip",
        participantId="p-demo-C2-trip",
        kind="public_draft",
        text=text,
        status=AgentPromptStatus.SPOKEN,
        interventionNumber=0,
        source="known_calibration",
        createdAt=updated_at,
        updatedAt=updated_at,
    )


def _demo_prompts() -> list[AgentPrompt]:
    return [
        _prompt("prompt-arrival", "My user confirmed the team arrives at Heathrow at 8 p.m.", "1970-01-01T00:00:02+00:00"),
        _prompt("prompt-dinner", "My user says they are going to a Chinese restaurant in Soho.", "1970-01-01T00:00:04+00:00"),
        _prompt("prompt-later", "My user says we will go to Beijing on the 20th.", "1970-01-01T00:00:06+00:00"),
    ]


def test_merge_includes_echo_spoken_lines():
    segments = _demo_segments()
    prompts = _demo_prompts()
    merged, trigger_idx = merge_meeting_transcript(segments, prompts, trigger_index=2)

    assert len(merged) > len(segments)
    agent_lines = [s for s in merged if s.get("role") == "agent"]
    assert len(agent_lines) == 2
    assert any("Heathrow" in s["text"] for s in agent_lines)
    assert any("Soho" in s["text"] for s in agent_lines)
    assert not any("Beijing" in s["text"] for s in agent_lines)
    assert trigger_idx is not None
    assert merged[trigger_idx]["text"] == "Hi Echo can you summarize this meeting"


def test_summarize_prompt_includes_agent_and_participant_lines():
    segments = _demo_segments()
    prompts = _demo_prompts()
    merged, trigger_idx = merge_meeting_transcript(segments, prompts, trigger_index=2)
    transcript = build_transcript_user_prompt(merged, trigger_index=trigger_idx)

    assert "[active/p-demo-B2]" in transcript
    assert "[agent/echo]" in transcript
    assert "Heathrow" in transcript
    assert "Chinese restaurant" in transcript
    assert "Beijing" not in transcript
    assert "[TRIGGER]" in transcript
