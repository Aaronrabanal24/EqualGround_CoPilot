import os
import re
import json
import logging
import asyncio
import secrets
from pathlib import Path
from datetime import datetime, timedelta
from urllib.parse import urlencode
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from starlette.websockets import WebSocketState
from openai import AsyncOpenAI
from dotenv import load_dotenv
import websockets as ws_client

# Load environment variables (no-op on Render/production where env vars are injected)
load_dotenv(dotenv_path=".env.local", override=True)

# Structured logging
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("equalground")

# --------------- log helpers ---------------
_PII_PATTERN = re.compile(
    r'\b[\w.-]+@[\w.-]+\.\w+\b'           # email
    r'|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b' # US phone
    r'|\b\d{3}-\d{2}-\d{4}\b',            # SSN
)

def redact_pii(text: str) -> str:
    """Replace emails, phone numbers, and SSNs with [REDACTED]."""
    return _PII_PATTERN.sub("[REDACTED]", text)

def sanitize_for_log(text: str, max_len: int = 80) -> str:
    """Truncate and redact PII for safe logging."""
    clean = redact_pii(text)
    if len(clean) > max_len:
        return clean[:max_len] + "…"
    return clean

app = FastAPI()

# Validate required env vars on startup
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
COPILOT_API_KEY = os.getenv("COPILOT_API_KEY", "")

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")
if not DEEPGRAM_API_KEY:
    raise RuntimeError("DEEPGRAM_API_KEY is not set")
if not COPILOT_API_KEY:
    raise RuntimeError("COPILOT_API_KEY is not set")

client = AsyncOpenAI(api_key=OPENAI_API_KEY)

# Session tokens: token -> expiry (single-use, short-lived)
SESSION_TOKENS: dict[str, datetime] = {}


def extract_json_from_response(text: str) -> dict:
    """Try multiple strategies to parse JSON from LLM output."""
    # Strategy 1: Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: Extract first JSON object from mixed text
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    # Strategy 3: Return a safe fallback structure
    return {
        "error": "parse_failed",
        "raw": text[:500],
    }


# ---------------------------------------------------------
# LOAD KNOWLEDGE BASE FROM FILES
# ---------------------------------------------------------
KB_DIR = Path(__file__).parent / "knowledge"

def _load_kb(filename: str) -> dict:
    with open(KB_DIR / filename, "r") as f:
        return json.load(f)

KB_STAGES    = _load_kb("call_stages.json")
KB_BATTLES   = _load_kb("battlecards.json")
KB_PERSONAS  = _load_kb("personas.json")
KB_OBJECTIONS = _load_kb("objections.json")
KB_PRODUCT   = _load_kb("product.json")

# Build fast lookup maps
STAGES_BY_ID = {s["id"]: s for s in KB_STAGES["stages"]}
STAGE_ORDER  = [s["id"] for s in KB_STAGES["stages"]]

# ---------------------------------------------------------
# KEYWORD DETECTION HELPERS
# ---------------------------------------------------------
def _text_matches(text: str, phrases: list[str]) -> bool:
    """Check if any trigger phrase appears as a whole word in the text (case-insensitive)."""
    lower = text.lower()
    return any(
        re.search(r'\b' + re.escape(p.lower()) + r'\b', lower)
        for p in phrases
    )


def detect_competitor(text: str) -> dict | None:
    """Return the matching battlecard if a competitor is mentioned."""
    for key, card in KB_BATTLES["competitors"].items():
        if _text_matches(text, card["trigger_phrases"]):
            return card
    return None


def detect_objection(text: str) -> dict | None:
    """Return the matching objection playbook entry."""
    for key, obj in KB_OBJECTIONS["objections"].items():
        if _text_matches(text, obj["trigger_phrases"]):
            return obj
    return None


def detect_persona(text: str) -> dict | None:
    """Return the matching buyer persona."""
    for key, persona in KB_PERSONAS["personas"].items():
        if _text_matches(text, persona["trigger_phrases"]):
            return persona
    return None


# ---------------------------------------------------------
# CACHED PROMPT SECTIONS (built once at startup for OpenAI prompt caching)
# ---------------------------------------------------------
def _build_static_prefix() -> str:
    """Core identity + tone guardrails — identical across all calls."""
    product = KB_PRODUCT
    core = f"""You are a real-time Sales Intelligence Advisor for a YuJa EqualGround Account Executive.
You analyze the prospect's live speech and surface context, insights, and talking-point ideas so the rep can steer the conversation.

You are NOT a teleprompter. Do NOT write sentences for the rep to read. Instead, give the rep:
- What the prospect just revealed (their signal)
- Why it matters (context)
- 2-3 short talking-point ideas they can riff on naturally

You are ONLY hearing the PROSPECT'S audio. The rep glances at your output on a side panel during the call.

PRODUCT: {product['company']['elevator_pitch']}
KEY DIFFERENTIATORS:
- {product['unique_selling_points']['source_code_remediation']}
- {product['unique_selling_points']['deep_pdf_remediation']}
- {product['unique_selling_points']['autopilot']}

TITLE II DEADLINE: {product['title_ii_compliance']['deadline_large']} for entities over 50k population. {product['title_ii_compliance']['deadline_small']} for smaller entities. Non-compliance means DOJ lawsuits, investigations, and loss of federal funding."""

    tone = """

===== ADVISOR GUARDRAILS (CRITICAL) =====
1. Keep it scannable. The rep is mid-conversation — think bullet points, not paragraphs.
2. Focus on the PROSPECT. What did they just reveal? What does it mean? What angle should the rep explore?
3. Be specific to what they said. Generic advice like "build rapport" is useless. Reference their actual words.
4. If you detect a pain point, name it explicitly. If you detect a competitor, call it out.
5. Talking points should be IDEAS, not scripts. Short phrases the rep can naturally work into conversation.
6. Match urgency to the moment. If the prospect is about to leave, say so. If they're opening up, note the opportunity."""

    return core + tone


def _build_stage_sections() -> dict[str, str]:
    """Pre-build the stage-specific prompt section for each stage."""
    sections = {}
    for stage_id in STAGE_ORDER:
        stage = STAGES_BY_ID[stage_id]
        stage_idx = STAGE_ORDER.index(stage_id) + 1

        stage_section = f"""

===== CURRENT CALL STAGE: {stage['name']} ({stage['order']}/6) =====
GOAL: {stage['goal']}
INSTRUCTIONS: {stage['instructions']}

EXAMPLE — what good advice looks like at this stage:"""
        for ex in stage["few_shot"]:
            stage_section += f"""
  Prospect says: "{ex['prospect']}"
  -> prospect_signal: What they just revealed or implied
  -> talking_points: 2-3 short ideas the rep could use"""

        next_stage_name = STAGES_BY_ID[stage["transition_to"]]["name"] if stage["transition_to"] else "N/A (final stage)"
        stage_section += f"""

STAGE TRANSITION: Move to '{next_stage_name}' when ANY of these happen:"""
        for trigger in stage.get("transition_triggers", []):
            stage_section += f"\n  - {trigger}"
        stage_section += f"""
If you detect a transition, set 'stage' to '{stage.get('transition_to', stage_id)}' in your response. Otherwise keep 'stage' as '{stage_id}'."""

        pricing_section = ""
        if stage_id in ("PITCH", "CTA"):
            product = KB_PRODUCT
            pricing_section = f"""

===== PRICING (if asked) =====
{product['pricing']['talk_track']}
If pushed: {product['pricing']['if_pushed']}
Anchor: {product['pricing']['anchor']}"""

        output_rules = f"""

===== OUTPUT FORMAT =====
Respond ONLY with this JSON — nothing else:
{{
  "stage": "{stage_id}",
  "tactic": "SHORT UPPERCASE TACTIC NAME (e.g. PAIN POINT, COMPETITOR PIVOT, OBJECTION HANDLE)",
  "prospect_signal": "One sentence: what the prospect just revealed or implied",
  "insight": "One sentence: why this matters and what angle to take",
  "talking_points": ["short idea 1", "short idea 2", "short idea 3"],
  "objection_label": "short objection label OR null",
  "next_milestone": "What the rep should aim for next in one short sentence",
  "stage_progress": "{stage_idx}/6"
}}

RULES:
- 'prospect_signal' must reference what the prospect ACTUALLY said. Be specific.
- 'insight' is your strategic read — what's the opportunity or risk here?
- 'talking_points' must be 2-3 SHORT phrase ideas (not full sentences). Max 10 words each.
- If the prospect raises an objection, handle it in talking_points AND set objection_label.
- Update 'stage' ONLY when a transition trigger is met. Do not skip stages.
- 'next_milestone' should tell the rep what to aim for next."""

        sections[stage_id] = stage_section + pricing_section + output_rules

    return sections


# Build cached prompt parts at module load
STATIC_SYSTEM_PREFIX: str = _build_static_prefix()
STAGE_PROMPT_SECTIONS: dict[str, str] = _build_stage_sections()


def build_dynamic_context(recent_text: str) -> str:
    """Build per-utterance dynamic context (competitor/objection/persona detection)."""
    context_modules = ""

    competitor = detect_competitor(recent_text)
    if competitor:
        context_modules += f"""\n===== COMPETITOR DETECTED =====
THEIR FLAW: {competitor['their_flaw']}
OUR PIVOT: {competitor['our_pivot']}
EXAMPLE RESPONSES:"""
        for resp in competitor["example_responses"][:2]:
            context_modules += f'\n  - "{resp}"'

    objection = detect_objection(recent_text)
    if objection:
        context_modules += f"""\n===== OBJECTION DETECTED =====
TACTIC: {objection['tactic']}
CONTEXT: {objection.get('context', '')}
INSTRUCTIONS: {objection['instructions']}
EXAMPLE RESPONSES (use these as inspiration for talking points):"""
        for resp in objection["example_responses"][:3]:
            context_modules += f'\n  - "{resp}"'

    persona = detect_persona(recent_text)
    if persona:
        context_modules += f"""\n===== BUYER PERSONA DETECTED =====
THEME: {persona['theme']}
PIVOT TO: {persona['pivot_to']}
DISCOVERY QUESTIONS TO ASK:"""
        for q in persona["discovery_questions"][:2]:
            context_modules += f'\n  - "{q}"'

    return context_modules


# ---------------------------------------------------------
# SMART CONTEXT WINDOW
# ---------------------------------------------------------
def build_context_window(call_history: list) -> list:
    """Keep first 3 messages (intro context) + last 15 messages (recent context).
    This prevents losing who the DM is, their name, and role.
    Maps assistant_voice (rep's spoken words) to assistant role for OpenAI."""
    if len(call_history) <= 18:
        window = list(call_history)
    else:
        window = call_history[:3] + call_history[-15:]
    # Map assistant_voice to assistant role for OpenAI compatibility
    mapped = []
    for entry in window:
        if entry["role"] == "assistant_voice":
            mapped.append({"role": "assistant", "content": f"[Rep said aloud]: {entry['content']}"})
        else:
            mapped.append(entry)
    return mapped


# ---------------------------------------------------------
# STAGE ADVANCEMENT
# ---------------------------------------------------------
def advance_stage(current_stage: str, ai_stage: str) -> str:
    """Only allow forward stage movement (no skipping back)."""
    if ai_stage not in STAGE_ORDER:
        return current_stage
    current_idx = STAGE_ORDER.index(current_stage) if current_stage in STAGE_ORDER else 0
    ai_idx = STAGE_ORDER.index(ai_stage)
    # Allow moving forward by 1 stage, or staying
    if ai_idx == current_idx or ai_idx == current_idx + 1:
        return ai_stage
    # If AI tries to skip ahead, only advance by 1
    if ai_idx > current_idx + 1:
        return STAGE_ORDER[current_idx + 1]
    # Don't go backwards
    return current_stage


# ---------------------------------------------------------
# HEALTH CHECK ENDPOINT
# ---------------------------------------------------------
@app.get("/")
async def root():
    return {"status": "EqualGround AI Copilot Engine is Live and Running!"}


# ---------------------------------------------------------
# SESSION TOKEN EXCHANGE
# ---------------------------------------------------------
@app.post("/auth/session")
async def create_session(request: Request):
    api_key = request.headers.get("X-API-Key")
    if not COPILOT_API_KEY or api_key != COPILOT_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Purge expired tokens to prevent unbounded growth
    now = datetime.utcnow()
    expired = [t for t, exp in SESSION_TOKENS.items() if now > exp]
    for t in expired:
        del SESSION_TOKENS[t]

    token = secrets.token_urlsafe(32)
    SESSION_TOKENS[token] = now + timedelta(minutes=5)
    return {"session_token": token}


# ---------------------------------------------------------
# WEBSOCKET REAL-TIME ENGINE (DEEPGRAM BINARY AUDIO)
# ---------------------------------------------------------
@app.websocket("/ws/ui")
async def websocket_ui_endpoint(websocket: WebSocket):
    # --- Session Token Validation (BEFORE accept) ---
    token = websocket.query_params.get("token", "")
    expiry = SESSION_TOKENS.get(token)
    if not expiry or datetime.utcnow() > expiry:
        await websocket.close(code=4001)
        logger.warning("Rejected WebSocket: invalid or expired session token")
        return
    del SESSION_TOKENS[token]  # single-use

    await websocket.accept()
    call_history: list[dict] = []
    current_stage = "GATEKEEPER"
    dg_ws = None
    transcript_task = None
    dg_listener_task = None
    audio_mode = "mono"  # "mono" = mic-only, "stereo" = dual (mic+system)
    logger.info("Client connected to WebSocket")

    # ------ helper: process a final transcript from Deepgram ------
    async def _handle_transcript(user_text: str):
        nonlocal current_stage

        if not user_text.strip():
            return

        logger.debug("[%s] Prospect: %s", current_stage, sanitize_for_log(user_text))

        # Log prospect's speech (transcript already echoed by smart buffer)
        call_history.append({"role": "user", "content": user_text})

        # Build stage-aware prompt + smart context window
        # System message = static prefix + stage section (stable within same stage → OpenAI caches)
        system_prompt = STATIC_SYSTEM_PREFIX + STAGE_PROMPT_SECTIONS[current_stage]
        context = build_context_window(call_history)

        # Dynamic context (competitor/objection/persona) as separate user message
        dynamic_ctx = build_dynamic_context(user_text)
        messages = [{"role": "system", "content": system_prompt}]
        if dynamic_ctx:
            messages.append({"role": "user", "content": f"[LIVE CONTEXT]{dynamic_ctx}"})
        messages.extend(context)

        # --- DUAL MODEL: LIVE REFLEX PHASE (GPT-4o-mini) with retry ---
        guidance = None
        for attempt in range(3):
            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                response_format={"type": "json_object"},
            )

            ai_response_text = response.choices[0].message.content
            result = extract_json_from_response(ai_response_text)
            if result.get("error") != "parse_failed":
                guidance = result
                break
            logger.warning("  [retry %d/3] AI parse failed. Snippet: %s", attempt + 1, result['raw'][:100])

        if guidance is None:
            logger.error("  [SKIP] All retries exhausted for: %s", sanitize_for_log(user_text))
            return

        # Log AI advice to history
        call_history.append({"role": "assistant", "content": ai_response_text})
        if "objection_label" not in guidance:
            guidance["objection_label"] = None

        # Advance stage (enforced: forward only, max 1 step)
        ai_stage = guidance.get("stage", current_stage)
        current_stage = advance_stage(current_stage, ai_stage)
        guidance["stage"] = current_stage

        # Fill in defaults for new fields
        stage_idx = STAGE_ORDER.index(current_stage) + 1 if current_stage in STAGE_ORDER else 1
        if "stage_progress" not in guidance:
            guidance["stage_progress"] = f"{stage_idx}/6"
        if "next_milestone" not in guidance:
            guidance["next_milestone"] = STAGES_BY_ID[current_stage]["goal"]

        logger.info("  -> [%s] %s", guidance['tactic'], guidance.get('prospect_signal', ''))

        # Push to UI
        await websocket.send_json({
            "type": "navigation",
            "stage": guidance["stage"],
            "tactic": guidance.get("tactic", ""),
            "prospect_signal": guidance.get("prospect_signal", ""),
            "insight": guidance.get("insight", ""),
            "talking_points": guidance.get("talking_points", []),
            "objection_label": guidance.get("objection_label"),
            "next_milestone": guidance.get("next_milestone", ""),
            "stage_progress": guidance.get("stage_progress", ""),
        })

    # ------ helper: generate post-call summary ------
    async def _generate_summary():
        logger.info("Generating post-call summary using gpt-4o...")

        summary_prompt = (
            "Based on this call history, generate a CRM-ready summary with these sections:\n"
            "1. **Call Outcome**: One sentence — did we book a meeting, get a follow-up, or get rejected?\n"
            "2. **Prospect Info**: Name, title, organization (if mentioned)\n"
            "3. **Pain Points Uncovered**: Bullet points\n"
            "4. **Objections Raised**: Bullet points with how they were handled\n"
            "5. **Competitor Mentioned**: If any\n"
            "6. **Recommended Next Steps**: Specific actions with timeline\n"
            "7. **Call Stage Reached**: Which stage did the call get to?"
        )
        def _role_label(role: str) -> str:
            if role == "user":
                return "PROSPECT"
            if role == "assistant_voice":
                return "REP (spoken)"
            if role == "assistant":
                return "COPILOT"
            return role.upper()

        transcript_text = "\n".join(
            f"{_role_label(entry['role'])}: {entry['content']}" for entry in call_history
        )
        summary_messages = [
            {"role": "system", "content": summary_prompt},
            {"role": "user", "content": transcript_text},
        ]

        summary_response = await client.chat.completions.create(
            model="gpt-4o",
            messages=summary_messages,
        )

        final_summary = summary_response.choices[0].message.content

        # Format raw transcript
        formatted_transcript = (
            "\n\n=======================\n"
            "FULL TRANSCRIPT\n"
            "=======================\n\n"
        )
        for entry in call_history:
            if entry["role"] == "user":
                formatted_transcript += f"PROSPECT: {entry['content']}\n\n"
            elif entry["role"] == "assistant_voice":
                formatted_transcript += f"REP (spoken): {entry['content']}\n\n"
            elif entry["role"] == "assistant":
                try:
                    ai_dict = json.loads(entry["content"])
                    tactic = ai_dict.get("tactic", "")
                    signal = ai_dict.get("prospect_signal", "")
                    insight = ai_dict.get("insight", "")
                    points = ai_dict.get("talking_points", [])
                    formatted_transcript += f"COPILOT [{tactic}]: Signal: {signal} | Insight: {insight} | Points: {', '.join(points)}\n\n"
                except json.JSONDecodeError:
                    pass

        await websocket.send_json({
            "type": "summary",
            "text": final_summary + formatted_transcript,
        })

    try:
        # Send initial guidance
        stage = STAGES_BY_ID[current_stage]
        await websocket.send_json({
            "type": "navigation",
            "stage": current_stage,
            "tactic": "READY",
            "prospect_signal": "Waiting for prospect to speak...",
            "insight": stage["goal"],
            "talking_points": ["Ask for the person who handles website accessibility", "Mention ADA/Title II compliance", "Keep it short — don't pitch yet"],
            "objection_label": None,
            "next_milestone": stage["goal"],
            "stage_progress": "1/6",
        })

        # --- Connect to Deepgram's streaming WebSocket API ---
        # Deepgram params are configured based on audio_mode set by the client.
        # Default is mono (mic-only). Stereo (multichannel) is used when the
        # client sends system + mic audio as a 2-channel interleaved stream.
        dg_base_params = {
            "model": "nova-2",
            "language": "en-US",
            "smart_format": "true",
            "encoding": "linear16",
            "sample_rate": "16000",
            "interim_results": "true",
            "utterance_end_ms": "1500",
            "vad_events": "true",
        }

        async def _connect_deepgram():
            nonlocal dg_ws
            if audio_mode == "stereo":
                dg_base_params["channels"] = "2"
                dg_base_params["multichannel"] = "true"
            else:
                dg_base_params["channels"] = "1"

            dg_params = urlencode(dg_base_params)
            dg_url = f"wss://api.deepgram.com/v1/listen?{dg_params}"
            dg_headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

            logger.info("Connecting to Deepgram (mode=%s)...", audio_mode)
            try:
                dg_ws = await ws_client.connect(dg_url, additional_headers=dg_headers, proxy=None)
            except ws_client.exceptions.InvalidStatus as e:
                body = e.response.body.decode() if e.response.body else "no body"
                logger.error("Deepgram rejected: HTTP %s - %s", e.response.status_code, body)
                raise
            logger.info("Deepgram live WebSocket connected (channels=%s)", '2' if audio_mode == 'stereo' else '1')

        # Don't connect to Deepgram yet — wait for audio_mode message or first audio bytes
        dg_connected = False

        transcript_queue: asyncio.Queue[str | None] = asyncio.Queue()

        # --- Background task: read transcripts from Deepgram with smart buffering ---
        async def listen_to_deepgram():
            # In stereo mode, we maintain per-channel buffers.
            # Channel 0 = mic (Rep), Channel 1 = system (Prospect).
            # In mono mode, everything is channel 0 and labeled Prospect (legacy).
            prospect_buffer = ""
            rep_buffer = ""
            try:
                async for msg in dg_ws:
                    data = json.loads(msg)
                    if data.get("type") != "Results":
                        continue

                    channel_obj = data.get("channel", {})
                    alternatives = channel_obj.get("alternatives", [{}])
                    transcript = alternatives[0].get("transcript", "")
                    is_final = data.get("is_final", False)
                    speech_final = data.get("speech_final", False)
                    channel_index = data.get("channel_index", [0, 1])
                    ch = channel_index[0] if isinstance(channel_index, list) else 0

                    if audio_mode == "stereo":
                        # Channel 0 = mic (Rep), Channel 1 = system (Prospect)
                        is_prospect = (ch == 1)
                        speaker = "Prospect" if is_prospect else "You"
                    else:
                        # Mono mode: everything treated as Prospect (legacy behavior)
                        is_prospect = True
                        speaker = "Prospect"

                    if is_final and transcript:
                        if is_prospect:
                            prospect_buffer += transcript + " "
                        else:
                            rep_buffer += transcript + " "

                        # Send confirmed text to frontend for live display
                        if websocket.client_state == WebSocketState.CONNECTED:
                            await websocket.send_json({
                                "type": "transcript",
                                "speaker": speaker,
                                "text": transcript,
                            })

                    # "Speech Final" = speaker finished their thought
                    if speech_final:
                        if is_prospect and prospect_buffer.strip():
                            complete_thought = prospect_buffer.strip()
                            logger.debug("  PROSPECT UTTERANCE: %s", sanitize_for_log(complete_thought))
                            await transcript_queue.put(complete_thought)
                            prospect_buffer = ""
                        elif not is_prospect and rep_buffer.strip():
                            # Log rep speech to history for context, but don't trigger coaching
                            rep_text = rep_buffer.strip()
                            logger.debug("  REP UTTERANCE: %s", sanitize_for_log(rep_text))
                            call_history.append({"role": "assistant_voice", "content": rep_text})
                            rep_buffer = ""

                    # Interim results → send to frontend for live-typing effect
                    elif not is_final and transcript and is_prospect:
                        live_text = prospect_buffer + transcript
                        if websocket.client_state == WebSocketState.CONNECTED:
                            await websocket.send_json({
                                "type": "interim_update",
                                "text": live_text,
                            })

            except ws_client.exceptions.ConnectionClosed:
                logger.info("Deepgram connection closed")
            except Exception as e:
                logger.error("Deepgram listener error: %s", e)
            finally:
                # Flush any remaining buffered prospect text
                if prospect_buffer.strip():
                    await transcript_queue.put(prospect_buffer.strip())
                await transcript_queue.put(None)

        # --- Background task: drain transcript queue -> OpenAI ---
        async def process_transcripts():
            while True:
                text = await transcript_queue.get()
                if text is None:
                    break
                try:
                    if websocket.client_state == WebSocketState.CONNECTED:
                        await _handle_transcript(text)
                except Exception as e:
                    logger.error("Error processing transcript: %s", e)

        # --- Main loop: receive frames from browser ---
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                break

            # Binary audio frames -> forward to Deepgram
            if "bytes" in message and message["bytes"]:
                # Lazily connect to Deepgram on first audio frame
                if not dg_connected:
                    await _connect_deepgram()
                    dg_connected = True
                    dg_listener_task = asyncio.create_task(listen_to_deepgram())
                    transcript_task = asyncio.create_task(process_transcripts())
                await dg_ws.send(message["bytes"])

            # Text JSON commands (audio_mode, end_call, etc.)
            elif "text" in message and message["text"]:
                data = json.loads(message["text"])

                if data.get("type") == "audio_mode":
                    audio_mode = data.get("mode", "mono")
                    logger.info("Audio mode set to: %s", audio_mode)

                elif data.get("type") == "set_stage":
                    requested = data.get("stage", "")
                    if requested in STAGE_ORDER:
                        current_stage = requested
                        stage_idx = STAGE_ORDER.index(current_stage) + 1
                        stage_info = STAGES_BY_ID[current_stage]
                        logger.info("User manually set stage to: %s", current_stage)
                        await websocket.send_json({
                            "type": "navigation",
                            "stage": current_stage,
                            "tactic": "STAGE CHANGE",
                            "prospect_signal": f"Stage manually set to {stage_info['name']}",
                            "insight": stage_info["goal"],
                            "talking_points": [stage_info["instructions"][:80]],
                            "objection_label": None,
                            "next_milestone": stage_info["goal"],
                            "stage_progress": f"{stage_idx}/6",
                        })

                elif data.get("type") == "end_call":
                    await _generate_summary()
                    break

    except WebSocketDisconnect:
        logger.info("Client disconnected from WebSocket")
    except Exception as e:
        logger.error("Error in WebSocket: %s", e)
    finally:
        # Clean up Deepgram connection and background tasks
        if dg_ws:
            try:
                await dg_ws.close()
            except Exception:
                pass
        if transcript_task:
            await transcript_queue.put(None)
            transcript_task.cancel()
        if dg_listener_task:
            dg_listener_task.cancel()
        logger.info("WebSocket session ended")