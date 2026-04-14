import os
import json
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI
from dotenv import load_dotenv

# Load environment variables
load_dotenv(dotenv_path=".env.local", override=True)

app = FastAPI()
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

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
    """Check if any trigger phrase appears in the text (case-insensitive)."""
    lower = text.lower()
    return any(p.lower() in lower for p in phrases)


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
# DYNAMIC PROMPT BUILDER
# ---------------------------------------------------------
def build_system_prompt(stage_id: str, recent_text: str, call_history: list) -> str:
    """Compose a focused system prompt based on current call stage and context."""

    stage = STAGES_BY_ID.get(stage_id, STAGES_BY_ID["GATEKEEPER"])
    product = KB_PRODUCT

    # --- CORE IDENTITY (always included, ~200 tokens) ---
    core = f"""You are an elite, consultative Sales Copilot for a YuJa EqualGround Account Executive.
Your ONLY goal is to analyze the prospect's live speech and feed the sales rep the exact next sentence to say.

You are ONLY hearing the PROSPECT'S audio. The rep reads your output on a teleprompter — it must sound natural when spoken aloud.

PRODUCT: {product['company']['elevator_pitch']}
KEY DIFFERENTIATORS:
- {product['unique_selling_points']['source_code_remediation']}
- {product['unique_selling_points']['deep_pdf_remediation']}
- {product['unique_selling_points']['autopilot']}

TITLE II DEADLINE: {product['title_ii_compliance']['deadline_large']} for entities over 50k population. {product['title_ii_compliance']['deadline_small']} for smaller entities. Non-compliance means DOJ lawsuits, investigations, and loss of federal funding."""

    # --- CURRENT STAGE INSTRUCTIONS (always included) ---
    stage_section = f"""
===== CURRENT CALL STAGE: {stage['name']} ({stage['order']}/6) =====
GOAL: {stage['goal']}
INSTRUCTIONS: {stage['instructions']}
WORD LIMIT: Your 'say_this' MUST be under {stage['word_limit']} words. This is critical — the rep reads it live.

EXAMPLE DIALOGUE FOR THIS STAGE:"""
    for ex in stage["few_shot"]:
        stage_section += f"""
  Prospect: "{ex['prospect']}"
  -> say_this: "{ex['say_this']}" """

    # --- STAGE TRANSITION RULES ---
    next_stage_name = STAGES_BY_ID[stage["transition_to"]]["name"] if stage["transition_to"] else "N/A (final stage)"
    stage_section += f"""

STAGE TRANSITION: Move to '{next_stage_name}' when ANY of these happen:"""
    for trigger in stage.get("transition_triggers", []):
        stage_section += f"\n  - {trigger}"
    stage_section += f"""
If you detect a transition, set 'stage' to '{stage.get('transition_to', stage_id)}' in your response. Otherwise keep 'stage' as '{stage_id}'."""

    # --- CONTEXTUAL MODULES (loaded on demand) ---
    context_modules = ""

    # Competitor battlecard — only if competitor mentioned
    competitor = detect_competitor(recent_text)
    if competitor:
        context_modules += f"""

===== COMPETITOR DETECTED =====
THEIR FLAW: {competitor['their_flaw']}
OUR PIVOT: {competitor['our_pivot']}
EXAMPLE RESPONSES:"""
        for resp in competitor["example_responses"][:2]:
            context_modules += f'\n  - "{resp}"'

    # Objection playbook — only if objection detected
    objection = detect_objection(recent_text)
    if objection:
        context_modules += f"""

===== OBJECTION DETECTED =====
TACTIC: {objection['tactic']}
INSTRUCTIONS: {objection['instructions']}
EXAMPLE RESPONSES:"""
        for resp in objection["example_responses"][:2]:
            context_modules += f'\n  - "{resp}"'

    # Persona info — only if persona detected
    persona = detect_persona(recent_text)
    if persona:
        context_modules += f"""

===== BUYER PERSONA DETECTED =====
THEME: {persona['theme']}
PIVOT TO: {persona['pivot_to']}
DISCOVERY QUESTIONS TO ASK:"""
        for q in persona["discovery_questions"][:2]:
            context_modules += f'\n  - "{q}"'

    # --- PRICING (only in PITCH or CTA stages) ---
    pricing_section = ""
    if stage_id in ("PITCH", "CTA"):
        pricing_section = f"""

===== PRICING (if asked) =====
{product['pricing']['talk_track']}
If pushed: {product['pricing']['if_pushed']}
Anchor: {product['pricing']['anchor']}"""

    # --- TONE GUARDRAILS (always included) ---
    tone = """

===== TONE GUARDRAILS (CRITICAL) =====
1. Write exactly how a human talks on the phone. Use fragments. Start sentences with "So," "But," "Look," "Yeah."
2. NEVER use: "delve", "elevate", "navigate", "robust", "seamless", "synergy", "ensure", "leverage", "streamline".
3. No exclamation points. Calm, slightly detached, authoritative. You are a peer, not a salesperson.
4. BAD: "I completely understand your concern! Our platform offers a robust solution."
5. GOOD: "Makes sense. But how are you guys actually handling the Title II stuff right now?"
6. Match the prospect's energy. If they are brief, you are brief. If they open up, you can expand slightly."""

    # --- OUTPUT FORMAT (always included) ---
    stage_idx = STAGE_ORDER.index(stage_id) + 1 if stage_id in STAGE_ORDER else 1
    next_milestone = stage["goal"]
    output_rules = f"""

===== OUTPUT FORMAT =====
Respond ONLY with this JSON — nothing else:
{{
  "stage": "{stage_id}",
  "tactic": "SHORT UPPERCASE TACTIC NAME",
  "say_this": "The exact sentence the rep should say out loud (UNDER {stage['word_limit']} WORDS)",
  "objection_label": "short objection label OR null",
  "next_milestone": "What the rep should aim for next in one short sentence",
  "stage_progress": "{stage_idx}/6"
}}

RULES:
- 'say_this' MUST be under {stage['word_limit']} words. Count them.
- 'say_this' must sound natural when read aloud on a teleprompter.
- If the prospect raises an objection, handle it with the appropriate tactic AND set objection_label.
- Update 'stage' ONLY when a transition trigger is met. Do not skip stages.
- 'next_milestone' should tell the rep what to aim for next (e.g., "Confirm they handle accessibility", "Get them to mention their current tool")."""

    return core + stage_section + context_modules + pricing_section + tone + output_rules


# ---------------------------------------------------------
# SMART CONTEXT WINDOW
# ---------------------------------------------------------
def build_context_window(call_history: list) -> list:
    """Keep first 3 messages (intro context) + last 15 messages (recent context).
    This prevents losing who the DM is, their name, and role."""
    if len(call_history) <= 18:
        return list(call_history)
    return call_history[:3] + call_history[-15:]


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
# WEBSOCKET REAL-TIME ENGINE
# ---------------------------------------------------------
@app.websocket("/ws/ui")
async def websocket_ui_endpoint(websocket: WebSocket):
    await websocket.accept()
    call_history: list[dict] = []
    current_stage = "GATEKEEPER"
    print("Client connected to WebSocket")

    try:
        # Send initial guidance
        stage = STAGES_BY_ID[current_stage]
        await websocket.send_json({
            "type": "navigation",
            "stage": current_stage,
            "tactic": "READY",
            "say_this": stage["few_shot"][0]["say_this"],
            "objection_label": None,
            "next_milestone": stage["goal"],
            "stage_progress": "1/6",
        })

        async for message in websocket.iter_text():
            data = json.loads(message)

            # --- DUAL MODEL: SUMMARY PHASE (GPT-4o) ---
            if data.get("type") == "end_call":
                print("Generating post-call summary using gpt-4o...")

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
                transcript_text = "\n".join(
                    f"{entry['role']}: {entry['content']}" for entry in call_history
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
                    elif entry["role"] == "assistant":
                        try:
                            ai_dict = json.loads(entry["content"])
                            say_this = ai_dict.get("say_this", "")
                            tactic = ai_dict.get("tactic", "")
                            formatted_transcript += f"COPILOT [{tactic}]: {say_this}\n\n"
                        except json.JSONDecodeError:
                            pass

                await websocket.send_json({
                    "type": "summary",
                    "text": final_summary + formatted_transcript,
                })
                break

            # --- NORMAL LIVE CALL FLOW ---
            if data.get("type") == "transcript":
                user_text = data.get("text", "").strip()
                if not user_text:
                    continue

                print(f"[{current_stage}] Prospect: {user_text}")

                # Echo transcript back to UI
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "Prospect",
                    "text": user_text,
                })

                # Log prospect's speech
                call_history.append({"role": "user", "content": user_text})

                # Build stage-aware prompt + smart context window
                system_prompt = build_system_prompt(current_stage, user_text, call_history)
                context = build_context_window(call_history)
                messages = [{"role": "system", "content": system_prompt}] + context

                # --- DUAL MODEL: LIVE REFLEX PHASE (GPT-4o-mini) ---
                response = await client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=messages,
                    response_format={"type": "json_object"},
                )

                ai_response_text = response.choices[0].message.content

                # Log AI advice to history
                call_history.append({"role": "assistant", "content": ai_response_text})

                # Parse JSON response
                guidance = json.loads(ai_response_text)
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

                print(f"  -> [{guidance['tactic']}] {guidance['say_this']}")

                # Push to UI
                await websocket.send_json({
                    "type": "navigation",
                    "stage": guidance["stage"],
                    "tactic": guidance.get("tactic", ""),
                    "say_this": guidance["say_this"],
                    "objection_label": guidance.get("objection_label"),
                    "next_milestone": guidance.get("next_milestone", ""),
                    "stage_progress": guidance.get("stage_progress", ""),
                })

    except WebSocketDisconnect:
        print("Client disconnected from WebSocket")
    except Exception as e:
        print(f"Error in WebSocket: {e}")