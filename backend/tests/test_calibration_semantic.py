from unittest.mock import patch

from app.domain.models import AgentProfile
from app.services.calibration_matcher import resolve_calibration_answer


def _trip_profile() -> AgentProfile:
    return AgentProfile(
        roomName="am-demo-ha-trip",
        participantId="p-demo-C2-trip-male",
        voiceOutputMode="generic_tts",
        voiceSampleStored=False,
        scenario="weekend_trip",
        droppedQuestionIndex=2,
        calibrationAnswers={
            "q0": "8pm",
            "q1": "The meridian at Leicester square",
            "q3": "we will meet at 10am",
            "q4": "flight simulator",
        },
        calibrationCompletedAt="2026-07-02T19:20:16.776147+00:00",
    )


@patch("app.services.agent_llm.infer_calibration_question_id")
def test_event_tomorrow_resolves_via_semantic_inference(mock_infer):
    mock_infer.return_value = "q4"
    profile = _trip_profile()
    hit = resolve_calibration_answer(profile, "Hi echo what is the event tomorrow")
    assert hit is not None
    question, answer, method = hit
    assert question.id == "q4"
    assert answer == "flight simulator"
    assert method == "semantic"
    mock_infer.assert_called_once()


@patch("app.services.agent_llm.infer_calibration_question_id")
def test_activity_plan_still_uses_keyword_match(mock_infer):
    profile = _trip_profile()
    hit = resolve_calibration_answer(profile, "Hi echo what is the activity plan for tomorrow")
    assert hit is not None
    question, _answer, method = hit
    assert question.id == "q4"
    assert method == "keyword"
    mock_infer.assert_not_called()
