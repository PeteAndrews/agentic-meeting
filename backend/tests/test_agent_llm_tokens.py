from app.services.agent_llm import apply_completion_token_limit


def test_gpt5_uses_max_completion_tokens():
    payload: dict = {}
    apply_completion_token_limit(payload, "gpt-5-nano")
    assert "max_completion_tokens" in payload
    assert "max_tokens" not in payload


def test_gpt4_uses_max_tokens():
    payload: dict = {}
    apply_completion_token_limit(payload, "gpt-4o-mini")
    assert "max_tokens" in payload
    assert "max_completion_tokens" not in payload
