"use client";

import { useEffect, useRef, useState } from "react";

type Transcript = {
  speaker: string;
  text: string;
};

type Navigation = {
  stage: string;
  tactic: string;
  say_this: string;
  objection_label: string | null;
  next_milestone: string;
  stage_progress: string;
};

type IncomingMessage =
  | {
      type: "transcript";
      speaker: string;
      text: string;
    }
  | {
      type: "navigation";
      stage: string;
      tactic: string;
      say_this: string;
      objection_label: string | null;
      next_milestone: string;
      stage_progress: string;
    }
  | {
      type: "summary";
      text: string;
    };

export default function Home() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([
    { speaker: "System", text: "Connecting to AI Call GPS..." },
  ]);
  const [navigation, setNavigation] = useState<Navigation>({
    stage: "Initializing...",
    tactic: "",
    say_this: "Waiting for call guidance...",
    objection_label: null,
    next_milestone: "",
    stage_progress: "1/6",
  });
  const [isListening, setIsListening] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // In production, use the Render deployment URL.
    // In dev, detect if we're in a Codespace (proxied via HTTPS) or truly local.
    let wsUrl: string;
    if (process.env.NODE_ENV === "production") {
      wsUrl = "wss://equalground-copilot.onrender.com/ws/ui";
    } else if (typeof window !== "undefined" && window.location.hostname.includes("app.github.dev")) {
      // GitHub Codespaces: replace the frontend port with 8000 for the backend
      const host = window.location.hostname.replace(/-\d+\./, "-8000.");
      wsUrl = `wss://${host}/ws/ui`;
    } else {
      wsUrl = "ws://127.0.0.1:8000/ws/ui";
    }
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setTranscripts([{ speaker: "System", text: "🟢 Connected! AI GPS Ready. Click 'Start Microphone' to begin." }]);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as IncomingMessage;

      if (data.type === "transcript") {
        setTranscripts((prev) => [...prev, { speaker: data.speaker, text: data.text }]);
      } else if (data.type === "navigation") {
        setNavigation({
          stage: data.stage,
          tactic: data.tactic,
          say_this: data.say_this,
          objection_label: data.objection_label ?? null,
          next_milestone: data.next_milestone ?? "",
          stage_progress: data.stage_progress ?? "",
        });
      } else if (data.type === "summary") {
        setSummary(data.text);
      }
    };

    ws.onerror = () => {
      setTranscripts((prev) => [
        ...prev,
        { speaker: "System", text: "❌ Connection error. Check that the backend is running on port 8000." },
      ]);
    };

    return () => {
      ws.close();
      recognitionRef.current?.stop();
    };
  }, []);

  async function toggleMicrophone() {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Your browser does not support speech recognition. Please use Chrome.");
      return;
    }

    // Force Chrome to pass raw audio without echo cancellation (fixes Stereo Mix muting)
    try {
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      console.warn("Could not acquire raw audio stream:", err);
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      if (!transcript) return;
      console.log("Mic captured:", transcript);
      wsRef.current?.send(JSON.stringify({ type: "transcript", text: transcript }));
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.start();
    setIsListening(true);
  }

  function endCall() {
    // Stop the microphone
    recognitionRef.current?.stop();
    setIsListening(false);
    // Tell the backend to generate a summary
    wsRef.current?.send(JSON.stringify({ type: "end_call" }));
  }

  // If we have a summary, show the full-screen summary view
  if (summary) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-900 p-12 text-slate-100 font-sans">
        <div className="w-full max-w-3xl space-y-8">
          <div className="text-center">
            <span className="inline-block rounded-full bg-green-600 px-6 py-2 text-sm font-bold uppercase tracking-widest text-white">
              Call Complete
            </span>
            <h1 className="mt-6 text-4xl font-bold text-white">Post-Call Summary</h1>
            <p className="mt-2 text-slate-400">CRM-ready summary generated by AI</p>
          </div>
          <div className="whitespace-pre-wrap rounded-xl border border-slate-700 bg-slate-800 p-8 text-lg leading-relaxed text-slate-200 shadow-lg">
            {summary}
          </div>
          <button
            onClick={() => window.location.reload()}
            className="w-full rounded-lg bg-blue-600 py-4 text-lg font-bold uppercase tracking-wider text-white transition-all hover:bg-blue-700"
          >
            Start New Call
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-slate-900 text-slate-100 font-sans">
      {/* LEFT SIDE: Live Transcript */}
      <div className="w-3/5 border-r border-slate-700 p-8 flex flex-col">
        <h1 className="mb-6 text-2xl font-bold text-blue-400">Live Transcript</h1>

        <div className="flex flex-1 flex-col space-y-4 overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 p-6 shadow-inner">
          {transcripts.map((transcript, index) => (
            <p key={index} className="leading-relaxed">
              <span
                className={`font-semibold ${
                  transcript.speaker === "System"
                    ? "text-slate-400"
                    : transcript.speaker === "Prospect"
                      ? "text-blue-300"
                      : "text-green-300"
                }`}
              >
                {transcript.speaker}:
              </span>{" "}
              "{transcript.text}"
            </p>
          ))}
        </div>

        {/* Microphone + End Call Buttons */}
        <div className="mt-6 flex gap-4">
          <button
            onClick={toggleMicrophone}
            disabled={!!summary}
            className={`flex-1 rounded-lg py-4 text-lg font-bold uppercase tracking-wider transition-all ${
              isListening
                ? "bg-red-600 hover:bg-red-700 text-white animate-pulse"
                : "bg-green-600 hover:bg-green-700 text-white"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isListening ? "🔴 Stop Microphone" : "🎤 Start Microphone"}
          </button>
          <button
            onClick={endCall}
            disabled={!!summary}
            className="flex-1 rounded-lg bg-red-800 py-4 text-lg font-bold uppercase tracking-wider text-white transition-all hover:bg-red-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            📋 End Call & Summarize
          </button>
        </div>
      </div>

      {/* RIGHT SIDE: Call Guide (Teleprompter) */}
      <div className="w-2/5 bg-slate-950 p-8 flex flex-col">
        {/* Stage Progress Bar */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Stage {navigation.stage_progress}
            </span>
            <div className="flex items-center gap-3">
              {navigation.objection_label && (
                <span className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white animate-pulse">
                  {navigation.objection_label}
                </span>
              )}
              <span
                className={`rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white ${
                  navigation.stage.toLowerCase().includes("objection")
                    ? "bg-red-600"
                    : "bg-amber-600"
                }`}
              >
                {navigation.stage}
              </span>
            </div>
          </div>
          {/* Progress bar track */}
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6].map((step) => {
              const current = parseInt(navigation.stage_progress?.split("/")[0] || "1");
              return (
                <div
                  key={step}
                  className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                    step <= current ? "bg-green-500" : "bg-slate-700"
                  }`}
                />
              );
            })}
          </div>
        </div>

        {/* Tactic Header */}
        <div className="mt-4">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-400">
            {navigation.tactic}
          </p>
        </div>

        {/* SAY THIS — Giant Teleprompter */}
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-center text-3xl font-bold leading-relaxed text-green-300">
            {navigation.say_this}
          </p>
        </div>

        {/* Next Milestone — bottom */}
        {navigation.next_milestone && (
          <div className="mt-auto pt-4 border-t border-slate-800">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Next Goal</p>
            <p className="text-sm text-slate-400">{navigation.next_milestone}</p>
          </div>
        )}
      </div>
    </div>
  );
}
