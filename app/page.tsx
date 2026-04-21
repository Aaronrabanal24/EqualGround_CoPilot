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

type GuideTab = "stages" | "objections" | "competitors" | "personas";
type GuideView = "flow" | "search";

type KBStage = {
  id: string;
  order: number;
  name: string;
  goal: string;
  instructions: string;
  few_shot?: Array<{ prospect?: string; say_this?: string }>;
};

type KBObjection = {
  tactic: string;
  trigger_phrases: string[];
  instructions: string;
  context: string;
  example_responses: string[];
};

type KBCompetitor = {
  their_flaw: string;
  our_pivot: string;
  example_responses: string[];
};

type KBPersona = {
  theme: string;
  pivot_to: string;
  discovery_questions: string[];
};

type KBPayload = {
  battlecards?: { competitors?: Record<string, KBCompetitor> };
  call_stages?: { stages?: KBStage[] };
  objections?: { objections?: Record<string, KBObjection> };
  personas?: { personas?: Record<string, KBPersona> };
};

const STAGE_LABELS = ["Gatekeeper", "Intro", "Credibility", "Discovery", "Pitch", "CTA"];
const STAGE_IDS = ["GATEKEEPER", "INTRO", "CREDIBILITY", "DISCOVERY", "PITCH", "CTA"];
const COACHING_PANEL_HEIGHT_PCT = 58;
const CALENDAR_IFRAME_WIDTH = 800;
const CALENDAR_IFRAME_HEIGHT = 600;
const CALENDAR_TARGET_WIDTH = 440;
const CALENDAR_SCALE = CALENDAR_TARGET_WIDTH / CALENDAR_IFRAME_WIDTH;
const CALENDAR_PANEL_HEIGHT_PCT = 100 - COACHING_PANEL_HEIGHT_PCT;
const CALENDAR_WRAPPER_HEIGHT_PIXELS = CALENDAR_IFRAME_HEIGHT * CALENDAR_SCALE;
const CALENDAR_WEEK_EMBED_URL = "https://calendar.google.com/calendar/embed?src=adam.mustafa%40yuja.com&ctz=America%2FLos_Angeles&mode=WEEK";

const GUIDE_OBJECTION_GROUPS = [
  {
    label: "TIMING",
    items: [
      { key: "no_budget", name: "No Budget" },
      { key: "deadline_extended", name: "Deadline Extended" },
      { key: "contract_ending", name: "Contract Ending" },
      { key: "too_busy", name: "Too Busy" },
    ],
  },
  {
    label: "PUSHBACK",
    items: [
      { key: "already_compliant", name: "Already Compliant" },
      { key: "send_email", name: "Send Email" },
      { key: "not_my_decision", name: "Not My Decision" },
      { key: "too_complex", name: "Too Complex" },
      { key: "cant_modify_cms", name: "Can't Modify CMS" },
    ],
  },
  {
    label: "PRODUCT",
    items: [
      { key: "using_competitor", name: "Using Competitor" },
      { key: "bulk_remediation", name: "Bulk Remediation" },
      { key: "website_redesign", name: "Website Redesign" },
    ],
  },
];

const GUIDE_COMPETITORS = [
  { key: "overlay", name: "AudioEye / Overlays" },
  { key: "equidox", name: "Equidox" },
  { key: "acquia", name: "Acquia" },
  { key: "civicplus_granicus", name: "CivicPlus / Granicus" },
  { key: "siteimprove", name: "Siteimprove" },
  { key: "manual_inhouse", name: "Manual / In-house" },
];

const GUIDE_PERSONAS = [
  { key: "it_director_webmaster", name: "IT Director / Webmaster" },
  { key: "compliance_officer", name: "Compliance Officer" },
  { key: "superintendent_city_manager", name: "Superintendent / City Manager" },
  { key: "small_county_no_it", name: "Small County (No IT)" },
  { key: "commissioner_driven_buyer", name: "Commissioner-Driven Buyer" },
];

const DEFAULT_NAVIGATION: Navigation = {
  stage: "GATEKEEPER",
  tactic: "",
  prospect_signal: "Waiting for connection...",
  insight: "",
  talking_points: [],
  objection_label: null,
  next_milestone: "",
  stage_progress: "1/6",
};

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
  const [navigation, setNavigation] = useState<Navigation>(DEFAULT_NAVIGATION);
  const [isListening, setIsListening] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [isConfirmingEndCall, setIsConfirmingEndCall] = useState(false);

  const [interimText, setInterimText] = useState("");
  const [audioMode, setAudioMode] = useState<"mic" | "system">("system");
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default");
  const [appMode, setAppMode] = useState<"live" | "guide">("live");
  const [guideView, setGuideView] = useState<GuideView>("flow");
  const [guideActiveStageIndex, setGuideActiveStageIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedTalkingPoints, setExpandedTalkingPoints] = useState<Set<number>>(new Set());
  const [guideNavigation, setGuideNavigation] = useState<Navigation | null>(null);
  const [kb, setKb] = useState<Record<string, unknown> | null>(null);
  const [selectedGuideItem, setSelectedGuideItem] = useState<{ tab: GuideTab; key: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const kbData = (kb ?? {}) as KBPayload;
  const stages = kbData.call_stages?.stages ?? [];
  const objections = kbData.objections?.objections ?? {};
  const competitors = kbData.battlecards?.competitors ?? {};
  const personas = kbData.personas?.personas ?? {};

  // Enumerate audio input devices (re-enumerate on hotplug)
  useEffect(() => {
    const enumerate = () =>
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        setAudioDevices(devices.filter((d) => d.kind === "audioinput"));
      });

    // Prompt mic permission so device labels are available
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => { s.getTracks().forEach((t) => t.stop()); enumerate(); })
      .catch(() => enumerate());

    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return () => navigator.mediaDevices.removeEventListener("devicechange", enumerate);
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

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
      setIsConfirmingEndCall(false);
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

        // 3. Merge into stereo via AudioWorklet (off main thread)
        const audioContext = new AudioContext({ sampleRate: 16000 });
        await audioContext.audioWorklet.addModule("/audio-processor.js");

        const micSource = audioContext.createMediaStreamSource(micStream);
        const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks));

        const merger = audioContext.createChannelMerger(2);
        micSource.connect(merger, 0, 0);     // mic → left channel (ch0)
        systemSource.connect(merger, 0, 1);  // system → right channel (ch1)

        const workletNode = new AudioWorkletNode(audioContext, "stereo-audio-processor", {
          channelCount: 2,
          channelCountMode: "explicit",
        });
        merger.connect(workletNode);
        workletNode.connect(audioContext.destination);

        workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(event.data);
          }
        };

        // Notify backend this is multichannel audio
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "audio_mode", mode: "stereo" }));
        }

        mediaRecorderRef.current = { stop: () => {
          workletNode.port.close();
          workletNode.disconnect();
          merger.disconnect();
          micSource.disconnect();
          systemSource.disconnect();
          audioContext.close();
        }} as unknown as MediaRecorder;

        setIsListening(true);
        setIsConfirmingEndCall(false);
      } else {
        // ── MIC-ONLY MODE (testing/demo) ──
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
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
        await audioContext.audioWorklet.addModule("/audio-processor.js");

        const source = audioContext.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioContext, "mono-audio-processor");

        source.connect(workletNode);
        workletNode.connect(audioContext.destination);

        workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(event.data);
          }
        };

        mediaRecorderRef.current = { stop: () => {
          workletNode.port.close();
          workletNode.disconnect();
          source.disconnect();
          audioContext.close();
        }} as unknown as MediaRecorder;

        setIsListening(true);
        setIsConfirmingEndCall(false);
      }
    } catch (err) {
      console.error("Could not start audio capture:", err);
      if (audioMode === "system") {
        alert("Screen sharing was cancelled or denied. Make sure to select a tab and check 'Share audio'.");
      } else {
        alert("Microphone access denied or unavailable.");
      }
    }
  }, [isListening, audioMode, selectedDeviceId]);

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

  const mapToStageNavigation = useCallback((stage: KBStage) => {
    const order = stage.order || 1;
    const activeIndex = STAGE_IDS.indexOf(stage.id);
    setGuideActiveStageIndex(activeIndex >= 0 ? activeIndex : Math.max(0, order - 1));
    setSelectedGuideItem({ tab: "stages", key: stage.id });
    setExpandedTalkingPoints(new Set());
    setGuideNavigation({
      stage: stage.id,
      tactic: "STAGE GUIDE",
      prospect_signal: `Stage ${order} of 6 — ${stage.name}\n${stage.goal}`,
      insight: stage.instructions,
      talking_points: (stage.few_shot ?? []).map((shot) => shot.say_this ?? "").filter(Boolean),
      objection_label: null,
      next_milestone: stage.goal,
      stage_progress: `${order}/6`,
    });
  }, []);

  const mapToObjectionNavigation = (key: string, displayName: string) => {
    const objection = objections[key];
    if (!objection) return;
    setSelectedGuideItem({ tab: "objections", key });
    setExpandedTalkingPoints(new Set());
    setGuideNavigation({
      stage: "OBJECTION",
      tactic: objection.tactic,
      prospect_signal: `${objection.tactic} — ${(objection.trigger_phrases ?? []).slice(0, 3).join(", ")}`,
      insight: `${objection.instructions}\n\n${objection.context}`,
      talking_points: objection.example_responses ?? [],
      objection_label: displayName,
      next_milestone: "Handle the objection, then redirect to discovery",
      stage_progress: "",
    });
  };

  const mapToCompetitorNavigation = (key: string, displayName: string) => {
    const competitor = competitors[key];
    if (!competitor) return;
    setSelectedGuideItem({ tab: "competitors", key });
    setExpandedTalkingPoints(new Set());
    setGuideNavigation({
      stage: "COMPETITOR",
      tactic: "BATTLECARD",
      prospect_signal: `Prospect mentioned ${displayName}: ${competitor.their_flaw}`,
      insight: competitor.our_pivot,
      talking_points: competitor.example_responses ?? [],
      objection_label: displayName,
      next_milestone: "Differentiate, then ask a discovery question",
      stage_progress: "",
    });
  };

  const mapToPersonaNavigation = (key: string, displayName: string) => {
    const persona = personas[key];
    if (!persona) return;
    setSelectedGuideItem({ tab: "personas", key });
    setExpandedTalkingPoints(new Set());
    setGuideNavigation({
      stage: "PERSONA",
      tactic: "PERSONA GUIDE",
      prospect_signal: `Persona: ${displayName} — ${persona.theme}`,
      insight: persona.pivot_to,
      talking_points: persona.discovery_questions ?? [],
      objection_label: null,
      next_milestone: "Tailor your pitch to this buyer's priorities",
      stage_progress: "",
    });
  };

  useEffect(() => {
    if (appMode === "guide" && !kb) {
      fetch("/api/kb")
        .then((r) => r.json())
        .then((data) => {
          setKb(data);
          const firstStage = data?.call_stages?.stages?.[0];
          if (firstStage) mapToStageNavigation(firstStage);
        })
        .catch(() => {
          setGuideNavigation({
            ...DEFAULT_NAVIGATION,
            stage: "GUIDE",
            prospect_signal: "Knowledge base could not be loaded.",
            insight: "Please try refreshing the page.",
            talking_points: [],
          });
        });
    }
  }, [appMode, kb, mapToStageNavigation]);

  useEffect(() => {
    if (appMode !== "live") {
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;

    async function connect() {
      // Fetch a short-lived, single-use session token from the Next.js API route
      let sessionToken: string;
      try {
        const res = await fetch("/api/session", { method: "POST" });
        if (!res.ok) throw new Error(`Session request failed: ${res.status}`);
        const data = await res.json();
        sessionToken = data.session_token;
      } catch {
        if (!cancelled) {
          setTranscripts((prev) => [
            ...prev,
            { speaker: "System", text: "Failed to obtain session token. Check server configuration.", timestamp: getTimestamp() },
          ]);
        }
        return;
      }

      if (cancelled) return;

      let wsUrl: string;
      if (process.env.NEXT_PUBLIC_WS_URL) {
        wsUrl = `${process.env.NEXT_PUBLIC_WS_URL}/ws/ui?token=${encodeURIComponent(sessionToken)}`;
      } else if (window.location.hostname.includes("app.github.dev")) {
        const host = window.location.hostname.replace(/-\d+\./, "-8000.");
        wsUrl = `wss://${host}/ws/ui?token=${encodeURIComponent(sessionToken)}`;
      } else {
        wsUrl = `ws://127.0.0.1:8000/ws/ui?token=${encodeURIComponent(sessionToken)}`;
      }

      ws = new WebSocket(wsUrl);
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

      ws.onclose = (event) => {
        setConnected(false);
        // 4001 = expired or invalid session token — retry once with a fresh token
        if (event.code === 4001 && !cancelled) {
          console.warn("Session token rejected (4001). Retrying with a fresh token...");
          connect();
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      ws?.close();
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      systemStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [appMode]);

  const activeNavigation = appMode === "guide" ? guideNavigation : navigation;
  const rawStageNum = Number.parseInt(activeNavigation?.stage_progress?.split("/")[0] ?? "1", 10);
  const currentStageNum = Number.isFinite(rawStageNum) && rawStageNum > 0 ? rawStageNum : 1;
  const showListeningPlaceholder = appMode === "live" && !!activeNavigation && activeNavigation.talking_points.length === 0 && !activeNavigation.insight;

  return (
    <div className="flex h-screen w-full flex-col bg-gray-950 text-gray-100 font-sans">
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-2 text-white">
          <span className="text-lg">⬡</span>
          <span className="text-base font-semibold">EqualGround CoPilot</span>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900/70 p-1">
          <button
            onClick={() => setAppMode("live")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              appMode === "live" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            Live Call
          </button>
          <button
            onClick={() => setAppMode("guide")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              appMode === "guide" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            Call Guide
          </button>
        </div>
      </div>

      {summary ? (
        <div className="flex flex-1 items-center justify-center p-8">
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
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-3/5 flex flex-col border-r border-gray-800/60">
            {appMode === "live" ? (
              <>
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

                <div className="px-6 py-4 border-t border-gray-800/60 bg-gray-950">
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
                        {audioMode === "system" ? "Best for Zoom/Teams calls" : "Use a separate mic or USB adapter"}
                      </span>
                    </div>
                  )}
                  {audioMode === "mic" && !isListening && (
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Device</span>
                      <select
                        value={selectedDeviceId}
                        onChange={(e) => setSelectedDeviceId(e.target.value)}
                        className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300"
                      >
                        {audioDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                          </option>
                        ))}
                      </select>
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
                      {isListening ? "Stop Listening" : "Start Listening"}
                    </button>
                    {isConfirmingEndCall ? (
                      <div className="flex items-center justify-center gap-2.5 rounded-xl border border-gray-700 bg-gray-800 px-4 py-3.5 text-sm">
                        <span className="font-semibold text-gray-300">Confirm End?</span>
                        <button
                          onClick={() => {
                            setIsConfirmingEndCall(false);
                            endCall();
                          }}
                          className="text-xs font-semibold text-red-400 hover:text-red-300"
                        >
                          Yes, End
                        </button>
                        <button
                          onClick={() => setIsConfirmingEndCall(false)}
                          className="text-xs font-semibold text-gray-400 hover:text-gray-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setIsConfirmingEndCall(true)}
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
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800/60 bg-gray-950">
                  <h1 className="text-lg font-semibold text-white">📖 Call Guide</h1>
                  <span className="text-sm text-gray-500">No recording needed — click any card for instant coaching</span>
                </div>

                <div className="flex items-center gap-2 px-6 py-3 border-b border-gray-800/60">
                  <button
                    onClick={() => setGuideView("flow")}
                    className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
                      guideView === "flow"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}
                  >
                    ▶ Follow the Call
                  </button>
                  <button
                    onClick={() => setGuideView("search")}
                    className={`flex-1 rounded-lg py-2 text-sm font-semibold transition-colors ${
                      guideView === "search"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}
                  >
                    ⚡ Quick Find
                  </button>
                </div>

                {guideView === "flow" ? (
                  <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
                    {stages.map((stage, i) => {
                      const isSelectedStage = selectedGuideItem?.tab === "stages" && selectedGuideItem.key === stage.id;
                      const isActive = guideActiveStageIndex === i || isSelectedStage;
                      if (!isActive) {
                        return (
                          <button
                            key={stage.id}
                            onClick={() => {
                              setGuideActiveStageIndex(i);
                              mapToStageNavigation(stage);
                            }}
                            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/40 transition-colors"
                          >
                            <div className="h-2 w-2 rounded-full bg-gray-700 shrink-0" />
                            <span className="text-sm text-gray-500">{i + 1} · {STAGE_LABELS[i] ?? stage.name}</span>
                          </button>
                        );
                      }

                      return (
                        <div key={stage.id} className="border-l-2 border-blue-500 bg-blue-600/8 mx-2 rounded-r-lg mb-1">
                          <div className="flex items-center gap-3 px-4 py-3">
                            <div className="h-2.5 w-2.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)] shrink-0" />
                            <span className="text-sm font-semibold text-white">{i + 1} · {STAGE_LABELS[i] ?? stage.name}</span>
                          </div>

                          {stage.few_shot?.[0]?.say_this && (
                            <div className="px-4 pb-3">
                              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Open with</p>
                              <p className="text-sm text-white leading-relaxed bg-gray-800/60 rounded-lg px-3 py-2">
                                &quot;{stage.few_shot[0].say_this}&quot;
                              </p>
                            </div>
                          )}

                          <div className="px-4 pb-4">
                            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">If they say →</p>
                            <div className="flex flex-wrap gap-2">
                              {(stage.few_shot ?? []).slice(1).map((shot, si) => (
                                <button
                                  key={si}
                                  onClick={() => {
                                    setSelectedGuideItem({ tab: "stages", key: stage.id });
                                    setExpandedTalkingPoints(new Set());
                                    setGuideNavigation({
                                      stage: stage.id,
                                      tactic: "STAGE GUIDE",
                                      prospect_signal: shot.prospect ?? "",
                                      insight: "",
                                      talking_points: shot.say_this ? [shot.say_this] : [],
                                      objection_label: null,
                                      next_milestone: stage.goal,
                                      stage_progress: `${i + 1}/6`,
                                    });
                                  }}
                                  className="text-xs px-3 py-1.5 rounded-full bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white transition-colors text-left"
                                >
                                  {(shot.prospect ?? "").length > 40
                                    ? `${(shot.prospect ?? "").slice(0, 40)}...`
                                    : (shot.prospect ?? "")}
                                </button>
                              ))}

                              {i === 0 && (
                                <button
                                  onClick={() => mapToObjectionNavigation("no_budget", "No Budget")}
                                  className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors"
                                >
                                  No Budget
                                </button>
                              )}
                              {i === 2 && (
                                <button
                                  onClick={() => mapToObjectionNavigation("deadline_extended", "Deadline Extended")}
                                  className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors"
                                >
                                  Deadline Extended
                                </button>
                              )}
                              {i === 3 && (
                                <>
                                  <button onClick={() => mapToCompetitorNavigation("overlay", "AudioEye / Overlays")} className="text-xs px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">AudioEye</button>
                                  <button onClick={() => mapToCompetitorNavigation("civicplus_granicus", "CivicPlus / Granicus")} className="text-xs px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">CivicPlus</button>
                                  <button onClick={() => mapToCompetitorNavigation("equidox", "Equidox")} className="text-xs px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">Equidox</button>
                                  <button onClick={() => mapToObjectionNavigation("no_budget", "No Budget")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">No Budget</button>
                                  <button onClick={() => mapToObjectionNavigation("cant_modify_cms", "Can't Modify CMS")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Can&apos;t Modify CMS</button>
                                </>
                              )}
                              {i === 4 && (
                                <>
                                  <button onClick={() => mapToObjectionNavigation("too_complex", "Too Complex")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Too Complex</button>
                                  <button onClick={() => mapToObjectionNavigation("bulk_remediation", "Bulk Remediation")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Bulk Remediation</button>
                                </>
                              )}
                              {i === 5 && (
                                <>
                                  <button onClick={() => mapToObjectionNavigation("not_my_decision", "Not My Decision")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Not My Decision</button>
                                  <button onClick={() => mapToObjectionNavigation("too_busy", "Too Busy")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Too Busy</button>
                                  <button onClick={() => mapToObjectionNavigation("send_email", "Send Email")} className="text-xs px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Send Email</button>
                                </>
                              )}
                            </div>
                          </div>

                          {i < 5 && (
                            <div className="px-4 pb-4">
                              <button
                                onClick={() => {
                                  const nextIndex = i + 1;
                                  setGuideActiveStageIndex(nextIndex);
                                  const nextStage = stages[nextIndex];
                                  if (nextStage) mapToStageNavigation(nextStage);
                                }}
                                className="w-full rounded-lg border border-gray-700 bg-gray-800/60 py-2 text-xs font-semibold text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
                              >
                                → Next: {STAGE_LABELS[i + 1]}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col flex-1 overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-800/60">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">🔍</span>
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="budget, audioeye, civic, complex..."
                          autoFocus
                          className="w-full rounded-lg border border-gray-700 bg-gray-800 pl-8 pr-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                        />
                        {searchQuery && (
                          <button
                            onClick={() => setSearchQuery("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-xs"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
                      {searchQuery.trim() === "" ? (
                        <div className="px-4 py-3 space-y-4">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-2">COMPETITORS</p>
                            {GUIDE_COMPETITORS.map((item) => (
                              <button key={item.key} onClick={() => mapToCompetitorNavigation(item.key, item.name)} disabled={!competitors[item.key]}
                                className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                <span>{item.name}</span>
                                <span className="text-[10px] text-red-400/60 uppercase font-bold">Competitor</span>
                              </button>
                            ))}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-2">OBJECTIONS</p>
                            {GUIDE_OBJECTION_GROUPS.flatMap((g) => g.items).map((item) => (
                              <button key={item.key} onClick={() => mapToObjectionNavigation(item.key, item.name)} disabled={!objections[item.key]}
                                className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                <span>{item.name}</span>
                                <span className="text-[10px] text-amber-400/60 uppercase font-bold">Objection</span>
                              </button>
                            ))}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-2">PERSONAS</p>
                            {GUIDE_PERSONAS.map((item) => (
                              <button key={item.key} onClick={() => mapToPersonaNavigation(item.key, item.name)} disabled={!personas[item.key]}
                                className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                <span>{item.name}</span>
                                <span className="text-[10px] text-blue-400/60 uppercase font-bold">Persona</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        (() => {
                          const q = searchQuery.toLowerCase();
                          const competitorResults = GUIDE_COMPETITORS.filter((item) =>
                            item.name.toLowerCase().includes(q) || item.key.toLowerCase().includes(q)
                          );
                          const objectionResults = GUIDE_OBJECTION_GROUPS.flatMap((g) => g.items).filter((item) =>
                            item.name.toLowerCase().includes(q) || item.key.toLowerCase().includes(q)
                          );
                          const personaResults = GUIDE_PERSONAS.filter((item) =>
                            item.name.toLowerCase().includes(q) || item.key.toLowerCase().includes(q)
                          );
                          const total = competitorResults.length + objectionResults.length + personaResults.length;

                          if (total === 0) {
                            return (
                              <div className="flex items-center justify-center h-32">
                                <p className="text-sm text-gray-600 italic">No results for &quot;{searchQuery}&quot;</p>
                              </div>
                            );
                          }

                          return (
                            <div className="px-4 py-2 space-y-1">
                              {competitorResults.map((item) => (
                                <button key={item.key} onClick={() => { mapToCompetitorNavigation(item.key, item.name); setSearchQuery(""); }} disabled={!competitors[item.key]}
                                  className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                  <span>{item.name}</span>
                                  <span className="text-[10px] text-red-400/60 uppercase font-bold">Competitor</span>
                                </button>
                              ))}
                              {objectionResults.map((item) => (
                                <button key={item.key} onClick={() => { mapToObjectionNavigation(item.key, item.name); setSearchQuery(""); }} disabled={!objections[item.key]}
                                  className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                  <span>{item.name}</span>
                                  <span className="text-[10px] text-amber-400/60 uppercase font-bold">Objection</span>
                                </button>
                              ))}
                              {personaResults.map((item) => (
                                <button key={item.key} onClick={() => { mapToPersonaNavigation(item.key, item.name); setSearchQuery(""); }} disabled={!personas[item.key]}
                                  className="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                                  <span>{item.name}</span>
                                  <span className="text-[10px] text-blue-400/60 uppercase font-bold">Persona</span>
                                </button>
                              ))}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="w-2/5 flex flex-col bg-gray-900/50">
            <div className="min-h-0 flex flex-col overflow-hidden" style={{ height: `${COACHING_PANEL_HEIGHT_PCT}%` }}>
              <div className="px-6 py-4 border-b border-gray-800/60">
                <div className="flex gap-1 mb-3">
                  {STAGE_LABELS.map((label, i) => {
                    const step = i + 1;
                    const isActive = step === currentStageNum;
                    const isDone = step < currentStageNum;
                    const canClickLiveStage = appMode === "live";
                    return (
                      <button
                        key={label}
                        onClick={() => {
                          if (canClickLiveStage && wsRef.current?.readyState === WebSocket.OPEN) {
                            wsRef.current.send(JSON.stringify({ type: "set_stage", stage: STAGE_IDS[i] }));
                          }
                        }}
                        className={`flex-1 flex flex-col items-center gap-1.5 group ${canClickLiveStage ? "cursor-pointer" : "cursor-default"}`}
                      >
                        <div
                          className={`h-1 w-full rounded-full transition-all duration-500 ${
                            isDone
                              ? "bg-emerald-500 group-hover:bg-emerald-400"
                              : isActive
                                ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                                : "bg-gray-700"
                          }`}
                        />
                        <span
                          className={`font-semibold uppercase tracking-wider transition-colors ${
                            isDone
                              ? "text-[9px] text-emerald-500"
                              : isActive
                                ? "text-xs text-blue-300"
                                : "text-[9px] text-gray-600"
                          }`}
                        >
                          {label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-2">
                    {activeNavigation?.stage && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-1">
                        <span className="text-xs font-bold text-blue-400">{activeNavigation.stage}</span>
                      </span>
                    )}
                  </div>
                  {activeNavigation?.objection_label && (
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-1 objection-flash">
                      <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                      <span className="text-xs font-bold text-red-400">{activeNavigation.objection_label}</span>
                    </span>
                  )}
                </div>
              </div>

              {activeNavigation?.tactic && (
                <div className="px-6 pt-4">
                  <span className="inline-block rounded-md bg-gray-800 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.15em] text-gray-400">
                    {activeNavigation.tactic}
                  </span>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
                {appMode === "guide" && !guideNavigation ? (
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <span className="text-2xl text-gray-600 mb-2">⬡</span>
                    <p className="text-sm text-gray-500 whitespace-pre-line">Click any card on the left{"\n"}to see talking points and guidance.</p>
                  </div>
                ) : showListeningPlaceholder ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-gray-500 text-sm text-center italic">Listening for prospect signals...</p>
                  </div>
                ) : (
                  <>
                    {activeNavigation?.prospect_signal && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-blue-400/70 mb-1.5">🔵 What&apos;s Happening</p>
                        <p className="text-sm leading-relaxed text-gray-300 transition-all duration-500 ease-in-out whitespace-pre-line">{activeNavigation.prospect_signal}</p>
                      </div>
                    )}

                    {activeNavigation?.insight && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400/70 mb-1.5">💡 Your Angle</p>
                        <p className="text-sm leading-relaxed text-gray-300 transition-all duration-500 ease-in-out whitespace-pre-line">{activeNavigation.insight}</p>
                      </div>
                    )}

                    {activeNavigation && activeNavigation.talking_points.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-400/70 mb-2">Say This</p>
                        <ul className="space-y-2">
                          {activeNavigation.talking_points.map((point, i) => {
                            const firstSentenceEnd = point.search(/[.!?](\s|$)/);
                            const firstSentence = firstSentenceEnd > 0 ? point.slice(0, firstSentenceEnd + 1) : point;
                            const hasMore = firstSentence.length < point.length;
                            const isExpanded = expandedTalkingPoints.has(i);

                            return (
                              <li key={i} className="flex items-start gap-2.5 transition-all duration-500 ease-in-out">
                                <span className="text-emerald-500 mt-0.5 text-sm shrink-0">•</span>
                                <div className="min-w-0">
                                  <span className="text-base font-medium leading-relaxed text-white">
                                    {isExpanded ? point : firstSentence}
                                  </span>
                                  {hasMore && (
                                    <button
                                      onClick={() => {
                                        setExpandedTalkingPoints((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(i)) next.delete(i); else next.add(i);
                                          return next;
                                        });
                                      }}
                                      className="ml-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                                    >
                                      {isExpanded ? "less" : "+ more"}
                                    </button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>

              {activeNavigation?.next_milestone && (
                <div className="px-6 py-4 border-t border-gray-800/60">
                  <div className="flex items-start gap-2">
                    <span className="text-gray-600 mt-0.5 text-sm">→</span>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 mb-0.5">Next Goal</p>
                      <p className="text-xs text-gray-400 leading-relaxed">{activeNavigation.next_milestone}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="min-h-0 border-t border-gray-800/60 bg-gray-900/50 px-4 py-3" style={{ height: `${CALENDAR_PANEL_HEIGHT_PCT}%` }}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-xs font-bold text-blue-300">📅 Adam&apos;s Calendar</p>
                <a
                  href={CALENDAR_WEEK_EMBED_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2"
                >
                  Open in new tab ↗
                </a>
              </div>
              <div className="overflow-hidden rounded-lg border border-gray-800/70 bg-black/30" style={{ height: `${CALENDAR_WRAPPER_HEIGHT_PIXELS}px` }}>
                <iframe
                  src={CALENDAR_WEEK_EMBED_URL}
                  style={{ border: 0, transform: `scale(${CALENDAR_SCALE})`, transformOrigin: "top left" }}
                  width={CALENDAR_IFRAME_WIDTH}
                  height={CALENDAR_IFRAME_HEIGHT}
                  frameBorder="0"
                  scrolling="no"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
