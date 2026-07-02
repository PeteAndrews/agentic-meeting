from __future__ import annotations

from app.services.meeting_meta_matcher import find_meeting_meta_reply


def test_hearing_reply():
    assert find_meeting_meta_reply("Hi Echo can you hear me") == "Yes, I can hear you."


def test_presence_reply():
    assert find_meeting_meta_reply("Echo are you there") == "I'm here."


def test_hotel_excluded():
    assert find_meeting_meta_reply("Echo what hotel are we staying at") is None


def test_story_excluded():
    assert find_meeting_meta_reply("Echo tell me a story") is None


def test_greeting_reply():
    assert find_meeting_meta_reply("Echo, hello") == "Hi — I'm here on the line for my user."
