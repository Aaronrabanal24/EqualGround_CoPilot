"use client";

import React, { useEffect, useState } from "react";

type Transcript = {
  speaker: string;
  text: string;
};

type Navigation = {
  current_stage: string;
  objection_label: string | null;
  next_script: string;
  suggested_action: string;
};

type IncomingMessage =
  | {
      type: "transcript";
      speaker: string;
      text: string;
    }
  | {
      type: "navigation";
      current_stage: string;
      objection_label: string | null;
      next_script: string;
      suggested_action: string;
    };

export default function Home() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([
    { speaker: "System", text: "Connecting to AI Call GPS..." },
  ]);
  const [navigation, setNavigation] = useState<Navigation>({
    current_stage: "Initializing...",
    objection_label: null,
    next_script: "Waiting for call guidance...",
    suggested_action: "Stand by...",
  });

  useEffect(() => {
    const ws = new WebSocket("ws://127.0.0.1:8000/ws/ui");

    ws.onopen = () => {
      setTranscripts([{ speaker: "System", text: "🟢 Connected! AI GPS Ready." }]);
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as IncomingMessage;

      if (data.type === "transcript") {
        setTranscripts((prev) => [...prev, { speaker: data.speaker, text: data.text }]);
      } else if (data.type === "navigation") {
        setNavigation({
          current_stage: data.current_stage,
          objection_label: data.objection_label ?? null,
          next_script: data.next_script,
          suggested_action: data.suggested_action,
        });
      }
    };

    ws.onerror = () => {
      setTranscripts((prev) => [
        ...prev,
        { speaker: "System", text: "❌ Connection error. Check that the backend is running on port 8000." },
      ]);
    };

    return () => ws.close();
  }, []);

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
      </div>

      {/* RIGHT SIDE: Call Navigator (GPS Teleprompter) */}
      <div className="w-2/5 bg-slate-950 p-8 flex flex-col justify-between">
        {/* Stage Indicator */}
        <div className="space-y-3">
          <div
            className={`inline-block rounded-full px-4 py-2 text-sm font-bold uppercase tracking-widest text-white ${
              navigation.current_stage === "Stage 5: Objection Handling"
                ? "bg-red-600"
                : "bg-amber-600"
            }`}
          >
            {navigation.current_stage}
          </div>
          {navigation.objection_label && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500 bg-red-950 px-4 py-3">
              <span className="text-lg">🚨</span>
              <span className="text-sm font-bold text-red-300">{navigation.objection_label}</span>
            </div>
          )}
        </div>

        {/* Main Script (Teleprompter) */}
        <div className="flex-1 flex flex-col justify-center">
          <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-slate-400">
            📺 READ THIS (Teleprompter):
          </h2>
          <div className="rounded-lg border-2 border-green-500 bg-slate-900 p-8 shadow-lg">
            <p className="text-4xl font-bold leading-relaxed text-green-300">
              {navigation.next_script}
            </p>
          </div>
        </div>

        {/* Tactical Action */}
        <div className="mt-8 rounded-lg border border-blue-500 bg-slate-800 p-6">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-blue-400">
            💡 Tactical Action:
          </h3>
          <p className="text-sm text-blue-200">{navigation.suggested_action}</p>
        </div>
      </div>
    </div>
  );
}
