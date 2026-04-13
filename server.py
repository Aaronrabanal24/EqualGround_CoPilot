from fastapi import FastAPI, WebSocket
import asyncio
import json
import os
from openai import AsyncOpenAI
from dotenv import load_dotenv

# Explicitly load .env.local and override any existing env vars
load_dotenv(dotenv_path=".env.local", override=True)

app = FastAPI()

# Initialize OpenAI client using os.environ.get
api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    print("WARNING: OPENAI_API_KEY not set. AI responses will be disabled.")
else:
    print(f"OpenAI API key loaded successfully (ends in ...{api_key[-4:]})")

client = AsyncOpenAI(api_key=api_key) if api_key else None

# ─────────────────────────────────────────────────────────────────
# v4.1 Master Prompt — AI uses playbook as a guide, never verbatim
# ─────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are an elite, real-time sales copilot for 'YuJa EqualGround', a premier digital accessibility and WCAG governance platform.

Your Ultimate Goal: Book a 45-minute demo (30 min walkthrough, 15 min Q&A).

The Opening Hook:
Guide the rep to start with the Title II compliance scan angle.

Adaptive Objection Handling Playbook:
Use the following strategies as your foundation. DO NOT output them word-for-word. Dynamically adapt the phrasing to match the exact context of the prospect's sentence, keeping it conversational, punchy, and natural.

'We already have a platform': Acknowledge it, remove the pressure to buy today, and position the 30-minute demo as a way to see how EqualGround is more efficient/cheaper for when future compliance talks happen.

'No budget': Agree that today isn't about budget. Pivot to the urgency of Title II/DOJ changes, and position the demo as giving them knowledge to keep in their 'back pocket' for when budget does open up.

'In a website redesign': Frame the redesign as the perfect time to look at this. Highlight that building compliance in from day one is cheaper than fixing it later.

Respond ONLY with a strict JSON object — no markdown, no extra text:

CRITICAL: Keep your 'next_script' under 20 words. The rep needs to read this while talking, so keep it punchy, conversational, and direct. No fluff.

{
  "current_stage": "Stage X: [Gatekeeper | Discovery | Problem Confirmation | Solution Positioning | Objection Handling | Closing]",
  "objection_label": "Short label describing the objection if the prospect raised one, otherwise null",
  "prospect_intent": "One sentence describing what the prospect really means",
  "next_script": "Adaptive, natural, conversational response for the rep to say next",
  "suggested_action": "One tactical action tip for the rep"
}"""


async def get_ai_response(current_stage: str, rep_message: str, prospect_response: str) -> dict:
    """Get AI-generated guidance. All responses — including objections — go through OpenAI."""

    if not client:
        return {
            "current_stage": "Stage 1: Gatekeeper",
            "objection_label": None,
            "prospect_intent": "No API key configured",
            "next_script": "Set your OPENAI_API_KEY in .env.local to get live AI guidance.",
            "suggested_action": "Add a valid OpenAI API key to .env.local and restart the backend.",
        }

    try:
        user_message = f"""Current Stage: {current_stage}
Sales Rep's Last Message: {rep_message}
Prospect's Response: {prospect_response}

Generate the next coaching response for the rep."""

        print(f"ATTEMPTING TO CALL OPENAI WITH TEXT: {prospect_response}")

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            temperature=0.7,
        )

        response_text = response.choices[0].message.content.strip()
        if response_text.startswith("```"):
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:]
            response_text = response_text.strip()

        result = json.loads(response_text)
        if "objection_label" not in result:
            result["objection_label"] = None
        print(f"AI response for stage: {result.get('current_stage')} | objection: {result.get('objection_label')}")
        return result
    except Exception as e:
        print(f"ERROR calling OpenAI — type: {type(e).__name__} | detail: {e}")
        return {
            "current_stage": current_stage,
            "objection_label": None,
            "prospect_intent": "Error occurred",
            "next_script": "I apologize, let me refocus. Could you help me understand your role in digital accessibility?",
            "suggested_action": "Restart the discovery conversation.",
        }


SUMMARY_PROMPT = """You are an executive sales assistant. Read the following sales call transcript and generate a concise CRM-ready summary with exactly three sections:

1. **Pain Points Discovered** — What problems or challenges did the prospect mention?
2. **Objections Raised** — What pushback or concerns did the prospect voice?
3. **Recommended Next Steps** — Based on the conversation, what should the rep do next?

Keep each section to 1-3 bullet points. Be specific, reference what the prospect actually said."""


async def generate_summary(call_history: list[dict]) -> str:
    """Send the full call transcript to OpenAI and get a CRM summary."""
    if not client:
        return "No OpenAI API key configured — unable to generate summary."

    transcript_text = "\n".join(
        f"{entry['speaker']}: {entry['text']}" for entry in call_history
    )

    try:
        print(f"Generating post-call summary from {len(call_history)} messages...")
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SUMMARY_PROMPT},
                {"role": "user", "content": transcript_text},
            ],
            temperature=0.5,
        )
        summary = response.choices[0].message.content.strip()
        print("Post-call summary generated successfully.")
        return summary
    except Exception as e:
        print(f"ERROR generating summary — type: {type(e).__name__} | detail: {e}")
        return f"Error generating summary: {e}"


@app.websocket("/ws/ui")
async def websocket_ui_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend UI Connected! Listening for real microphone data...")

    # Initialize call state
    current_stage = "Stage 1: Gatekeeper"
    current_script = "Hi there! I was hoping you could point me in the right direction. Who handles your website accessibility and WCAG compliance?"
    call_history: list[dict] = []

    try:
        # Send initial stage guidance
        await websocket.send_json({
            "type": "navigation",
            "current_stage": current_stage,
            "objection_label": None,
            "next_script": current_script,
            "suggested_action": "Wait for the prospect to answer, then listen closely for who they name."
        })

        # Live loop — waits indefinitely for real microphone input from the frontend
        async for message in websocket.iter_text():
            data = json.loads(message)

            if data.get("type") == "end_call":
                print("End Call received — generating summary...")
                summary_text = await generate_summary(call_history)
                await websocket.send_json({
                    "type": "summary",
                    "text": summary_text,
                })
                break

            if data.get("type") == "transcript":
                prospect_text = data.get("text", "").strip()
                if not prospect_text:
                    continue
                print(f"Received from Microphone: {prospect_text}")

                # Record to call history
                call_history.append({"speaker": "Prospect", "text": prospect_text})

                # Send the spoken text back to the transcript panel
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "Prospect",
                    "text": prospect_text,
                })

                # Get AI guidance for this live input
                guidance = await get_ai_response(current_stage, current_script, prospect_text)

                # Record the rep's suggested script to history too
                call_history.append({"speaker": "Rep (AI Suggested)", "text": guidance["next_script"]})

                # Update running state
                current_stage = guidance["current_stage"]
                current_script = guidance["next_script"]

                # Push AI coaching back to the UI
                await websocket.send_json({
                    "type": "navigation",
                    "current_stage": guidance["current_stage"],
                    "objection_label": guidance.get("objection_label"),
                    "next_script": guidance["next_script"],
                    "suggested_action": guidance["suggested_action"],
                })

    except Exception as e:
        print(f"Frontend UI Disconnected: {e}")