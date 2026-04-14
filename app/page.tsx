"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Transcript = {
  speaker: string;
  text: string;
  timestamp: string;
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
    }
  | {
      type: "interim_update";
      text: string;
    };

const STAGE_LABELS = ["Gatekeeper", "Intro", "Credibility", "Discovery", "Pitch", "CTA"];

function getTimestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function CallTimer({ running }: { running: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [running]);
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return <span className="font-mono text-sm tabular-nums">{m}:{s}</span>;
}

export default function Home() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [navigation, setNavigation] = useState<Navigation>({
    stage: "GATEKEEPER",
    tactic: "",
    say_this: "Waiting for connection...",
    objection_label: null,
    next_milestone: "",
    stage_progress: "1/6",
  });
  const [isListening, setIsListening] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [prevSayThis, setPrevSayThis] = useState("");
  const [sayThisKey, setSayThisKey] = useState(0);
  const [interimText, setInterimText] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  // Animate say_this on change
  useEffect(() => {
    if (navigation.say_this !== prevSayThis) {
      setPrevSayThis(navigation.say_this);
      setSayThisKey((k) => k + 1);
    }
  }, [navigation.say_this, prevSayThis]);

  useEffect(() => {
    let wsUrl: string;
    const token = process.env.NEXT_PUBLIC_COPILOT_API_KEY || "";

    if (process.env.NEXT_PUBLIC_WS_URL) {
      wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}/ws/ui?token=${encodeURIComponent(token)}`;
    } else if (typeof window !== "undefined" && window.location.hostname.includes("app.github.dev")) {
      const host = window.location.hostname.replace(/-\d+\./, "-8000.");
      wsUrl = `wss://${host}/ws/ui?token=${encodeURIComponent(token)}`;
    } else {
      wsUrl = `ws://127.0.0.1:8000/ws/ui?token=${encodeURIComponent(token)}`;
    }
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setTranscripts([{ speaker: "System", text: "Connected. Ready when you are.", timestamp: getTimestamp() }]);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as IncomingMessage;
      if (data.type === "transcript") {
        setTranscripts((prev) => [...prev, { speaker: data.speaker, text: data.text, timestamp: getTimestamp() }]);
        setInterimText("");
      } else if (data.type === "navigation") {
        setNavigation({
          stage: data.stage,
          tactic: data.tactic,
          say_this: data.say_this,
          objection_label: data.objection_label ?? null,
          next_milestone: data.next_milestone ?? "",
          stage_progress: data.stage_progress ?? "",
        });
      } else if (data.type === "interim_update") {
        setInterimText(data.text);
      } else if (data.type === "summary") {
        setSummary(data.text);
        setIsGeneratingSummary(false);
      }
    };

    ws.onerror = () => {
      setConnected(false);
      setTranscripts((prev) => [
        ...prev,
        { speaker: "System", text: "Connection error. Check that the backend is running on port 8000.", timestamp: getTimestamp() },
      ]);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggleMicrophone = useCallback(async () => {
    if (isListening) {
      // Stop recording
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      setIsListening(false);
      return;
    }

    try {
      // Capture mic audio — raw, no processing
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 16000,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;

      // We need to convert to 16-bit PCM (linear16) for Deepgram.
      // Use AudioContext to resample + extract raw PCM, then send in 250ms chunks.
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      let audioBuffer: Int16Array[] = [];
      let sampleCount = 0;
      const samplesPerChunk = 16000 / 4; // 250ms at 16kHz = 4000 samples

      processor.onaudioprocess = (e) => {
        if (!mediaRecorderRef.current) return;
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert float32 [-1,1] to int16
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        audioBuffer.push(int16);
        sampleCount += int16.length;

        // Flush every ~250ms worth of samples
        if (sampleCount >= samplesPerChunk) {
          const totalLen = audioBuffer.reduce((a, b) => a + b.length, 0);
          const merged = new Int16Array(totalLen);
          let offset = 0;
          for (const chunk of audioBuffer) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          // Send raw PCM bytes to server
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(merged.buffer);
          }
          audioBuffer = [];
          sampleCount = 0;
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      // Use a sentinel object so we can check if recording is active
      mediaRecorderRef.current = { stop: () => {
        processor.disconnect();
        source.disconnect();
        audioContext.close();
      }} as unknown as MediaRecorder;

      setIsListening(true);
    } catch (err) {
      console.error("Could not start audio capture:", err);
      alert("Microphone access denied or unavailable.");
    }
  }, [isListening]);

  const endCall = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    setIsListening(false);
    setIsGeneratingSummary(true);
    wsRef.current?.send(JSON.stringify({ type: "end_call" }));
  }, []);

  // ─── Summary View ───
  if (summary) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-gray-950 p-8 text-gray-100 font-sans">
        <div className="w-full max-w-3xl space-y-6 fade-in">
          <div className="text-center space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-5 py-2">
              <div className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-sm font-semibold text-emerald-400 uppercase tracking-wider">Call Complete</span>
            </div>
            <h1 className="text-3xl font-bold text-white">Post-Call Summary</h1>
          </div>
          <div className="whitespace-pre-wrap rounded-2xl border border-gray-800 bg-gray-900 p-8 text-base leading-relaxed text-gray-300 shadow-2xl max-h-[60vh] overflow-y-auto custom-scrollbar">
            {summary}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => { navigator.clipboard.writeText(summary); }}
              className="flex-1 rounded-xl border border-gray-700 bg-gray-800 py-3.5 text-sm font-semibold text-gray-300 transition-all hover:bg-gray-700 hover:border-gray-600 active:scale-[0.98]"
            >
              Copy to Clipboard
            </button>
            <button
              onClick={() => window.location.reload()}
              className="flex-1 rounded-xl bg-blue-600 py-3.5 text-sm font-semibold text-white transition-all hover:bg-blue-500 active:scale-[0.98]"
            >
              Start New Call
            </button>
          </div>
        </div>
      </div>
    );
  }

  const currentStageNum = parseInt(navigation.stage_progress?.split("/")[0] || "1");

  return (
    <div className="flex h-screen w-full bg-gray-950 text-gray-100 font-sans">

      {/* ─── LEFT: Transcript Panel ─── */}
      <div className="w-3/5 flex flex-col border-r border-gray-800/60">

        {/* Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800/60 bg-gray-950">
          <div className="flex items-center gap-3">
            <div className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" : "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.5)]"}`} />
            <h1 className="text-lg font-semibold text-white">Live Transcript</h1>
          </div>
          <div className="flex items-center gap-4">
            {isListening && (
              <div className="flex items-center gap-2 text-red-400">
                <div className="mic-pulse h-2 w-2 rounded-full bg-red-400" />
                <span className="text-xs font-medium uppercase tracking-wider">Recording</span>
              </div>
            )}
            <div className="text-gray-500">
              <CallTimer running={isListening} />
            </div>
          </div>
        </div>

        {/* Transcript Feed */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 custom-scrollbar">
          {transcripts.length === 0 ? (
            <div className="flex flex-1 items-center justify-center h-full">
              <p className="text-gray-600 text-sm">Transcript will appear here once the call starts...</p>
            </div>
          ) : (
            transcripts.map((t, i) => (
              <div key={i} className={`flex gap-3 items-start fade-in ${t.speaker === "System" ? "opacity-50" : ""}`}>
                <span className="text-[10px] text-gray-600 font-mono pt-1 shrink-0 w-16 tabular-nums">{t.timestamp}</span>
                <div className="min-w-0">
                  <span
                    className={`text-xs font-bold uppercase tracking-wider ${
                      t.speaker === "System"
                        ? "text-gray-500"
                        : t.speaker === "Prospect"
                          ? "text-blue-400"
                          : "text-emerald-400"
                    }`}
                  >
                    {t.speaker}
                  </span>
                  <p className="text-sm leading-relaxed text-gray-300 mt-0.5">{t.text}</p>
                </div>
              </div>
            ))
          )}
          {interimText && (
            <div className="flex gap-3 items-start opacity-50">
              <span className="text-[10px] text-gray-600 font-mono pt-1 shrink-0 w-16 tabular-nums">{getTimestamp()}</span>
              <div className="min-w-0">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-400/60">Prospect</span>
                <p className="text-sm leading-relaxed text-gray-500 mt-0.5 italic">{interimText}</p>
              </div>
            </div>
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* Controls Bar */}
        <div className="px-6 py-4 border-t border-gray-800/60 bg-gray-950">
          <div className="flex gap-3">
            <button
              onClick={toggleMicrophone}
              disabled={!!summary || !connected}
              className={`flex-1 flex items-center justify-center gap-2.5 rounded-xl py-3.5 text-sm font-semibold transition-all active:scale-[0.98] ${
                isListening
                  ? "bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20"
                  : "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
              } disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100`}
            >
              <span className="text-lg">{isListening ? "◼" : "●"}</span>
              {isListening ? "Stop Recording" : "Start Recording"}
            </button>
            <button
              onClick={endCall}
              disabled={!!summary || !connected || isGeneratingSummary}
              className="flex items-center justify-center gap-2.5 rounded-xl border border-gray-700 bg-gray-800 px-6 py-3.5 text-sm font-semibold text-gray-300 transition-all hover:bg-gray-700 hover:border-gray-600 active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {isGeneratingSummary ? (
                <>
                  <span className="spinner h-4 w-4 border-2 border-gray-500 border-t-white rounded-full" />
                  Generating...
                </>
              ) : (
                "End Call"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ─── RIGHT: Teleprompter Panel ─── */}
      <div className="w-2/5 flex flex-col bg-gray-900/50">

        {/* Stage Progress Header */}
        <div className="px-6 py-4 border-b border-gray-800/60">
          {/* Stage step indicators */}
          <div className="flex gap-1 mb-3">
            {STAGE_LABELS.map((label, i) => {
              const step = i + 1;
              const isActive = step === currentStageNum;
              const isDone = step < currentStageNum;
              return (
                <div key={label} className="flex-1 flex flex-col items-center gap-1.5">
                  <div
                    className={`h-1 w-full rounded-full transition-all duration-500 ${
                      isDone
                        ? "bg-emerald-500"
                        : isActive
                          ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                          : "bg-gray-800"
                    }`}
                  />
                  <span
                    className={`text-[9px] font-semibold uppercase tracking-wider transition-colors ${
                      isDone ? "text-emerald-500" : isActive ? "text-blue-400" : "text-gray-600"
                    }`}
                  >
                    {label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Active badge row */}
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-1">
                <span className="text-xs font-bold text-blue-400">{navigation.stage}</span>
              </span>
            </div>
            {navigation.objection_label && (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-1 objection-flash">
                <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                <span className="text-xs font-bold text-red-400">{navigation.objection_label}</span>
              </span>
            )}
          </div>
        </div>

        {/* Tactic Label */}
        {navigation.tactic && (
          <div className="px-6 pt-4">
            <span className="inline-block rounded-md bg-gray-800 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.15em] text-gray-400">
              {navigation.tactic}
            </span>
          </div>
        )}

        {/* SAY THIS — Main Teleprompter */}
        <div className="flex flex-1 items-center justify-center px-8 py-6">
          <p
            key={sayThisKey}
            className="text-center text-2xl font-semibold leading-relaxed text-white teleprompter-fade"
          >
            {navigation.say_this}
          </p>
        </div>

        {/* Next Milestone Footer */}
        {navigation.next_milestone && (
          <div className="px-6 py-4 border-t border-gray-800/60">
            <div className="flex items-start gap-2">
              <span className="text-gray-600 mt-0.5 text-sm">→</span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-0.5">Next Goal</p>
                <p className="text-xs text-gray-400 leading-relaxed">{navigation.next_milestone}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
