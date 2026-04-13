from fastapi import FastAPI, WebSocket
import asyncio
import json
import os
from openai import AsyncOpenAI
from dotenv import load_dotenv

# Load environment variables from .env.local
load_dotenv(".env.local")

app = FastAPI()

# Initialize OpenAI client
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    print("⚠️  WARNING: OPENAI_API_KEY not set. Using mock responses.")

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
        print(f"Error calling OpenAI: {e}")
        return {
            "current_stage": current_stage,
            "objection_label": None,
            "prospect_intent": "Error occurred",
            "next_script": "I apologize, let me refocus. Could you help me understand your role in digital accessibility?",
            "suggested_action": "Restart the discovery conversation.",
        }


@app.websocket("/ws/ui")
async def websocket_ui_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Frontend UI Connected!")

    # Initialize call state
    current_stage = "Stage 1: Gatekeeper"
    call_history = []

    try:
        # Send initial stage guidance (rep's opening)
        initial_guidance = {
            "type": "navigation",
            "current_stage": current_stage,
            "next_script": "Hi there! I was hoping you could point me in the right direction. Who handles your website accessibility and WCAG compliance?",
            "suggested_action": "Listen for who they suggest. If it's an admin, move to discovery. If it's not available, handle the gatekeeper response.",
        }
        await websocket.send_json(initial_guidance)
        print(
            f"Sent initial navigation: {current_stage}"
        )

        # Simulate a realistic prospect response with delay
        await asyncio.sleep(4)
        prospect_response_1 = "That would be John, but he's busy right now. Can you call back later?"
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_1,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_1}
        )

        # Get AI guidance based on prospect response
        initial_script = initial_guidance["next_script"]
        guidance_1 = await get_ai_response(
            current_stage,
            initial_script,
            prospect_response_1,
        )
        current_stage = guidance_1["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_1["current_stage"],
                "objection_label": guidance_1.get("objection_label"),
                "next_script": guidance_1["next_script"],
                "suggested_action": guidance_1["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

        # Second exchange: Rep responds to gatekeeper objection
        await asyncio.sleep(4)
        prospect_response_2 = "I mean, it could be important. What is this about exactly?"
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_2,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_2}
        )

        guidance_2 = await get_ai_response(
            current_stage,
            guidance_1["next_script"],
            prospect_response_2,
        )
        current_stage = guidance_2["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_2["current_stage"],
                "objection_label": guidance_2.get("objection_label"),
                "next_script": guidance_2["next_script"],
                "suggested_action": guidance_2["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

        # Third exchange: Prospect continues
        await asyncio.sleep(4)
        prospect_response_3 = "We're actually facing WCAG compliance issues right now."
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_3,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_3}
        )

        guidance_3 = await get_ai_response(
            current_stage,
            guidance_2["next_script"],
            prospect_response_3,
        )
        current_stage = guidance_3["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_3["current_stage"],
                "objection_label": guidance_3.get("objection_label"),
                "next_script": guidance_3["next_script"],
                "suggested_action": guidance_3["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

        # Fourth exchange: "We already have a platform" objection
        await asyncio.sleep(5)
        prospect_response_4 = "I appreciate that, but we already have a platform we use for this."
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_4,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_4}
        )

        guidance_4 = await get_ai_response(
            current_stage,
            guidance_3["next_script"],
            prospect_response_4,
        )
        current_stage = guidance_4["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_4["current_stage"],
                "objection_label": guidance_4.get("objection_label"),
                "next_script": guidance_4["next_script"],
                "suggested_action": guidance_4["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

        # Fifth exchange: "We don't have the budget" objection
        await asyncio.sleep(5)
        prospect_response_5 = "Even if I wanted to, we don't have the budget for anything new right now."
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_5,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_5}
        )

        guidance_5 = await get_ai_response(
            current_stage,
            guidance_4["next_script"],
            prospect_response_5,
        )
        current_stage = guidance_5["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_5["current_stage"],
                "objection_label": guidance_5.get("objection_label"),
                "next_script": guidance_5["next_script"],
                "suggested_action": guidance_5["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

        # Sixth exchange: "Website redesign" objection
        await asyncio.sleep(5)
        prospect_response_6 = "Plus, we're already in the middle of a full website redesign right now."
        await websocket.send_json(
            {
                "type": "transcript",
                "speaker": "Prospect",
                "text": prospect_response_6,
            }
        )
        call_history.append(
            {"speaker": "Prospect", "text": prospect_response_6}
        )

        guidance_6 = await get_ai_response(
            current_stage,
            guidance_5["next_script"],
            prospect_response_6,
        )
        current_stage = guidance_6["current_stage"]

        await asyncio.sleep(1)
        await websocket.send_json(
            {
                "type": "navigation",
                "current_stage": guidance_6["current_stage"],
                "objection_label": guidance_6.get("objection_label"),
                "next_script": guidance_6["next_script"],
                "suggested_action": guidance_6["suggested_action"],
            }
        )
        print(f"Sent navigation update: {current_stage}")

    except Exception as e:
        print(f"Frontend UI Disconnected: {e}")