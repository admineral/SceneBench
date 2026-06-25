"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Scene, type VideoInfo } from "@/lib/api";
import {
  ORT_ASSET_PATHS,
  cacheAsset,
  canUseAssetCache,
  checkAsset,
  clearAssetCache,
  clearSceneBenchLocalStorage,
  formatBytes,
  storageUsage,
  type AssetState,
  type AssetTarget,
  type StorageUsage,
} from "@/lib/asset-cache";
import {
  getModelLoadState,
  loadModel,
  modelConfig,
  subscribeModelLoadState,
  type ModelLoadState,
} from "@/lib/yolo";

type Props = {
  selectedModelId: string;
  selectedVideoId: string;
  startSec: number;
  durationSec: number;
  videos: VideoInfo[];
  scenes: Scene[];
};

const EMPTY_STATE: AssetState = { status: "idle" };

export default function AssetDebugPanel({
  selectedModelId,
  selectedVideoId,
  startSec,
  durationSec,
  videos,
  scenes,
}: Props) {
  const [states, setStates] = useState<Record<string, AssetState>>({});
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<StorageUsage>({});
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [assetCacheSupported, setAssetCacheSupported] = useState<boolean | null>(null);
  const [crossOriginIsolated, setCrossOriginIsolated] = useState<boolean | null>(null);
  const [modelLoad, setModelLoad] = useState<ModelLoadState>(
    selectedModelId ? getModelLoadState(selectedModelId) : { id: "", status: "idle" },
  );

  const updateState = useCallback((id: string, state: AssetState) => {
    setStates((current) => ({ ...current, [id]: state }));
  }, []);

  const targets = useMemo(() => {
    const items: AssetTarget[] = [
      {
        id: "scene-manifest",
        label: "Scene manifest",
        url: "/scenes/manifest.json",
        kind: "manifest",
      },
      ...ORT_ASSET_PATHS.map((url) => ({
        id: `ort:${url}`,
        label: url.split("/").pop() ?? url,
        url,
        kind: "runtime" as const,
      })),
    ];

    if (selectedModelId) {
      const model = modelConfig(selectedModelId);
      items.push({
        id: `model:${model.id}`,
        label: `${model.id} ONNX model`,
        url: model.path,
        kind: "model",
      });
    }

    const level = levelFromVideo(selectedVideoId);
    const selectedVideo = videos.find((video) => video.id === selectedVideoId);
    if (level != null) {
      items.push({
        id: `video:level:${level}`,
        label: `Level ${level} preview video`,
        url: api.rawVideoUrl(level),
        kind: "video",
      });

      const endSec = startSec + durationSec;
      const matchingScene = scenes.find(
        (scene) =>
          scene.level === level &&
          !!scene.clip_src &&
          startSec >= scene.start - 0.75 &&
          endSec <= scene.end + 0.75,
      );
      if (matchingScene?.clip_src) {
        items.push({
          id: `clip:${matchingScene.id}`,
          label: `Matching clip: ${matchingScene.name || matchingScene.id}`,
          url: matchingScene.clip_src,
          kind: "video",
        });
      }
    } else if (selectedVideo?.source === "upload") {
      items.push({
        id: "video:upload",
        label: "Uploaded video",
        url: "",
        kind: "video",
      });
    }

    return dedupeTargets(items);
  }, [durationSec, scenes, selectedModelId, selectedVideoId, startSec, videos]);

  const refreshUsage = useCallback(async () => {
    setUsage(await storageUsage());
  }, []);

  useEffect(() => {
    setAssetCacheSupported(canUseAssetCache());
    setCrossOriginIsolated(typeof self !== "undefined" ? self.crossOriginIsolated : false);
  }, []);

  useEffect(() => {
    if (!selectedModelId) {
      setModelLoad({ id: "", status: "idle" });
      return;
    }

    const activeModelId = modelConfig(selectedModelId).id;
    setModelLoad(getModelLoadState(selectedModelId));
    return subscribeModelLoadState((state) => {
      if (state.id === activeModelId) setModelLoad(state);
    });
  }, [selectedModelId]);

  const checkAll = useCallback(async () => {
    setBusy(true);
    try {
      await refreshUsage();
      await Promise.all(
        targets.map(async (target) => {
          if (!target.url) {
            updateState(target.id, {
              status: "unsupported",
              message: "Uploaded files are tab-local object URLs and cannot persist after reload.",
            });
            return;
          }
          updateState(target.id, { status: "checking" });
          const state = await checkAsset(target);
          updateState(target.id, state);
        }),
      );
      setLastChecked(Date.now());
    } finally {
      setBusy(false);
    }
  }, [refreshUsage, targets, updateState]);

  useEffect(() => {
    void checkAll();
  }, [checkAll]);

  const cacheSelected = async () => {
    setBusy(true);
    try {
      for (const target of targets) {
        if (!target.url) continue;
        updateState(target.id, { status: "loading", message: "Starting..." });
        const state = await cacheAsset(target, (next) => updateState(target.id, next));
        updateState(target.id, state);
      }
      await refreshUsage();
      setLastChecked(Date.now());
    } finally {
      setBusy(false);
    }
  };

  const warmModel = async () => {
    if (!selectedModelId) return;
    setBusy(true);
    try {
      await loadModel(selectedModelId);
    } finally {
      setBusy(false);
    }
  };

  const cachedCount = targets.filter((target) => states[target.id]?.status === "cached").length;
  const readyCount = targets.filter((target) => {
    const status = states[target.id]?.status;
    return status === "cached" || status === "reachable";
  }).length;
  const progress = targets.length > 0 ? (readyCount / targets.length) * 100 : 0;

  return (
    <div className="mt-5 border-t border-slate-800 pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Vercel asset debug
          </h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Models/clips: HTTP cache automatically, Cache Storage on demand.
          </p>
        </div>
        <span className="font-mono text-[11px] text-slate-400">
          {readyCount}/{targets.length}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${progress}%` }} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>
          Explicit cache: <span className="font-mono text-slate-300">{cachedCount}</span>
        </span>
        <span>
          Storage:{" "}
          <span className="font-mono text-slate-300">
            {formatBytes(usage.usedBytes)}
            {usage.quotaBytes ? ` / ${formatBytes(usage.quotaBytes)}` : ""}
          </span>
        </span>
        {lastChecked && <span>checked {new Date(lastChecked).toLocaleTimeString()}</span>}
      </div>

      {assetCacheSupported === false && (
        <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          Cache Storage is unavailable, likely due to browser/private-mode restrictions.
        </p>
      )}

      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${statusDot(modelLoad.status)}`} />
              <span className="text-xs font-medium text-slate-200">ONNX session</span>
            </div>
            <p className="mt-0.5 text-[10px] text-slate-500">
              {modelLoad.status === "ready"
                ? "Runtime and selected model are initialized."
                : modelLoad.status === "loading"
                  ? "Creating ONNX Runtime session..."
                  : modelLoad.status === "error"
                    ? modelLoad.error ?? "Model failed to load."
                    : "Not warmed yet. Inference will load it automatically."}
            </p>
            <p className="mt-0.5 text-[10px] text-slate-600">
              WASM threads:{" "}
              <span className="font-mono text-slate-400">
                {crossOriginIsolated == null ? "checking" : crossOriginIsolated ? "available" : "single-thread fallback"}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={warmModel}
            disabled={busy || !selectedModelId || modelLoad.status === "loading" || modelLoad.status === "ready"}
            className="shrink-0 rounded-md border border-sky-700 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40 disabled:opacity-40"
          >
            Warm model
          </button>
        </div>
      </div>

      <ul className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
        {targets.map((target) => (
          <AssetRow key={target.id} target={target} state={states[target.id] ?? EMPTY_STATE} />
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={checkAll}
          disabled={busy}
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          Check
        </button>
        <button
          type="button"
          onClick={cacheSelected}
          disabled={busy || assetCacheSupported !== true}
          className="rounded-md border border-sky-700 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40 disabled:opacity-40"
        >
          Cache selected
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!window.confirm("Clear the explicit asset cache and reload?")) return;
            await clearAssetCache();
            window.location.reload();
          }}
          disabled={busy}
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          Clear asset cache
        </button>
        <button
          type="button"
          onClick={() => {
            if (!window.confirm("Reset SceneBench localStorage and reload? This clears run history, prefs, and local scenes.")) {
              return;
            }
            clearSceneBenchLocalStorage();
            window.location.reload();
          }}
          disabled={busy}
          className="rounded-md border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-40"
        >
          Reset app data
        </button>
      </div>
    </div>
  );
}

function AssetRow({ target, state }: { target: AssetTarget; state: AssetState }) {
  const pct =
    state.status === "loading" && state.loadedBytes != null && state.totalBytes
      ? Math.max(1, Math.min(100, (state.loadedBytes / state.totalBytes) * 100))
      : state.status === "cached"
        ? 100
        : 0;

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot(state.status)}`} />
            <span className="truncate text-xs font-medium text-slate-200" title={target.label}>
              {target.label}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-slate-600" title={target.url || "tab-local upload"}>
            {target.url || "tab-local upload"}
          </div>
        </div>
        <span className="shrink-0 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
          {target.kind}
        </span>
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="capitalize text-slate-400">{state.status}</span>
        <span className="font-mono">
          {state.status === "loading"
            ? `${formatBytes(state.loadedBytes)} / ${formatBytes(state.totalBytes)}`
            : formatBytes(state.totalBytes)}
        </span>
      </div>

      {(state.status === "loading" || state.status === "cached") && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {state.message && <p className="mt-1 text-[10px] text-slate-500">{state.message}</p>}
    </li>
  );
}

function statusDot(status: AssetState["status"] | ModelLoadState["status"]): string {
  if (status === "cached" || status === "ready") return "bg-emerald-400";
  if (status === "reachable") return "bg-sky-400";
  if (status === "loading" || status === "checking") return "bg-amber-300";
  if (status === "error") return "bg-red-400";
  if (status === "unsupported") return "bg-slate-500";
  return "bg-slate-700";
}

function levelFromVideo(video: string): number | null {
  const match = /^builtin:(\d+)$/.exec(video);
  return match ? Number(match[1]) : null;
}

function dedupeTargets(targets: AssetTarget[]): AssetTarget[] {
  const byUrlOrId = new Map<string, AssetTarget>();
  for (const target of targets) {
    byUrlOrId.set(target.url || target.id, target);
  }
  return [...byUrlOrId.values()];
}
