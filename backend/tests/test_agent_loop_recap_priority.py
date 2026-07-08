from app.domain.models import AgentProfile
from app.services import agent_loop


def test_summarize_request_takes_priority_over_calibration(monkeypatch):
    profile = AgentProfile(
        roomName="am-demo-ha-trip",
        participantId="p-demo-C2-trip-clone",
        scenario="weekend_trip",
        calibrationCompletedAt="2026-07-08T12:34:18+00:00",
        voiceOutputMode="cloned_voice_tts",
        voiceSampleStored=True,
        voiceSamplePath="sample.webm",
    )
    segments = [
        {
            "participantId": "p-demo-A2",
            "role": "moderator",
            "text": "Echo can you summarize the whole meeting",
            "startMs": 1_000,
            "endMs": 1_000,
            "isFinal": True,
        }
    ]
    spoken = "We discussed arrivals, dinner, and the plan for tomorrow."

    monkeypatch.setattr(agent_loop, "find_proxy_profile_for_room", lambda _room: profile)
    monkeypatch.setattr(agent_loop, "has_open_prompt", lambda _room: False)
    monkeypatch.setattr(agent_loop, "_load_final_segments", lambda _room: segments)
    monkeypatch.setattr(agent_loop, "_should_process", lambda _room, _segments: True)
    monkeypatch.setattr(agent_loop, "summarize_meeting_so_far", lambda *_args, **_kwargs: spoken)
    monkeypatch.setattr(
        agent_loop,
        "resolve_calibration_answer",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("calibration should not run")),
    )

    captured = {}

    def fake_auto_speak(room_name, used_profile, **kwargs):
        captured["room_name"] = room_name
        captured["profile"] = used_profile
        captured.update(kwargs)
        return None

    monkeypatch.setattr(agent_loop, "_auto_speak_prompt", fake_auto_speak)

    agent_loop.process_transcript_update("am-demo-ha-trip")

    assert captured["spoken"] == spoken
    assert captured["source"] == "meeting_recap"
    assert captured["event_payload"] == {"recapKind": "summarize"}
