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
import ConfidenceSparkline from "./components/ConfidenceSparkline";
import AssetDebugPanel from "./components/AssetDebugPanel";
import { readModelPrefs } from "@/lib/prefs";
import { loadHistory, saveHistory, type RunRecord } from "@/lib/history";

function levelFromVideo(video: string): number | null {
  const m = /^builtin:(\d+)$/.exec(video);
  return m ? Number(m[1]) : null;
}

const DEFAULT_SETTINGS: Settings = {
  video: "",
  model: "",
  conf: 0.15,
  iou: 0.3,
  backend: "auto",
  start_sec: 300,
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hydrated = useRef(false);

  const selectedRun = history.find((r) => r.id === selectedRunId) ?? history[0] ?? null;

  // Restore persisted run history once on the client (avoids SSR mismatch).
  useEffect(() => {
    const h = loadHistory();
    if (h.length > 0) {
      setHistory(h);
      setSelectedRunId(h[0].id);
    }
    hydrated.current = true;
  }, []);

  // Persist whenever history changes (but not before the initial restore).
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
          video: s.video || v.find((x) => x.source === "builtin")?.id || v[0]?.id || "",
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
    // Manual edits to the segment detach it from the loaded scene label.
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

      <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[340px_1fr]">
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
            settings={settings}
            onChange={update}
            onUpload={handleUpload}
            onAnalyze={handleAnalyze}
            busy={busy}
          />

          <AssetDebugPanel
            selectedModelId={settings.model}
            selectedVideoId={settings.video}
            startSec={settings.start_sec}
            durationSec={settings.duration_sec}
            videos={videos}
            scenes={scenes}
          />

          <div className="mt-5 border-t border-slate-800 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Saved scenes
              </h3>
              <a href="/scenes" className="text-[11px] text-sky-400 hover:text-sky-300">
                Manage →
              </a>
            </div>
            {scenes.length === 0 ? (
              <p className="text-xs text-slate-500">
                No saved scenes yet. Add them in the Scene Library.
              </p>
            ) : (
              <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
                {scenes.map((sc) => {
                  const isActive =
                    activeSceneName === sc.name &&
                    settings.video === `builtin:${sc.level}` &&
                    Math.round(settings.start_sec) === Math.round(sc.start);
                  return (
                    <li
                      key={sc.id}
                      className={`flex items-center gap-2 rounded-lg border p-2 ${
                        isActive ? "border-sky-500/50 bg-sky-500/5" : "border-slate-800"
                      }`}
                    >
                      <button
                        onClick={() => loadScene(sc)}
                        className="min-w-0 flex-1 text-left"
                        title="Load this segment into the config"
                      >
                        <div className="truncate text-sm text-slate-100">
                          {sc.name || `scene @ ${sc.start.toFixed(1)}s`}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">
                          L{sc.level} · {sc.start.toFixed(1)}–{sc.end.toFixed(1)}s
                        </div>
                      </button>
                      <button
                        onClick={() => runScene(sc)}
                        disabled={busy}
                        className="shrink-0 rounded-md border border-sky-700 px-2 py-1 text-xs text-sky-300 transition hover:bg-sky-900/40 disabled:opacity-40"
                        title="Load and analyze now"
                      >
                        ▶ Run
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Content */}
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
                Running detection per frame on the selected segment. Larger
                durations, smaller strides, and bigger models take longer.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
              <p className="font-semibold">Analysis error</p>
              <p className="mt-1 break-words font-mono text-xs">{error}</p>
            </div>
          )}

          {history.length > 0 && (
            <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Run history ({history.length})
                </h3>
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
              <div className="flex gap-3 overflow-x-auto pb-1">
                {history.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRunId(r.id)}
                    className={`w-80 shrink-0 rounded-xl border p-3 text-left transition ${
                      selectedRun?.id === r.id
                        ? "border-sky-500/70 bg-sky-500/10"
                        : "border-slate-800 hover:border-slate-600"
                    }`}
                    title={`${r.label} · ${r.model}`}
                  >
                    <div className="line-clamp-2 text-sm font-medium leading-snug text-slate-100">
                      {r.label}
                    </div>
                    <div className="mt-1.5 rounded-lg border border-slate-800/80 bg-slate-950/40 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-slate-600">Model</div>
                      <div className="break-words font-mono text-[11px] leading-snug text-slate-300">
                        {r.model}
                      </div>
                    </div>
                    <div className="mb-2 mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
                      <span>
                        {r.level != null ? `L${r.level} · ` : ""}
                        {r.start.toFixed(0)}-{r.end.toFixed(0)}s
                      </span>
                      <span>{new Date(r.at).toLocaleTimeString()}</span>
                    </div>
                    <div className="overflow-hidden rounded-md border border-slate-800/60">
                      <ConfidenceSparkline
                        frames={r.result.frames}
                        classColors={r.result.class_colors}
                        height={44}
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!busy && selectedRun && (
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
                Pick a model and video on the left, choose a start time and
                duration, or pick a saved scene. Each run is kept here with its
                confidence plot so you can compare over time.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
