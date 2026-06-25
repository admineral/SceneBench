"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rgb, type AnalysisResult } from "@/lib/api";
import ConfidenceCurvesChart from "./ConfidenceCurvesChart";
import type { RunRecord } from "@/lib/history";

type VideoFrameMetadataCompat = { mediaTime: number };
type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp, metadata: VideoFrameMetadataCompat) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

type Props = {
  runA: RunRecord;
  runB: RunRecord;
  onExit: () => void;
};

const shortLabel = (model: string) =>
  model.replace(/^Level\s+\d+\s*[-–]\s*/i, "");

export default function CompareView({ runA, runB, onExit }: Props) {
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentClipTime, setCurrentClipTime] = useState(0);

  const startA = Number(runA.result.meta.start_sec ?? 0);
  const endA   = Number(runA.result.meta.end_sec   ?? startA + 1);
  const mediaStartA = Number(runA.result.meta.media_start_sec ?? 0);
  const tsA    = Number(runA.result.meta.time_scale ?? 1) || 1;

  const startB = Number(runB.result.meta.start_sec ?? 0);
  const endB   = Number(runB.result.meta.end_sec   ?? startB + 1);
  const mediaStartB = Number(runB.result.meta.media_start_sec ?? 0);
  const tsB    = Number(runB.result.meta.time_scale ?? 1) || 1;

  const currentAbsA = startA + currentClipTime * tsA;
  const currentAbsB = startB + currentClipTime * tsB;

  // videoA is master – drives shared time and syncs B
  useEffect(() => {
    const vA = videoRefA.current;
    const vB = videoRefB.current;
    if (!vA) return;
    const onTime = () => {
      const clipTime = Math.max(0, vA.currentTime - mediaStartA);
      setCurrentClipTime(clipTime);
      if (vB) {
        const targetB = mediaStartB + clipTime;
        if (Math.abs(vB.currentTime - targetB) > 0.15) {
          vB.currentTime = targetB;
        }
      }
    };
    const onEnded = () => setPlaying(false);
    vA.addEventListener("timeupdate", onTime);
    vA.addEventListener("seeked", onTime);
    vA.addEventListener("ended", onEnded);
    return () => {
      vA.removeEventListener("timeupdate", onTime);
      vA.removeEventListener("seeked", onTime);
      vA.removeEventListener("ended", onEnded);
    };
  }, [mediaStartA, mediaStartB]);

  const togglePlay = () => {
    const vA = videoRefA.current;
    const vB = videoRefB.current;
    if (!vA) return;
    if (playing) {
      vA.pause();
      vB?.pause();
      setPlaying(false);
    } else {
      if (vB) vB.currentTime = mediaStartB + Math.max(0, vA.currentTime - mediaStartA);
      const plays = [vA.play(), vB ? vB.play() : null].filter(Boolean) as Promise<void>[];
      void Promise.all(plays);
      setPlaying(true);
    }
  };

  const seekBoth = (clipTime: number) => {
    const vA = videoRefA.current;
    const vB = videoRefB.current;
    if (vA) vA.currentTime = mediaStartA + clipTime;
    if (vB) vB.currentTime = mediaStartB + clipTime;
    setCurrentClipTime(clipTime);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Model comparison</h2>
          <p className="text-[11px] text-slate-500">{runA.label}</p>
        </div>
        <button
          onClick={onExit}
          className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 hover:border-slate-500"
        >
          ✕ Close comparison
        </button>
      </div>

      {/* Two video panes */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <VideoPane
          result={runA.result}
          videoRef={videoRefA}
          currentClipTime={currentClipTime}
          label={shortLabel(runA.model)}
        />
        <VideoPane
          result={runB.result}
          videoRef={videoRefB}
          currentClipTime={currentClipTime}
          label={shortLabel(runB.model)}
        />
      </div>

      {/* Shared play controls */}
      <div className="flex items-center justify-center gap-5">
        <button
          onClick={togglePlay}
          className="rounded-lg border border-slate-700 bg-slate-900 px-8 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 hover:border-slate-600"
        >
          {playing ? "⏸ Pause" : "▶ Play both"}
        </button>
        <span className="font-mono text-xs text-slate-500">
          t = {currentAbsA.toFixed(2)}s
        </span>
      </div>

      {/* Two confidence charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartPane
          result={runA.result}
          label={shortLabel(runA.model)}
          currentAbs={currentAbsA}
          startSec={startA}
          endSec={endA}
          onSeekAbs={(abs) => seekBoth(Math.max(0, (abs - startA) / tsA))}
        />
        <ChartPane
          result={runB.result}
          label={shortLabel(runB.model)}
          currentAbs={currentAbsB}
          startSec={startB}
          endSec={endB}
          onSeekAbs={(abs) => seekBoth(Math.max(0, (abs - startB) / tsB))}
        />
      </div>
    </div>
  );
}

// ── VideoPane ──────────────────────────────────────────────────────────────────

type VideoPaneProps = {
  result: AnalysisResult;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentClipTime: number;
  label: string;
};

function VideoPane({ result, videoRef, currentClipTime, label }: VideoPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentClipTimeRef = useRef(currentClipTime);

  const startSec    = Number(result.meta.start_sec ?? 0);
  const mediaStartSec = Number(result.meta.media_start_sec ?? 0);
  const timeScale   = Number(result.meta.time_scale ?? 1) || 1;
  const showLabels  = result.meta.show_box_labels === true;
  const videoSrc    =
    result.video ||
    (typeof result.meta.source_url === "string" ? result.meta.source_url : "") ||
    "/videos/output-640.mp4";

  useEffect(() => { currentClipTimeRef.current = currentClipTime; }, [currentClipTime]);

  const frameAtAbs = useMemo(() => {
    const frames = result.frames;
    return (abs: number) => {
      if (!frames.length) return null;
      let best = frames[0];
      let bestD = Math.abs(frames[0].t - abs);
      for (const f of frames) {
        const d = Math.abs(f.t - abs);
        if (d < bestD) { bestD = d; best = f; }
      }
      return best;
    };
  }, [result.frames]);

  useEffect(() => {
    const video = videoRef.current as VideoElementWithFrameCallback | null;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0, vfc = 0, stopped = false;
    let lastCssW = 0, lastCssH = 0, lastDpr = 0;

    const draw = (mediaTime = currentClipTimeRef.current) => {
      const rect = video.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.width !== lastCssW || rect.height !== lastCssH || dpr !== lastDpr) {
        canvas.style.width  = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.width  = Math.max(1, Math.round(rect.width  * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        lastCssW = rect.width; lastCssH = rect.height; lastDpr = dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const srcW = Number(result.meta.out_width    ?? result.meta.source_width  ?? rect.width)  || rect.width;
      const srcH = Number(result.meta.out_height   ?? result.meta.source_height ?? rect.height) || rect.height;
      const fit  = containRect(rect.width, rect.height, srcW, srcH);
      const sx   = fit.width / srcW;
      const sy   = fit.height / srcH;
      const abs  = startSec + (mediaTime - mediaStartSec) * timeScale;
      const frame = frameAtAbs(abs);
      for (const det of frame?.detections ?? []) {
        drawBox(ctx, det.box, sx, sy, fit.x, fit.y,
          rgb(result.class_colors[det.cls]),
          showLabels ? `${det.cls} ${(det.conf * 100).toFixed(0)}%` : "");
      }
      for (const bridge of frame?.bridges ?? []) {
        drawBox(ctx, bridge.box, sx, sy, fit.x, fit.y,
          "rgb(217,70,239)",
          showLabels ? `PRED ${bridge.id}` : "");
      }
    };

    const schedule = () => {
      if (stopped) return;
      if (video.requestVideoFrameCallback) {
        vfc = video.requestVideoFrameCallback((_now, meta) => { draw(meta.mediaTime); schedule(); });
      } else {
        raf = requestAnimationFrame(() => { draw(video.currentTime); schedule(); });
      }
    };

    const onSeeked  = () => draw(video.currentTime);
    const onLoaded  = () => {
      if (mediaStartSec > 0 && Math.abs(video.currentTime - mediaStartSec) > 0.05) {
        video.currentTime = Math.min(video.duration || mediaStartSec, mediaStartSec);
      }
      draw(video.currentTime);
    };
    const resize    = new ResizeObserver(() => draw(video.currentTime));

    draw(video.currentTime);
    schedule();
    video.addEventListener("seeked",         onSeeked);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("resize",         onLoaded);
    resize.observe(video);
    return () => {
      stopped = true;
      if (video.cancelVideoFrameCallback && vfc) video.cancelVideoFrameCallback(vfc);
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      video.removeEventListener("seeked",         onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("resize",         onLoaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameAtAbs, mediaStartSec, result.class_colors, result.meta, showLabels, startSec, timeScale]);

  return (
    <div className="flex flex-col gap-2">
      <div className="truncate rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm font-medium text-slate-200">
        {label}
      </div>
      <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef as React.RefObject<HTMLVideoElement>} src={videoSrc} className="w-full" />
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute left-0 top-0"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

// ── ChartPane ─────────────────────────────────────────────────────────────────

function ChartPane({
  result, label, currentAbs, startSec, endSec, onSeekAbs,
}: {
  result: AnalysisResult;
  label: string;
  currentAbs: number;
  startSec: number;
  endSec: number;
  onSeekAbs: (abs: number) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-slate-200">{label}</h3>
        <span className="shrink-0 font-mono text-xs text-slate-400">
          t = {currentAbs.toFixed(2)}s
        </span>
      </div>
      <ConfidenceCurvesChart
        frames={result.frames}
        classColors={result.class_colors}
        startSec={startSec}
        endSec={endSec}
        currentAbsSec={currentAbs}
        onSeekAbs={onSeekAbs}
      />
      <p className="mt-1 text-[11px] text-slate-500">
        Per-class confidence · click to scrub
      </p>
    </div>
  );
}

// ── drawing helpers ───────────────────────────────────────────────────────────

function drawBox(
  ctx: CanvasRenderingContext2D,
  box: number[], sx: number, sy: number, ox: number, oy: number,
  color: string, label: string,
) {
  const x = ox + box[0] * sx;
  const y = oy + box[1] * sy;
  const w = (box[2] - box[0]) * sx;
  const h = (box[3] - box[1]) * sy;
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.strokeRect(x, y, w, h);
  if (!label) return;
  ctx.font = "12px ui-sans-serif, system-ui";
  const tw = ctx.measureText(label).width;
  const labelY = Math.max(0, y - 18);
  ctx.fillRect(x, labelY, tw + 8, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, x + 4, labelY + 13);
}

function containRect(cW: number, cH: number, srcW: number, srcH: number) {
  const scale = Math.min(cW / srcW, cH / srcH);
  return {
    x: (cW - srcW * scale) / 2,
    y: (cH - srcH * scale) / 2,
    width:  srcW * scale,
    height: srcH * scale,
  };
}
