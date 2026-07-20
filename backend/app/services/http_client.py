"""Shared HTTP helpers with connection pooling (keep-alive).

Consolidates duplicated urllib.request helpers used for agent-bot, OpenAI, and F5.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

import httpx

_client_lock = threading.Lock()
_client: httpx.Client | None = None


class HttpClientError(Exception):
    """Raised for non-2xx responses or transport failures."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        body: str = "",
        reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.reason = reason


def agent_bot_base_url() -> str:
    return os.environ.get("AGENT_BOT_BASE_URL", "http://127.0.0.1:3001").rstrip("/")


def _get_client() -> httpx.Client:
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=httpx.Timeout(120.0, connect=10.0),
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=40),
                follow_redirects=True,
            )
        return _client


def close_http_client() -> None:
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None


def _raise_for_response(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    body = resp.text or ""
    raise HttpClientError(
        f"HTTP {resp.status_code}: {body[:500]}",
        status_code=resp.status_code,
        body=body,
    )


def post_json(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float = 30.0,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    try:
        resp = _get_client().post(url, json=payload, headers=hdrs, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise HttpClientError(f"Request timed out: {exc}", reason=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HttpClientError(f"Request failed: {exc}", reason=str(exc)) from exc
    _raise_for_response(resp)
    if not resp.content:
        return {}
    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise HttpClientError(f"Invalid JSON response: {resp.text[:200]}") from exc
    return data if isinstance(data, dict) else {"data": data}


def get_json(
    url: str,
    *,
    timeout: float = 10.0,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        resp = _get_client().get(url, headers=headers, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise HttpClientError(f"Request timed out: {exc}", reason=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HttpClientError(f"Request failed: {exc}", reason=str(exc)) from exc
    _raise_for_response(resp)
    if not resp.content:
        return {}
    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise HttpClientError(f"Invalid JSON response: {resp.text[:200]}") from exc
    return data if isinstance(data, dict) else {"data": data}


def post_bytes(
    url: str,
    payload: dict[str, Any],
    *,
    timeout: float = 120.0,
    headers: dict[str, str] | None = None,
) -> bytes:
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    try:
        resp = _get_client().post(url, json=payload, headers=hdrs, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise HttpClientError(f"Request timed out: {exc}", reason=str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HttpClientError(f"Request failed: {exc}", reason=str(exc)) from exc
    _raise_for_response(resp)
    return resp.content


def post_json_to_bot(
    path: str,
    payload: dict[str, Any],
    *,
    timeout: float = 10.0,
) -> dict[str, Any]:
    return post_json(f"{agent_bot_base_url()}{path}", payload, timeout=timeout)


def get_json_from_bot(path: str, *, timeout: float = 10.0) -> dict[str, Any]:
    return get_json(f"{agent_bot_base_url()}{path}", timeout=timeout)
