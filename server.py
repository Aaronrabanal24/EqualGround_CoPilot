import os
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI
from dotenv import load_dotenv

# Load environment variables
load_dotenv(dotenv_path=".env.local", override=True)

app = FastAPI()
client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# ---------------------------------------------------------
# THE MASTER CONSULTATIVE PROMPT
# ---------------------------------------------------------
SYSTEM_PROMPT = """You are an elite, consultative Sales Copilot for a YuJa EqualGround Account Executive.
Your ONLY goal is to analyze the live transcript, act as a business problem-solver, and feed the sales rep the exact next sentence to say to keep the prospect talking.

You are NOT a message reader. You are a DYNAMIC FRAMEWORK designed to facilitate a two-way collaborative discussion, uncover pain, and convert. You are ONLY listening to the PROSPECT'S audio.

CONTEXT - YUJA EQUALGROUND:
- Product: Digital accessibility software (crucial for Title II compliance).
- Value Prop: Automates compliance, deep scans PDFs and web pages, prevents costly lawsuits.

THE DYNAMIC PLAYBOOK:
1. IF PROSPECT GIVES A COLD/SHORT ANSWER:
   -> Tactic: PEEL THE ONION
   -> Response: Acknowledge, then ask an open-ended question.
2. IF PROSPECT ASKS A DIRECT QUESTION:
   -> Tactic: ANSWER, THEN DEFLECT
   -> Response: Give a brief 1-sentence answer, then immediately hand the mic back.
3. IF PROSPECT SAYS "We are doing a website redesign":
   -> Tactic: PIVOT TO TIMING
   -> Response: "Perfect timing. It's actually much easier to build accessibility in *during* the redesign. Who is handling that?"
4. IF PROSPECT SAYS "We already use a competitor":
   -> Tactic: CONSULTATIVE GAP FINDING
   -> Response: "Great platform. Most folks using them still struggle with deep PDF remediation. How are you handling your PDFs?"

TONE AND VOICE GUARDRAILS (CRITICAL):
1. Write exactly how human beings speak, not how they write.
2. Use fragments. Start sentences with "So," "But," or "Look."
3. NEVER use generic AI words like: "delve", "elevate", "navigate", "robust", "seamless", "synergy", or "ensure".
4. Do not be overly enthusiastic. No exclamation points. Act calm, slightly detached, and authoritative.
5. Bad Example: "I completely understand your concern! However, our platform offers a robust solution for that."
6. Good Example: "Makes sense. But how are you guys actually handling the Title II stuff right now?"

CRITICAL RULES FOR OUTPUT:
1. The rep is reading your output LIVE on a teleprompter.
2. The 'say_this' field MUST be conversational, direct, and STRICTLY UNDER 15 WORDS. Zero fluff.
3. You must respond ONLY with this exact JSON structure:
{
  "stage": "Identify stage (e.g., Hook, Discovery, Objection)",
  "tactic": "SHORT UPPERCASE ACTION (e.g., PEEL THE ONION)",
  "say_this": "The exact sentence to read out loud",
  "objection_label": "Short objection label if one was raised, otherwise null"
}"""

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
    call_history = []
    current_stage = "Gatekeeper"
    current_script = "Hi. Who handles your website accessibility and WCAG compliance?"
    print("Client connected to WebSocket")

    try:
        # Send initial stage guidance
        await websocket.send_json({
            "type": "navigation",
            "stage": current_stage,
            "tactic": "Open the Call",
            "say_this": current_script,
            "objection_label": None,
        })

        async for message in websocket.iter_text():
            data = json.loads(message)

            # --- DUAL MODEL: SUMMARY PHASE (GPT-4o) ---
            if data.get("type") == "end_call":
                print("Generating post-call summary using gpt-4o...")

                summary_prompt = "Based on this call history, generate a CRM-ready summary with 3 bullet points: Pain Points, Objections Raised, and Recommended Next Steps."
                transcript_text = "\n".join(
                    f"{entry['role']}: {entry['content']}" for entry in call_history
                )
                summary_messages = [
                    {"role": "system", "content": summary_prompt},
                    {"role": "user", "content": transcript_text},
                ]

                summary_response = await client.chat.completions.create(
                    model="gpt-4o",  # The Heavyweight model for deep analysis
                    messages=summary_messages
                )

                final_summary = summary_response.choices[0].message.content

                await websocket.send_json({
                    "type": "summary",
                    "text": final_summary,
                })
                break

            # --- NORMAL LIVE CALL FLOW ---
            if data.get("type") == "transcript":
                user_text = data.get("text", "").strip()
                if not user_text:
                    continue

                print(f"Received from Microphone: {user_text}")

                # Echo transcript back to the UI
                await websocket.send_json({
                    "type": "transcript",
                    "speaker": "Prospect",
                    "text": user_text,
                })

                # Log the prospect's speech
                call_history.append({"role": "user", "content": user_text})

                # SLIDING WINDOW: Keep prompt + only the last 10 messages for speed
                recent_context = call_history[-10:]
                messages = [{"role": "system", "content": SYSTEM_PROMPT}] + recent_context

                # --- DUAL MODEL: LIVE REFLEX PHASE (GPT-4o-mini) ---
                response = await client.chat.completions.create(
                    model="gpt-4o-mini",  # The Lightweight model for split-second reflexes
                    messages=messages,
                    response_format={"type": "json_object"}  # Strict JSON Lock
                )

                ai_response_text = response.choices[0].message.content

                # Log the AI's advice to the history
                call_history.append({"role": "assistant", "content": ai_response_text})

                # Parse the JSON response
                guidance = json.loads(ai_response_text)
                if "objection_label" not in guidance:
                    guidance["objection_label"] = None

                # Update running state
                current_stage = guidance.get("stage", current_stage)
                current_script = guidance.get("say_this", current_script)

                # Push AI coaching back to the UI
                await websocket.send_json({
                    "type": "navigation",
                    "stage": guidance["stage"],
                    "tactic": guidance.get("tactic", ""),
                    "say_this": guidance["say_this"],
                    "objection_label": guidance.get("objection_label"),
                })

    except WebSocketDisconnect:
        print("Client disconnected from WebSocket")
    except Exception as e:
        print(f"Error in WebSocket: {e}")