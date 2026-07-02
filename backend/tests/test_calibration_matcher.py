from app.domain.models import AgentProfile
from app.services.calibration_matcher import find_calibration_answer, is_proxy_identity_question


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


def test_user_name_does_not_match_hotel_calibration():
    profile = _trip_profile()
    hit = find_calibration_answer(profile, "Hi Echo can you tell me what your user name is")
    assert hit is None


def test_hotel_question_still_matches():
    profile = _trip_profile()
    hit = find_calibration_answer(profile, "Hi Echo what hotel are they staying at")
    assert hit is not None
    question, _answer = hit
    assert question.id == "q1"


def test_story_does_not_match_calibration():
    profile = _trip_profile()
    hit = find_calibration_answer(profile, "Echo, can you tell me a story?")
    assert hit is None


def test_proxy_identity_detector():
    assert is_proxy_identity_question("what is your user name")
    assert is_proxy_identity_question("who is your user")
    assert not is_proxy_identity_question("what hotel are they staying at")


def test_meeting_question_uses_meeting_answer_not_hotel_template():
    from app.services.agent_llm import template_calibration_speech

    spoken = template_calibration_speech(
        "Hi Echo when are we meeting tomorrow",
        "What time will we all meet in the hotel lobby on Day 2?",
        "we will meet at 10am",
        question_id="q3",
    )
    assert spoken == "We will meet at 10am."
    assert "staying at" not in spoken.casefold()
