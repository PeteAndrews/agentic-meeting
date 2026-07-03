from app.services.meeting_recap_matcher import classify_recap_intent


def test_repeat_last_phrases():
    for text in (
        "Hi echo what did you just say",
        "Echo, can you repeat that",
        "echo say that again please",
        "Echo could you repeat what you said",
        "hey echo what was that again",
    ):
        assert classify_recap_intent(text) == "repeat_last", text


def test_summarize_phrases():
    for text in (
        "Echo can you summarise the meeting so far",
        "echo summarize what we discussed",
        "Echo give us a recap",
        "hey echo can you catch us up",
        "Echo what have we covered",
        "echo what has been decided so far",
    ):
        assert classify_recap_intent(text) == "summarize", text


def test_non_recap_questions_return_none():
    for text in (
        "Hi echo what hotel are we staying at",
        "Echo what time do we fly out",
        "echo tell me a story",
        "Echo are you there",
        "can you hear me echo",
        "",
    ):
        assert classify_recap_intent(text) is None, text


def test_repeat_takes_priority_over_summarize():
    # A repeat request mentioning the meeting should still be a repeat.
    assert classify_recap_intent("Echo repeat that summary") == "repeat_last"
