"use client";

import { useEffect, useRef, useState } from "react";
import { api, type AnalysisResult, type JobStatus, type ModelInfo } from "@/lib/api";
import { readModelPrefs, useModelPrefs } from "@/lib/prefs";
import ModelPicker from "./ModelPicker";
import ModelDetails from "./ModelDetails";
import ResultView from "./ResultView";

type Props = {
  level: number;
  start: number;
  end: number;
};

export default function SceneInference({ level, start, end }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelId, setModelId] = useState("");
  const [conf, setConf] = useState(0.15);
  const [replaySpeed, setReplaySpeed] = useState(0.5);
  const [showLabels, setShowLabels] = useState(false);
  // Gap-bridging draws magenta "PRED #" boxes where a track briefly dropped out.
  // Off by default so the plot/clip only show real detections.
  const [bridgeGaps, setBridgeGaps] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { prefs, setDefaults } = useModelPrefs();

  useEffect(() => {
    api
      .listModels()
      .then((m) => {
        setModels(m);
        const p = readModelPrefs();
        const preferred =
          p.defaultModel && m.some((x) => x.id === p.defaultModel) ? p.defaultModel : m[0]?.id || "";
        setModelId((id) => id || preferred);
        setConf(p.defaultConf);
      })
      .catch(() => setError("Could not load models."));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const defaultModelLabel =
    models.find((m) => m.id === prefs.defaultModel)?.label ?? (prefs.defaultModel ? prefs.defaultModel : "first model");
  const selectedModel = models.find((m) => m.id === modelId);
  const isCurrentDefault = prefs.defaultModel === modelId && prefs.defaultConf === conf;

  const busy = !!job && (job.status === "queued" || job.status === "running");

  const run = async () => {
    setError(null);
    setResult(null);
    setJob({ id: "", status: "queued", progress: 0, message: "Submitting", error: null });
    try {
      const jobId = await api.analyze({
        video: `builtin:${level}`,
        model: modelId,
        conf,
        iou: 0.3,
        backend: "auto",
        start_sec: start,
        duration_sec: Math.max(0.2, end - start),
        frame_stride: 1,
        bridge_gaps: bridgeGaps,
        bridge_max_gap_frames: 2,
        suppress_flicker_boxes: false,
        suppress_min_hits: 3,
        show_light_off: false,
        show_box_labels: showLabels,
        max_width: 854,
        replay_speed: replaySpeed,
      });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const st = await api.jobStatus(jobId);
          setJob(st);
          if (st.status === "done") {
            if (pollRef.current) clearInterval(pollRef.current);
            setResult(await api.jobResult(jobId));
          } else if (st.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setError(st.error ?? "Analysis failed.");
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[min(100%,20rem)] flex-col text-xs text-slate-400">
          Model
          <span className="mt-1">
            <ModelPicker models={models} value={modelId} onChange={setModelId} />
          </span>
          <ModelDetails model={selectedModel} />
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          Conf {conf.toFixed(2)}
          <input
            type="range"
            min={0.05}
            max={0.9}
            step={0.05}
            value={conf}
            onChange={(e) => setConf(Number(e.target.value))}
            className="mt-2 w-32"
          />
        </label>
        <label className="flex flex-col text-xs text-slate-400">
          Replay
          <select
            className="mt-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-sm text-slate-200"
            value={replaySpeed}
            onChange={(e) => setReplaySpeed(Number(e.target.value))}
          >
            <option value={1}>1×</option>
            <option value={0.5}>0.5×</option>
            <option value={0.25}>0.25×</option>
            <option value={0.1}>0.1×</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => setShowLabels((v) => !v)}
          aria-pressed={showLabels}
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition ${
            showLabels
              ? "border-sky-500 bg-sky-500/15 text-sky-200"
              : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500"
          }`}
          title="Draw class/label names on the detection boxes"
        >
          <span
            className={`relative h-4 w-7 rounded-full transition ${
              showLabels ? "bg-sky-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                showLabels ? "left-3.5" : "left-0.5"
              }`}
            />
          </span>
          Box labels
        </button>
        <button
          type="button"
          onClick={() => setBridgeGaps((v) => !v)}
          aria-pressed={bridgeGaps}
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition ${
            bridgeGaps
              ? "border-fuchsia-500 bg-fuchsia-500/15 text-fuchsia-200"
              : "border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-500"
          }`}
          title="Draw magenta PRED # boxes to bridge frames where a detection briefly drops out"
        >
          <span
            className={`relative h-4 w-7 rounded-full transition ${
              bridgeGaps ? "bg-fuchsia-500" : "bg-slate-600"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                bridgeGaps ? "left-3.5" : "left-0.5"
              }`}
            />
          </span>
          Bridge gaps
        </button>
        <button
          onClick={run}
          disabled={busy || !modelId}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run inference"}
        </button>
        <span className="text-xs text-slate-500">
          {start.toFixed(2)}–{end.toFixed(2)}s ({(end - start).toFixed(2)}s)
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <button
          type="button"
          onClick={() => setDefaults(modelId, conf)}
          disabled={!modelId || isCurrentDefault}
          className="rounded border border-slate-700 px-2 py-0.5 text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          title="Use this model + confidence as the default for new runs"
        >
          {isCurrentDefault ? "✓ Current is default" : "Set as default"}
        </button>
        <span>
          Default: <span className="text-slate-300">{defaultModelLabel}</span> · conf{" "}
          <span className="font-mono text-slate-300">{prefs.defaultConf.toFixed(2)}</span>
        </span>
        <span className="text-slate-600">· ☆ star a model to favourite it</span>
      </div>

      {busy && job && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-400">
            <span>{job.message}</span>
            <span>{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{ width: `${Math.max(2, job.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="break-words rounded-lg border border-red-500/40 bg-red-500/10 p-2 font-mono text-xs text-red-200">
          {error}
        </p>
      )}

      {result && job && <ResultView jobId={job.id} result={result} />}
    </div>
  );
}
