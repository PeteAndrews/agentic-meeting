from unittest.mock import MagicMock, patch

import pytest

from app.domain.models import AgentProfile
from app.services.tts import TtsError, synthesize_speech
from app.services.tts_f5 import (
    DEFAULT_VOICE_SAMPLE_PASSAGE,
    resolve_ref_text,
    resample_pcm16,
)


def _clone_profile(**overrides) -> AgentProfile:
    base = AgentProfile(
        roomName="am-demo-ha-trip",
        participantId="p-demo-C2-trip-clone",
        voiceOutputMode="cloned_voice_tts",
        voiceSampleStored=True,
        voiceSamplePath="sample.webm",
        scenario="weekend_trip",
    )
    return base.model_copy(update=overrides)


def test_resolve_ref_text_from_scenario():
    profile = _clone_profile(scenario="weekend_trip")
    text = resolve_ref_text(profile)
    assert "weekend trip planning meeting" in text
    assert text != DEFAULT_VOICE_SAMPLE_PASSAGE


def test_resolve_ref_text_fallback_without_scenario():
    profile = _clone_profile(scenario=None)
    assert resolve_ref_text(profile) == DEFAULT_VOICE_SAMPLE_PASSAGE.strip()


def test_resample_pcm16_identity():
    pcm = b"\x00\x01" * 100
    assert resample_pcm16(pcm, 24_000, 24_000) == pcm


def test_resample_pcm16_changes_length():
    pcm = b"\x00\x01" * 100
    out = resample_pcm16(pcm, 24_000, 48_000)
    assert len(out) == 400


def test_synthesize_speech_clone_requires_profile():
    with pytest.raises(TtsError, match="profile required"):
        synthesize_speech("hello", voice_mode="cloned_voice_tts")


@patch("app.services.tts_f5.synthesize_f5_clone")
def test_synthesize_speech_routes_clone(mock_clone):
    profile = _clone_profile()
    mock_clone.return_value = (b"\x00\x01", 24_000)
    pcm, rate = synthesize_speech("hello", voice_mode="cloned_voice_tts", profile=profile)
    assert pcm == b"\x00\x01"
    assert rate == 24_000
    mock_clone.assert_called_once()


@patch("app.services.tts_f5._post_f5_synthesize")
@patch("app.services.tts_f5.ensure_ref_wav")
@patch("app.services.tts_f5.resolve_voice_sample_path")
def test_synthesize_f5_clone_calls_sidecar(mock_sample, mock_wav, mock_post):
    from app.services.tts_f5 import synthesize_f5_clone

    profile = _clone_profile()
    mock_sample.return_value = MagicMock()
    mock_wav.return_value = MagicMock()
    mock_post.return_value = (b"\x00\x01" * 240, 24_000)

    pcm, rate = synthesize_f5_clone("Meeting update.", profile=profile)
    assert rate == 24_000
    assert len(pcm) > 0
    mock_post.assert_called_once()
