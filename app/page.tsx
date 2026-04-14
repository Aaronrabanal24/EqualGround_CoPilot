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
  prospect_signal: string;
  insight: string;
  talking_points: string[];
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
      prospect_signal: string;
      insight: string;
      talking_points: string[];
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
    prospect_signal: "Waiting for connection...",
    insight: "",
    talking_points: [],
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
  const [audioMode, setAudioMode] = useState<"mic" | "system">("system");

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  // Animate panel on change
  useEffect(() => {
    if (navigation.prospect_signal !== prevSayThis) {
      setPrevSayThis(navigation.prospect_signal);
      setSayThisKey((k) => k + 1);
    }
  }, [navigation.prospect_signal, prevSayThis]);

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
          prospect_signal: data.prospect_signal ?? "",
          insight: data.insight ?? "",
          talking_points: data.talking_points ?? [],
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
      systemStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggleMicrophone = useCallback(async () => {
    if (isListening) {
      // Stop recording
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      systemStreamRef.current?.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      systemStreamRef.current = null;
      setIsListening(false);
      return;
    }

    try {
      if (audioMode === "system") {
        // ── DUAL CAPTURE: system audio (prospect) + mic (rep) → stereo PCM ──
        // 1. Capture system/tab audio (prospect's voice)
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1, frameRate: 1 },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        } as DisplayMediaStreamOptions);

        // Verify we got an audio track
        const systemAudioTracks = displayStream.getAudioTracks();
        if (systemAudioTracks.length === 0) {
          displayStream.getTracks().forEach((t) => t.stop());
          alert("No audio track captured. Make sure to check 'Share tab audio' or 'Share system audio' in the dialog.");
          return;
        }

        // Discard the video track (required by Chrome but we don't need it)
        displayStream.getVideoTracks().forEach((t) => t.stop());

        // 2. Capture mic audio (rep's voice)
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000,
            channelCount: 1,
          },
        });

        mediaStreamRef.current = micStream;
        systemStreamRef.current = new MediaStream(systemAudioTracks);

        // 3. Merge into stereo: left=mic (rep), right=system (prospect)
        const audioContext = new AudioContext({ sampleRate: 16000 });
        const micSource = audioContext.createMediaStreamSource(micStream);
        const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks));

        const merger = audioContext.createChannelMerger(2);
        micSource.connect(merger, 0, 0);     // mic → left channel (ch0)
        systemSource.connect(merger, 0, 1);  // system → right channel (ch1)

        // Use ScriptProcessor to extract stereo PCM
        const processor = audioContext.createScriptProcessor(4096, 2, 2);
        merger.connect(processor);
        processor.connect(audioContext.destination);

        let audioBuffer: Int16Array[] = [];
        let sampleCount = 0;
        const samplesPerChunk = 16000 / 4; // 250ms at 16kHz

        processor.onaudioprocess = (e) => {
          if (!mediaRecorderRef.current) return;
          const left = e.inputBuffer.getChannelData(0);   // mic (rep)
          const right = e.inputBuffer.getChannelData(1);   // system (prospect)

          // Interleave into stereo int16: [L0, R0, L1, R1, ...]
          const interleaved = new Int16Array(left.length * 2);
          for (let i = 0; i < left.length; i++) {
            const lSample = Math.max(-1, Math.min(1, left[i]));
            const rSample = Math.max(-1, Math.min(1, right[i]));
            interleaved[i * 2] = lSample < 0 ? lSample * 0x8000 : lSample * 0x7fff;
            interleaved[i * 2 + 1] = rSample < 0 ? rSample * 0x8000 : rSample * 0x7fff;
          }
          audioBuffer.push(interleaved);
          sampleCount += left.length;

          if (sampleCount >= samplesPerChunk) {
            const totalLen = audioBuffer.reduce((a, b) => a + b.length, 0);
            const merged = new Int16Array(totalLen);
            let offset = 0;
            for (const chunk of audioBuffer) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(merged.buffer);
            }
            audioBuffer = [];
            sampleCount = 0;
          }
        };

        // Notify backend this is multichannel audio
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "audio_mode", mode: "stereo" }));
        }

        mediaRecorderRef.current = { stop: () => {
          processor.disconnect();
          merger.disconnect();
          micSource.disconnect();
          systemSource.disconnect();
          audioContext.close();
        }} as unknown as MediaRecorder;

        setIsListening(true);
      } else {
        // ── MIC-ONLY MODE (testing/demo) ──
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

        // Notify backend this is mono mic audio
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "audio_mode", mode: "mono" }));
        }

        const audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        let audioBuffer: Int16Array[] = [];
        let sampleCount = 0;
        const samplesPerChunk = 16000 / 4;

        processor.onaudioprocess = (e) => {
          if (!mediaRecorderRef.current) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          audioBuffer.push(int16);
          sampleCount += int16.length;

          if (sampleCount >= samplesPerChunk) {
            const totalLen = audioBuffer.reduce((a, b) => a + b.length, 0);
            const merged = new Int16Array(totalLen);
            let offset = 0;
            for (const chunk of audioBuffer) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(merged.buffer);
            }
            audioBuffer = [];
            sampleCount = 0;
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        mediaRecorderRef.current = { stop: () => {
          processor.disconnect();
          source.disconnect();
          audioContext.close();
        }} as unknown as MediaRecorder;

        setIsListening(true);
      }
    } catch (err) {
      console.error("Could not start audio capture:", err);
      if (audioMode === "system") {
        alert("Screen sharing was cancelled or denied. Make sure to select a tab and check 'Share audio'.");
      } else {
        alert("Microphone access denied or unavailable.");
      }
    }
  }, [isListening, audioMode]);

  const endCall = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    systemStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    systemStreamRef.current = null;
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
          {/* Audio Source Selector */}
          {!isListening && (
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Audio Source</span>
              <div className="flex rounded-lg border border-gray-700 overflow-hidden">
                <button
                  onClick={() => setAudioMode("system")}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    audioMode === "system"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-750"
                  }`}
                >
                  Call Audio
                </button>
                <button
                  onClick={() => setAudioMode("mic")}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    audioMode === "mic"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-750"
                  }`}
                >
                  Mic Only
                </button>
              </div>
              <span className="text-[10px] text-gray-600">
                {audioMode === "system" ? "Captures prospect from your call app" : "For testing — mic labels as Prospect"}
              </span>
            </div>
          )}
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

        {/* Advisor Panel */}
        <div key={sayThisKey} className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar teleprompter-fade">

          {/* Prospect Signal */}
          {navigation.prospect_signal && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400/70 mb-1.5">Prospect Signal</p>
              <p className="text-sm leading-relaxed text-gray-300">{navigation.prospect_signal}</p>
            </div>
          )}

          {/* Insight */}
          {navigation.insight && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400/70 mb-1.5">Insight</p>
              <p className="text-sm leading-relaxed text-gray-300">{navigation.insight}</p>
            </div>
          )}

          {/* Talking Points */}
          {navigation.talking_points.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/70 mb-2">Talking Points</p>
              <ul className="space-y-2">
                {navigation.talking_points.map((point, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="text-emerald-500 mt-0.5 text-sm shrink-0">•</span>
                    <span className="text-base font-medium leading-relaxed text-white">{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
