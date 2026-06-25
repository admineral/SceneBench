"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rgb, type AnalysisResult } from "@/lib/api";
import TimelineChart from "./TimelineChart";
import ConfidenceCurvesChart from "./ConfidenceCurvesChart";

type PlotMode = "health" | "confidence";

type Props = {
  jobId: string;
  result: AnalysisResult;
  initialPlotMode?: PlotMode;
};

type VideoFrameMetadataCompat = {
  mediaTime: number;
};

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: DOMHighResTimeStamp, metadata: VideoFrameMetadataCompat) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const STATUS_STYLE: Record<string, string> = {
  STABLE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  BORDERLINE: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  WARNING: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  CRITICAL: "bg-red-500/15 text-red-300 border-red-500/30",
};

export default function ResultView({ jobId, result, initialPlotMode = "health" }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [plotMode, setPlotMode] = useState<PlotMode>(initialPlotMode);

  const startSec = Number(result.meta.start_sec ?? 0);
  const endSec = Number(result.meta.end_sec ?? startSec + 1);
  const mediaStartSec = Number(result.meta.media_start_sec ?? 0);
  // Source seconds per second of (possibly slowed) clip playback.
  const timeScale = Number(result.meta.time_scale ?? 1) || 1;
  const replaySpeed = Number(result.meta.replay_speed ?? 1);
  const showBoxLabels = result.meta.show_box_labels === true;
  const mediaToAbs = useCallback(
    (mediaTime: number) => startSec + (mediaTime - mediaStartSec) * timeScale,
    [mediaStartSec, startSec, timeScale],
  );
  const currentAbs = mediaToAbs(currentTime);
  const videoSrc =
    result.video ||
    (typeof result.meta.source_url === "string" ? result.meta.source_url : "") ||
    "/videos/output-640.mp4";

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onLoaded = () => {
      if (mediaStartSec > 0 && Math.abs(v.currentTime - mediaStartSec) > 0.05) {
        v.currentTime = Math.min(v.duration || mediaStartSec, mediaStartSec);
      }
      setCurrentTime(v.currentTime);
    };
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    v.addEventListener("loadedmetadata", onLoaded);
    onLoaded();
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
      v.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [jobId, mediaStartSec]);

  const currentFrame = useMemo(() => {
    const frames = result.frames;
    if (frames.length === 0) return null;
    let best = frames[0];
    let bestD = Math.abs(frames[0].t - currentAbs);
    for (const f of frames) {
      const d = Math.abs(f.t - currentAbs);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }, [result.frames, currentAbs]);

  const seekAbs = (abs: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clipDuration = (endSec - startSec) / timeScale;
    const clipTime = (abs - startSec) / timeScale;
    const mediaTime = mediaStartSec + clipTime;
    const mediaEnd = mediaStartSec + clipDuration;
    v.currentTime = Math.max(mediaStartSec, Math.min(mediaEnd, mediaTime));
  };

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const toggleFullscreen = async () => {
    const wrap = videoWrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement === wrap) {
      await document.exitFullscreen();
    } else {
      await wrap.requestFullscreen();
    }
  };

  const health = currentFrame?.health;
  const statusClass = health ? STATUS_STYLE[health.status] ?? STATUS_STYLE.STABLE : "";

  const frameAtAbs = useMemo(() => {
    const frames = result.frames;
    return (abs: number) => {
      if (frames.length === 0) return null;
      let best = frames[0];
      let bestD = Math.abs(frames[0].t - abs);
      for (const f of frames) {
        const d = Math.abs(f.t - abs);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      return best;
    };
  }, [result.frames]);

  useEffect(() => {
    const video = videoRef.current as VideoElementWithFrameCallback | null;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let vfc = 0;
    let stopped = false;
    let lastCssW = 0;
    let lastCssH = 0;
    let lastDpr = 0;

    const draw = (mediaTime = currentTimeRef.current) => {
      const rect = video.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.width !== lastCssW || rect.height !== lastCssH || dpr !== lastDpr) {
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        lastCssW = rect.width;
        lastCssH = rect.height;
        lastDpr = dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const srcW = Number(result.meta.out_width ?? result.meta.source_width ?? rect.width) || rect.width;
      const srcH = Number(result.meta.out_height ?? result.meta.source_height ?? rect.height) || rect.height;
      const fit = containRect(rect.width, rect.height, srcW, srcH);
      const sx = fit.width / srcW;
      const sy = fit.height / srcH;
      const frame = frameAtAbs(mediaToAbs(mediaTime));

      for (const det of frame?.detections ?? []) {
        drawBox(
          ctx,
          det.box,
          sx,
          sy,
          fit.x,
          fit.y,
          rgb(result.class_colors[det.cls]),
          showBoxLabels ? `${det.cls} ${(det.conf * 100).toFixed(0)}%` : ""
        );
      }
      for (const bridge of frame?.bridges ?? []) {
        drawBox(
          ctx,
          bridge.box,
          sx,
          sy,
          fit.x,
          fit.y,
          "rgb(217,70,239)",
          showBoxLabels ? `PRED ${bridge.id}` : "",
        );
      }
    };

    const schedule = () => {
      if (stopped) return;
      if (video.requestVideoFrameCallback) {
        vfc = video.requestVideoFrameCallback((_now, metadata) => {
          setCurrentTime(metadata.mediaTime);
          draw(metadata.mediaTime);
          schedule();
        });
      } else {
        raf = requestAnimationFrame(() => {
          setCurrentTime(video.currentTime);
          draw(video.currentTime);
          schedule();
        });
      }
    };

    const onSeeked = () => {
      setCurrentTime(video.currentTime);
      draw(video.currentTime);
    };
    const onLoaded = () => draw(video.currentTime);

    draw(video.currentTime);
    schedule();
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("resize", onLoaded);
    const resize = new ResizeObserver(() => draw(video.currentTime));
    resize.observe(video);
    return () => {
      stopped = true;
      if (video.cancelVideoFrameCallback && vfc) video.cancelVideoFrameCallback(vfc);
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("resize", onLoaded);
    };
  }, [frameAtAbs, mediaStartSec, mediaToAbs, result.class_colors, result.meta, showBoxLabels, startSec, timeScale]);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Backend" value={String(result.meta.backend ?? "—")} />
        <Stat label="Model" value={String(result.meta.model ?? "—")} />
        <Stat
          label="Segment"
          value={`${startSec.toFixed(0)}–${endSec.toFixed(0)}s`}
        />
        <Stat label="Frames" value={String(result.meta.frames_processed ?? 0)} />
        <Stat
          label="Replay"
          value={replaySpeed === 1 ? "1× · realtime" : `${replaySpeed}× · slow`}
        />
        <Stat label="Events" value={String(result.events.length)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Video + timeline */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div
            ref={videoWrapRef}
            className="relative overflow-hidden rounded-xl border border-slate-800 bg-black"
          >
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              controlsList="nofullscreen"
              className="w-full"
            />
            <canvas
              ref={overlayRef}
              className="pointer-events-none absolute left-0 top-0"
              aria-hidden="true"
            />
            <button
              type="button"
              onClick={toggleFullscreen}
              className="absolute bottom-3 right-3 rounded-md bg-black/70 px-2 py-1 text-xs text-white hover:bg-black"
              title="Fullscreen with detection overlay"
            >
              Fullscreen
            </button>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-200">
                {plotMode === "health" ? "Health timeline" : "Per-class confidence"}
              </h3>
              <div className="flex items-center gap-3">
                <div className="flex rounded-md border border-slate-700 p-0.5 text-xs">
                  <button
                    onClick={() => setPlotMode("health")}
                    className={`rounded px-2 py-0.5 transition ${
                      plotMode === "health"
                        ? "bg-sky-500 text-slate-950"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Health
                  </button>
                  <button
                    onClick={() => setPlotMode("confidence")}
                    className={`rounded px-2 py-0.5 transition ${
                      plotMode === "confidence"
                        ? "bg-sky-500 text-slate-950"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Confidence
                  </button>
                </div>
                <span className="font-mono text-xs text-slate-400">
                  t = {currentAbs.toFixed(2)}s
                </span>
              </div>
            </div>
            {plotMode === "health" ? (
              <TimelineChart
                frames={result.frames}
                events={result.events}
                startSec={startSec}
                endSec={endSec}
                currentAbsSec={currentAbs}
                onSeekAbs={seekAbs}
              />
            ) : (
              <ConfidenceCurvesChart
                frames={result.frames}
                classColors={result.class_colors}
                startSec={startSec}
                endSec={endSec}
                currentAbsSec={currentAbs}
                onSeekAbs={seekAbs}
              />
            )}
            <p className="mt-1 text-[11px] text-slate-500">
              {plotMode === "confidence"
                ? "Each line is a class' strongest detection over time. Click a legend item to hide it; click the chart to scrub."
                : "Click anywhere on the chart to scrub the clip to that moment."}
            </p>
          </div>
        </div>

        {/* Side panel */}
        <div className="flex flex-col gap-4">
          {/* Current health */}
          <Panel title="Frame health">
            {health ? (
              <div className="flex flex-col gap-2">
                <span
                  className={`inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusClass}`}
                >
                  {health.status}
                </span>
                <KV k="Dominant" v={`${health.dominant_class} · ${(health.dominant_conf * 100).toFixed(0)}%`} />
                <KV k="Runner-up" v={health.second_class ? `${health.second_class} · ${(health.second_conf * 100).toFixed(0)}%` : "—"} />
                <KV k="Margin" v={health.margin.toFixed(3)} />
                <KV k="Instability" v={health.instability.toFixed(3)} />
                {health.event_reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {health.event_reasons.map((r) => (
                      <span
                        key={r}
                        className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No data at this frame.</p>
            )}
          </Panel>

          {/* Detections at current frame */}
          <Panel title={`Detections (${currentFrame?.detections.length ?? 0})`}>
            <div className="max-h-52 overflow-y-auto">
              {currentFrame && currentFrame.detections.length > 0 ? (
                <table className="w-full text-sm">
                  <tbody>
                    {[...currentFrame.detections]
                      .sort((a, b) => b.conf - a.conf)
                      .map((d, i) => (
                        <tr key={i} className="border-b border-slate-800/60 last:border-0">
                          <td className="py-1">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-sm"
                                style={{ background: rgb(result.class_colors[d.cls]) }}
                              />
                              {d.cls}
                            </span>
                          </td>
                          <td className="py-1 text-right font-mono text-slate-300">
                            {(d.conf * 100).toFixed(0)}%
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-slate-500">No detections.</p>
              )}
            </div>
            {currentFrame && currentFrame.bridges.length > 0 && (
              <p className="mt-2 text-xs text-fuchsia-300">
                {currentFrame.bridges.length} predicted gap-bridge box
                {currentFrame.bridges.length > 1 ? "es" : ""}
              </p>
            )}
          </Panel>

          {/* Events */}
          <Panel title={`Events (${result.events.length})`}>
            <div className="max-h-52 overflow-y-auto">
              {result.events.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {result.events.map((ev, i) => (
                    <li key={i}>
                      <button
                        onClick={() => seekAbs(ev.t)}
                        className="flex w-full items-center justify-between rounded px-2 py-1 text-sm hover:bg-slate-800"
                      >
                        <span className="font-mono text-slate-400">
                          {ev.t.toFixed(2)}s
                        </span>
                        <span className="text-slate-200">{ev.reason}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">
                  No instability events in this segment.
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  box: number[],
  sx: number,
  sy: number,
  ox: number,
  oy: number,
  color: string,
  label: string
) {
  const x = ox + box[0] * sx;
  const y = oy + box[1] * sy;
  const w = (box[2] - box[0]) * sx;
  const h = (box[3] - box[1]) * sy;
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.strokeRect(x, y, w, h);
  if (!label) return;
  ctx.font = "12px ui-sans-serif, system-ui";
  const text = ctx.measureText(label);
  const labelY = Math.max(0, y - 18);
  ctx.fillRect(x, labelY, text.width + 8, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, x + 4, labelY + 13);
}

function containRect(containerW: number, containerH: number, contentW: number, contentH: number) {
  const scale = Math.min(containerW / contentW, containerH / contentH);
  const width = contentW * scale;
  const height = contentH * scale;
  return {
    x: (containerW - width) / 2,
    y: (containerH - height) / 2,
    width,
    height,
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="truncate text-sm font-semibold text-slate-100" title={value}>
        {value}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">{title}</h3>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-400">{k}</span>
      <span className="font-mono text-slate-100">{v}</span>
    </div>
  );
}
