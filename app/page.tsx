"use client";

import { useCallback, useEffect, useState } from "react";

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
const COPY_ICON = "📋";
const COPIED_ICON = "✓";

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

export default function Home() {
  const [guideView, setGuideView] = useState<GuideView>("flow");
  const [guideActiveStageIndex, setGuideActiveStageIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedTalkingPoints, setExpandedTalkingPoints] = useState<Set<number>>(new Set());
  const [guideNavigation, setGuideNavigation] = useState<Navigation | null>(null);
  const [kb, setKb] = useState<Record<string, unknown> | null>(null);
  const [selectedGuideItem, setSelectedGuideItem] = useState<{ tab: GuideTab; key: string } | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const kbData = (kb ?? {}) as KBPayload;
  const stages = kbData.call_stages?.stages ?? [];
  const objections = kbData.objections?.objections ?? {};
  const competitors = kbData.battlecards?.competitors ?? {};
  const personas = kbData.personas?.personas ?? {};

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
    if (!kb) {
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
  }, [kb, mapToStageNavigation]);

  const activeNavigation = guideNavigation;
  const rawStageNum = Number.parseInt(guideNavigation?.stage_progress?.split("/")[0] ?? "0", 10);
  const stageIdIndex = guideNavigation ? STAGE_IDS.indexOf(guideNavigation.stage) : -1;
  const fallbackStageNum = stageIdIndex >= 0 ? stageIdIndex + 1 : guideActiveStageIndex + 1;
  const currentStageNum = Number.isFinite(rawStageNum) && rawStageNum > 0 ? rawStageNum : (guideNavigation ? fallbackStageNum : 1);
  const getStageLabel = (stage: KBStage, index: number) => STAGE_LABELS[index] ?? stage.name;

  return (
    <div className="flex h-screen w-full flex-col bg-gray-950 text-gray-100 font-sans">
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-2 text-white">
          <span className="text-lg">⬡</span>
          <span className="text-base font-semibold">EqualGround CoPilot</span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 flex flex-col border-r border-gray-800/60">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800/60 bg-gray-950">
            <h1 className="text-xl font-bold text-white">📖 Call Guide</h1>
          </div>

          <div className="flex items-center gap-2 px-6 py-3 border-b border-gray-800/60">
            <button
              onClick={() => setGuideView("flow")}
              className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                guideView === "flow" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              ▶ Follow the Call
            </button>
            <button
              onClick={() => setGuideView("search")}
              className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                guideView === "search" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
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
                      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-gray-800/40 transition-colors"
                    >
                      <div className="h-2 w-2 rounded-full bg-gray-700 shrink-0" />
                      <span className="text-sm text-gray-400">{i + 1} · {getStageLabel(stage, i)}</span>
                    </button>
                  );
                }

                return (
                  <div key={stage.id} className="border-l-2 border-blue-500 bg-blue-600/8 mx-2 rounded-r-lg mb-1">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="h-2.5 w-2.5 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.6)] shrink-0" />
                      <span className="text-sm font-semibold text-white">{i + 1} · {getStageLabel(stage, i)}</span>
                    </div>

                    {stage.few_shot?.[0]?.say_this && (
                      <div className="px-4 pb-3">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Open with</p>
                        <p className="text-base font-medium text-white leading-relaxed bg-gray-800/60 rounded-lg px-3 py-2">
                          &quot;{stage.few_shot[0].say_this}&quot;
                        </p>
                      </div>
                    )}

                    <div className="px-4 pb-4">
                      <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-2">If they say →</p>
                      <div className="flex flex-wrap gap-2">
                        {(stage.few_shot ?? []).slice(1).map((shot, si) => (
                          <button
                            key={si}
                            onClick={() => {
                              const prospectText = shot.prospect ?? "";
                              setSelectedGuideItem({ tab: "stages", key: stage.id });
                              setExpandedTalkingPoints(new Set());
                              setGuideNavigation({
                                stage: stage.id,
                                tactic: "STAGE GUIDE",
                                prospect_signal: prospectText,
                                insight: "",
                                talking_points: shot.say_this ? [shot.say_this] : [],
                                objection_label: null,
                                next_milestone: stage.goal,
                                stage_progress: `${i + 1}/6`,
                              });
                            }}
                            className="text-sm px-4 py-2 rounded-full bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white transition-colors text-left"
                          >
                            {(shot.prospect ?? "").length > 40
                              ? `${(shot.prospect ?? "").slice(0, 40)}...`
                              : (shot.prospect ?? "")}
                          </button>
                        ))}

                        {i === 0 && (
                          <button
                            onClick={() => mapToObjectionNavigation("no_budget", "No Budget")}
                            className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors"
                          >
                            No Budget
                          </button>
                        )}
                        {i === 2 && (
                          <button
                            onClick={() => mapToObjectionNavigation("deadline_extended", "Deadline Extended")}
                            className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors"
                          >
                            Deadline Extended
                          </button>
                        )}
                        {i === 3 && (
                          <>
                            <button onClick={() => mapToCompetitorNavigation("overlay", "AudioEye / Overlays")} className="text-sm px-4 py-2 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">AudioEye</button>
                            <button onClick={() => mapToCompetitorNavigation("civicplus_granicus", "CivicPlus / Granicus")} className="text-sm px-4 py-2 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">CivicPlus</button>
                            <button onClick={() => mapToCompetitorNavigation("equidox", "Equidox")} className="text-sm px-4 py-2 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors">Equidox</button>
                            <button onClick={() => mapToObjectionNavigation("no_budget", "No Budget")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">No Budget</button>
                            <button onClick={() => mapToObjectionNavigation("cant_modify_cms", "Can't Modify CMS")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Can&apos;t Modify CMS</button>
                          </>
                        )}
                        {i === 4 && (
                          <>
                            <button onClick={() => mapToObjectionNavigation("too_complex", "Too Complex")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Too Complex</button>
                            <button onClick={() => mapToObjectionNavigation("bulk_remediation", "Bulk Remediation")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Bulk Remediation</button>
                          </>
                        )}
                        {i === 5 && (
                          <>
                            <button onClick={() => mapToObjectionNavigation("not_my_decision", "Not My Decision")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Not My Decision</button>
                            <button onClick={() => mapToObjectionNavigation("too_busy", "Too Busy")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Too Busy</button>
                            <button onClick={() => mapToObjectionNavigation("send_email", "Send Email")} className="text-sm px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-colors">Send Email</button>
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
                          className="w-full rounded-lg border border-gray-700 bg-gray-800/60 py-2.5 text-sm font-semibold text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
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
            <div className="flex-1 overflow-y-auto custom-scrollbar pb-4">
              <div className="px-4 pt-4 pb-3 border-b border-gray-800/60">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search objections, competitors, personas..."
                  className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              {searchQuery.trim().length === 0 ? (
                <div className="px-4 py-3 space-y-5">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">COMPETITORS</p>
                    {GUIDE_COMPETITORS.map((item) => (
                      <button key={item.key} onClick={() => mapToCompetitorNavigation(item.key, item.name)} disabled={!competitors[item.key]}
                        className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                        <span>{item.name}</span>
                        <span className="text-xs text-red-400/60 uppercase font-bold">Competitor</span>
                      </button>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">OBJECTIONS</p>
                    {GUIDE_OBJECTION_GROUPS.flatMap((g) => g.items).map((item) => (
                      <button key={item.key} onClick={() => mapToObjectionNavigation(item.key, item.name)} disabled={!objections[item.key]}
                        className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                        <span>{item.name}</span>
                        <span className="text-xs text-amber-400/60 uppercase font-bold">Objection</span>
                      </button>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">PERSONAS</p>
                    {GUIDE_PERSONAS.map((item) => (
                      <button key={item.key} onClick={() => mapToPersonaNavigation(item.key, item.name)} disabled={!personas[item.key]}
                        className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                        <span>{item.name}</span>
                        <span className="text-xs text-blue-400/60 uppercase font-bold">Persona</span>
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
                          className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                          <span>{item.name}</span>
                          <span className="text-xs text-red-400/60 uppercase font-bold">Competitor</span>
                        </button>
                      ))}
                      {objectionResults.map((item) => (
                        <button key={item.key} onClick={() => { mapToObjectionNavigation(item.key, item.name); setSearchQuery(""); }} disabled={!objections[item.key]}
                          className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                          <span>{item.name}</span>
                          <span className="text-xs text-amber-400/60 uppercase font-bold">Objection</span>
                        </button>
                      ))}
                      {personaResults.map((item) => (
                        <button key={item.key} onClick={() => { mapToPersonaNavigation(item.key, item.name); setSearchQuery(""); }} disabled={!personas[item.key]}
                          className="w-full px-3 py-3 text-left text-sm text-gray-300 hover:bg-gray-800/60 hover:text-white rounded-lg transition-colors disabled:opacity-40 flex items-center justify-between">
                          <span>{item.name}</span>
                          <span className="text-xs text-blue-400/60 uppercase font-bold">Persona</span>
                        </button>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>
          )}
        </div>

        <div className="w-1/2 flex flex-col bg-gray-900/50">
          <div className="min-h-0 flex flex-col overflow-hidden" style={{ height: `${COACHING_PANEL_HEIGHT_PCT}%` }}>
            <div className="px-6 py-4 border-b border-gray-800/60">
              <div className="flex gap-1 mb-3">
                {STAGE_LABELS.map((label, i) => {
                  const step = i + 1;
                  const isActive = step === currentStageNum;
                  const isDone = step < currentStageNum;
                  return (
                    <button
                      key={label}
                      onClick={() => {
                        const stage = stages[i];
                        if (stage) mapToStageNavigation(stage);
                      }}
                      className="flex-1 flex flex-col items-center gap-2 group cursor-pointer hover:opacity-80 transition-opacity"
                    >
                      <div
                        className={`h-1.5 w-full rounded-full transition-all duration-500 ${
                          isDone
                            ? "bg-emerald-500 group-hover:bg-emerald-400"
                            : isActive
                              ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                              : "bg-gray-700"
                        }`}
                      />
                      <span
                        className={`uppercase tracking-wider transition-colors ${
                          isDone
                            ? "text-xs text-emerald-400"
                            : isActive
                              ? "text-xs font-bold text-blue-200"
                              : "text-[10px] text-gray-500"
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
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 px-4 py-1.5">
                      <span className="text-sm font-bold text-blue-400">{activeNavigation.stage}</span>
                    </span>
                  )}
                </div>
                {activeNavigation?.objection_label && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-1.5 objection-flash">
                    <div className="h-1.5 w-1.5 rounded-full bg-red-400" />
                    <span className="text-sm font-bold text-red-400">{activeNavigation.objection_label}</span>
                  </span>
                )}
              </div>
            </div>

            {activeNavigation?.tactic && (
              <div className="px-6 pt-4">
                <span className="inline-block rounded-md bg-gray-800 px-3 py-1 text-xs font-bold uppercase tracking-[0.15em] text-gray-300">
                  {activeNavigation.tactic}
                </span>
              </div>
            )}

            {activeNavigation?.objection_label && (
              <div className="mx-6 mb-3 rounded-lg bg-amber-500/15 border border-amber-500/30 px-4 py-2.5 flex items-center gap-2 objection-flash">
                <div className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-sm font-bold text-amber-300">OBJECTION: {activeNavigation.objection_label}</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
              {!guideNavigation ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <span className="text-2xl text-gray-600 mb-2">⬡</span>
                  <p className="text-sm text-gray-500 whitespace-pre-line">{`Click any card on the left
to see talking points and guidance.`}</p>
                </div>
              ) : (
                <>
                  {activeNavigation && activeNavigation.talking_points.length > 0 && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-emerald-400 mb-2">Say This</p>
                      <div key={activeNavigation.talking_points.join("")} className="content-flash rounded-lg">
                        <ul className="space-y-2">
                          {activeNavigation.talking_points.map((point, i) => {
                            const firstSentenceEnd = point.search(/[.!?](\s|$)/);
                            const firstSentence = firstSentenceEnd > 0 ? point.slice(0, firstSentenceEnd + 1) : point;
                            const hasMore = firstSentence.length < point.length;
                            const isExpanded = expandedTalkingPoints.has(i);

                            return (
                              <li key={i} className="flex items-start gap-2.5 transition-all duration-500 ease-in-out">
                                <span className="text-emerald-400 mt-0.5 text-base shrink-0">•</span>
                                <div className="min-w-0 flex-1">
                                  <p className="text-lg font-semibold text-white leading-snug">
                                    {isExpanded ? point : firstSentence}
                                  </p>
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
                                <button
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(point);
                                      setCopiedIndex(i);
                                      setTimeout(() => setCopiedIndex(null), 1500);
                                    } catch (error) {
                                      console.error("Failed to copy talking point:", error);
                                      setCopiedIndex(null);
                                    }
                                  }}
                                  className="ml-auto text-gray-600 hover:text-gray-300 text-xs px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                                  aria-label={`Copy talking point ${i + 1} to clipboard`}
                                  title={copiedIndex === i ? "Copied!" : "Copy talking point"}
                                >
                                  {copiedIndex === i ? <span className="copy-confirm">{COPIED_ICON}</span> : <span>{COPY_ICON}</span>}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  )}

                  {activeNavigation?.prospect_signal && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-1.5">🔵 What&apos;s Happening</p>
                      <p className="text-sm leading-relaxed text-gray-200 transition-all duration-500 ease-in-out whitespace-pre-line">{activeNavigation.prospect_signal}</p>
                    </div>
                  )}

                  {activeNavigation?.insight && (
                    <div>
                      <p className="text-xs font-bold uppercase tracking-widest text-amber-400 mb-1.5">💡 Your Angle</p>
                      <p className="text-sm leading-relaxed text-gray-200 transition-all duration-500 ease-in-out whitespace-pre-line">{activeNavigation.insight}</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {activeNavigation?.next_milestone && (
              <div className="px-6 py-4 border-t border-gray-800/60">
                <div className="flex items-start gap-2">
                  <span className="text-blue-500 mt-0.5 text-sm">→</span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-500 mb-0.5">Next Goal</p>
                    <p className="text-sm text-gray-300 leading-relaxed">{activeNavigation.next_milestone}</p>
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
    </div>
  );
}
