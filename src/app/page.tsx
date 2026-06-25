"use client";

import { useEffect, useRef, useState } from "react";
import {
  api,
  type JobStatus,
  type ModelInfo,
  type Scene,
  type VideoInfo,
} from "@/lib/api";
import ConfigPanel, { type Settings } from "./components/ConfigPanel";
import ResultView from "./components/ResultView";
import CompareView from "./components/CompareView";
import ConfidenceSparkline from "./components/ConfidenceSparkline";
import AssetDebugPanel from "./components/AssetDebugPanel";
import { readModelPrefs } from "@/lib/prefs";
import { loadDemoHistory, loadHistory, saveHistory, type RunRecord } from "@/lib/history";

/** Find the best run in history that can be compared to `run` (same clip, different model). */
function comparablePartner(run: RunRecord, history: RunRecord[]): RunRecord | null {
  return (
    history.find(
      (r) =>
        r.id !== run.id &&
        r.level === run.level &&
        Math.abs(r.start - run.start) <= 2 &&
        Math.abs(r.end - run.end) <= 2 &&
        r.model !== run.model,
    ) ?? null
  );
}

function levelFromVideo(video: string): number | null {
  const m = /^builtin:(\d+)$/.exec(video);
  return m ? Number(m[1]) : null;
}

const DEFAULT_SETTINGS: Settings = {
  video: "builtin:1",
  model: "",
  conf: 0.15,
  iou: 0.3,
  backend: "auto",
  start_sec: 0,
  duration_sec: 5,
  frame_stride: 1,
  bridge_gaps: false,
  bridge_max_gap_frames: 2,
  suppress_flicker_boxes: false,
  suppress_min_hits: 3,
  show_light_off: false,
  show_box_labels: false,
  max_width: 854,
  replay_speed: 1,
};

const IS_DEV = process.env.NODE_ENV === "development";

export default function Home() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeSceneName, setActiveSceneName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [demoSaveStatus, setDemoSaveStatus] = useState<string | null>(null);
  const [compareRuns, setCompareRuns] = useState<{ a: RunRecord; b: RunRecord } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hydrated = useRef(false);

  const selectedRun = history.find((r) => r.id === selectedRunId) ?? history[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    async function restoreHistory() {
      const local = loadHistory();
      const restored = local.length > 0 ? local : await loadDemoHistory();
      if (cancelled) return;
      if (restored.length > 0) {
        setHistory(restored);
        setSelectedRunId(restored[0].id);
      }
      hydrated.current = true;
    }
    void restoreHistory();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    saveHistory(history);
  }, [history]);

  const refreshLists = async (selectFirst = false) => {
    try {
      const [m, v] = await Promise.all([api.listModels(), api.listVideos()]);
      setModels(m);
      setVideos(v);
      setLoadError(null);
      if (selectFirst) {
        const prefs = readModelPrefs();
        const preferredModel =
          prefs.defaultModel && m.some((x) => x.id === prefs.defaultModel)
            ? prefs.defaultModel
            : m[0]?.id || "";
        setSettings((s) => ({
          ...s,
          model: s.model || preferredModel,
          conf: prefs.defaultConf || s.conf,
          video:
            s.video ||
            v.find((x) => x.id === "builtin:1")?.id ||
            v.find((x) => x.source === "builtin")?.id ||
            v[0]?.id ||
            "",
        }));
      }
      return v;
    } catch {
      setLoadError(
        "Could not reach the backend. Start it with: uvicorn app:app --port 8000 (in webapp/backend).",
      );
      return [];
    }
  };

  const loadScenes = async () => {
    try {
      setScenes(await api.listScenes());
    } catch {
      /* backend offline message already handled by refreshLists */
    }
  };

  useEffect(() => {
    refreshLists(true);
    loadScenes();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (next: Partial<Settings>) => {
    if (next.video != null || next.start_sec != null || next.duration_sec != null) {
      setActiveSceneName(null);
    }
    setSettings((s) => ({ ...s, ...next }));
  };

  const handleUpload = async (file: File) => {
    const info = await api.upload(file);
    await refreshLists();
    setSettings((s) => ({ ...s, video: info.id }));
  };

  const busy = !!job && (job.status === "queued" || job.status === "running");

  const submit = async (cfg: Settings, label: string) => {
    setError(null);
    setCompareRuns(null);
    setJob({ id: "", status: "queued", progress: 0, message: "Submitting", error: null });
    try {
      const jobId = await api.analyze(cfg);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.jobStatus(jobId);
          setJob(status);
          if (status.status === "done") {
            if (pollRef.current) clearInterval(pollRef.current);
            const res = await api.jobResult(jobId);
            const modelLabel = models.find((m) => m.id === cfg.model)?.label ?? cfg.model;
            const record: RunRecord = {
              id: jobId,
              at: Date.now(),
              label,
              model: modelLabel,
              level: levelFromVideo(cfg.video),
              start: cfg.start_sec,
              end: cfg.start_sec + cfg.duration_sec,
              result: res,
            };
            setHistory((h) => [record, ...h.filter((r) => r.id !== jobId)].slice(0, 20));
            setSelectedRunId(jobId);
          } else if (status.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setError(status.error ?? "Analysis failed.");
          }
        } catch (e) {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(String(e));
        }
      }, 700);
    } catch (e) {
      setError(String(e));
      setJob(null);
    }
  };

  const segmentLabel = (cfg: Settings) => {
    const lvl = levelFromVideo(cfg.video);
    const where = lvl != null ? `Level ${lvl}` : videos.find((v) => v.id === cfg.video)?.label ?? "segment";
    return `${where} · ${cfg.start_sec.toFixed(0)}–${(cfg.start_sec + cfg.duration_sec).toFixed(0)}s`;
  };

  const handleAnalyze = () => submit(settings, activeSceneName ?? segmentLabel(settings));

  const saveCurrentHistoryAsDemo = async () => {
    if (!IS_DEV || history.length === 0) return;
    setDemoSaveStatus("Saving demo history...");
    try {
      const res = await fetch("/api/dev/demo-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history }),
      });
      const data = (await res.json().catch(() => ({}))) as { count?: number; path?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDemoSaveStatus(`Saved ${data.count ?? history.length} runs to ${data.path ?? "public/demo-runs/history.json"}.`);
    } catch (err) {
      setDemoSaveStatus(`Could not save demo history: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const loadScene = (scene: Scene): Settings => {
    const cfg: Settings = {
      ...settings,
      video: `builtin:${scene.level}`,
      start_sec: Math.max(0, Math.round(scene.start)),
      duration_sec: Math.max(1, Math.round(scene.end - scene.start)),
    };
    setSettings(cfg);
    setActiveSceneName(scene.name);
    return cfg;
  };

  const runScene = (scene: Scene) => {
    const cfg = loadScene(scene);
    submit(cfg, scene.name || segmentLabel(cfg));
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-950/50 px-6 py-4">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">
              Run_v2 Video Inspector
            </h1>
            <p className="text-xs text-slate-500">
              YOLO26 detection · IoU tracking · model-health scoring · temporal gap bridging
            </p>
          </div>
          <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-400">
            {models.length} models · {videos.length} videos
          </span>
        </div>
      </header>

      {/* Run history — full width */}
      {history.length > 0 && (
        <div className="border-b border-slate-800 bg-slate-950/30 px-6 py-3">
          <div className="mx-auto max-w-[1500px]">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Run history ({history.length})
              </h3>
              <div className="flex items-center gap-3">
                {IS_DEV && (
                  <button
                    onClick={saveCurrentHistoryAsDemo}
                    className="text-[11px] text-sky-400 hover:text-sky-300"
                    title="Write current local run history to public/demo-runs/history.json"
                  >
                    Save demo
                  </button>
                )}
                <button
                  onClick={() => {
                    setHistory([]);
                    setSelectedRunId(null);
                  }}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Clear
                </button>
              </div>
            </div>
            {IS_DEV && demoSaveStatus && (
              <p className="mb-2 rounded border border-slate-800 bg-slate-950/50 px-2 py-1 text-[11px] text-slate-400">
                {demoSaveStatus}
              </p>
            )}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {history.map((r) => {
                const partner = comparablePartner(r, history);
                const isComparing =
                  compareRuns != null &&
                  ((compareRuns.a.id === r.id) || (compareRuns.b.id === r.id));
                return (
                  <div
                    key={r.id}
                    className={`group w-64 shrink-0 rounded-xl border p-2.5 transition ${
                      isComparing
                        ? "border-violet-500/70 bg-violet-500/10"
                        : selectedRun?.id === r.id
                          ? "border-sky-500/70 bg-sky-500/10"
                          : "border-slate-800"
                    }`}
                  >
                    <div className="relative">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = history.filter((x) => x.id !== r.id);
                          setHistory(next);
                          if (selectedRunId === r.id) setSelectedRunId(next[0]?.id ?? null);
                          if (compareRuns?.a.id === r.id || compareRuns?.b.id === r.id) setCompareRuns(null);
                        }}
                        className="absolute -right-1 -top-1 hidden rounded-full border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:border-red-600 hover:text-red-400 group-hover:flex"
                        title="Remove this run"
                      >
                        ✕
                      </button>
                    <button
                      onClick={() => { setSelectedRunId(r.id); setCompareRuns(null); }}
                      className="w-full text-left"
                      title={`${r.label} · ${r.model}`}
                    >
                      <div className="line-clamp-1 text-sm font-medium leading-snug text-slate-100">
                        {r.label}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400" title={r.model}>
                        {r.model.replace(/^Level\s+\d+\s*[-–]\s*/i, "")}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                        {r.level != null ? `L${r.level} · ` : ""}
                        {r.start.toFixed(0)}–{r.end.toFixed(0)}s · {new Date(r.at).toLocaleTimeString()}
                      </div>
                      <div className="mt-1.5 overflow-hidden rounded-md border border-slate-800/60">
                        <ConfidenceSparkline
                          frames={r.result.frames}
                          classColors={r.result.class_colors}
                          height={36}
                        />
                      </div>
                    </button>
                    </div>
                    {partner && (
                      <button
                        onClick={() => setCompareRuns(isComparing ? null : { a: r, b: partner })}
                        className={`mt-2 w-full rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                          isComparing
                            ? "border-violet-500/60 bg-violet-500/15 text-violet-300"
                            : "border-slate-700 text-slate-400 hover:border-violet-600 hover:text-violet-300"
                        }`}
                      >
                        ⇄ Compare
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[320px_1fr]">
        {/* Sidebar */}
        <aside className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 lg:sticky lg:top-6 lg:h-fit">
          {loadError && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              <p>{loadError}</p>
              <button
                type="button"
                onClick={() => refreshLists(true)}
                className="mt-2 rounded bg-amber-500/20 px-2 py-1 font-medium text-amber-100 hover:bg-amber-500/30"
              >
                Retry connection
              </button>
            </div>
          )}

          <ConfigPanel
            models={models}
            videos={videos}
            scenes={scenes}
            settings={settings}
            activeSceneName={activeSceneName}
            onChange={update}
            onUpload={handleUpload}
            onAnalyze={handleAnalyze}
            onLoadScene={loadScene}
            onRunScene={runScene}
            busy={busy}
          />

          {/* Asset debug — collapsed by default */}
          <CollapsibleBlock title="Asset debug">
            <AssetDebugPanel
              selectedModelId={settings.model}
              selectedVideoId={settings.video}
              startSec={settings.start_sec}
              durationSec={settings.duration_sec}
              videos={videos}
              scenes={scenes}
            />
          </CollapsibleBlock>
        </aside>

        {/* Main content */}
        <section className="min-w-0">
          {busy && job && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8">
              <div className="mb-3 flex items-center justify-between text-sm">
                <span className="text-slate-300">{job.message}</span>
                <span className="font-mono text-slate-400">
                  {Math.round(job.progress * 100)}%
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all"
                  style={{ width: `${Math.max(2, job.progress * 100)}%` }}
                />
              </div>
              <p className="mt-4 text-xs text-slate-500">
                Running detection per frame on the selected segment. Larger durations, smaller
                strides, and bigger models take longer.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
              <p className="font-semibold">Analysis error</p>
              <p className="mt-1 break-words font-mono text-xs">{error}</p>
            </div>
          )}

          {!busy && compareRuns && (
            <CompareView
              key={`${compareRuns.a.id}-${compareRuns.b.id}`}
              runA={compareRuns.a}
              runB={compareRuns.b}
              onExit={() => setCompareRuns(null)}
            />
          )}

          {!busy && !compareRuns && selectedRun && (
            <ResultView
              key={selectedRun.id}
              jobId={selectedRun.id}
              result={selectedRun.result}
              initialPlotMode="confidence"
            />
          )}

          {!busy && !error && history.length === 0 && (
            <div className="flex h-[60vh] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 text-center">
              <div className="text-5xl">🎬</div>
              <h2 className="mt-4 text-lg font-medium text-slate-300">
                Configure a segment, then Analyze
              </h2>
              <p className="mt-1 max-w-md text-sm text-slate-500">
                Pick a model and video on the left, choose a start time and duration, or pick a
                saved scene. Each run is kept here with its confidence plot so you can compare
                over time.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function CollapsibleBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-400"
      >
        <span>{title}</span>
        <span className="text-[10px] text-slate-600">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
