"""Smoke tests for the EqualGround backend."""

import os
import sys

# Ensure the project root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Provide dummy env vars before importing server (which validates them at module level)
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPGRAM_API_KEY", "test-key")
os.environ.setdefault("COPILOT_API_KEY", "test-key")

import pytest
from httpx import ASGITransport, AsyncClient

from server import app, extract_json_from_response, _text_matches


# ------------------------------------------------------------------
# Health endpoint
# ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/")
    assert resp.status_code == 200
    assert "status" in resp.json()


# ------------------------------------------------------------------
# Auth rejects bad key
# ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_auth_rejects_invalid_key():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/auth/session", headers={"X-API-Key": "wrong"})
    assert resp.status_code == 401


# ------------------------------------------------------------------
# JSON extraction fallback
# ------------------------------------------------------------------
def test_json_extraction_direct():
    result = extract_json_from_response('{"tactic": "OPENER"}')
    assert result["tactic"] == "OPENER"


def test_json_extraction_wrapped():
    result = extract_json_from_response('Here is the JSON: {"tactic": "OPENER"} done')
    assert result["tactic"] == "OPENER"


def test_json_extraction_failure():
    result = extract_json_from_response("no json here")
    assert result.get("error") == "parse_failed"


# ------------------------------------------------------------------
# Trigger matching (word-boundary)
# ------------------------------------------------------------------
def test_text_matches_exact():
    assert _text_matches("We use AudioEye for that", ["audioeye"])


def test_text_matches_no_partial():
    # "IT" should not match inside "commit" or "situation"
    assert not _text_matches("This is a great situation", ["IT"])


def test_text_matches_standalone():
    assert _text_matches("I need to check with IT first", ["IT"])
