from app.services.agent_trigger import (
    contains_trigger,
    resolve_trigger_phrases,
)


def _phrases(monkeypatch, extra: str | None = None) -> list[str]:
    if extra is None:
        monkeypatch.delenv("AGENT_TRIGGER_ALIASES_EXTRA", raising=False)
    else:
        monkeypatch.setenv("AGENT_TRIGGER_ALIASES_EXTRA", extra)
    monkeypatch.setenv("AGENT_TRIGGER_PHRASES", "echo")
    return resolve_trigger_phrases(None)


def test_default_aliases_include_new_stt_variants(monkeypatch):
    phrases = _phrases(monkeypatch)
    lowered = {p.casefold() for p in phrases}
    assert {"echo", "eko", "eco", "ekko", "ecco", "hecho", "ako", "ayako", "aiko"} <= lowered


def test_ako_and_ayako_trigger(monkeypatch):
    phrases = _phrases(monkeypatch)
    assert contains_trigger("Ako what is the plan tomorrow", phrases)
    assert contains_trigger("Hi Ayako when are we meeting", phrases)
    assert contains_trigger("hey aiko are we still on for 10", phrases)


def test_extra_aliases_env_override(monkeypatch):
    phrases = _phrases(monkeypatch, extra="akko, echoe")
    lowered = {p.casefold() for p in phrases}
    assert "akko" in lowered
    assert "echoe" in lowered
    assert contains_trigger("Akko what hotel are we staying at", phrases)


def test_extra_aliases_empty_env(monkeypatch):
    phrases = _phrases(monkeypatch, extra="")
    assert contains_trigger("Echo what hotel", phrases)


def test_non_trigger_words_do_not_match(monkeypatch):
    phrases = _phrases(monkeypatch)
    assert not contains_trigger("I think we should book the hotel now", phrases)
    assert not contains_trigger("my vote is for the flight simulator", phrases)
