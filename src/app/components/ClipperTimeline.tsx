"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Scene } from "@/lib/api";

type Range = { start: number; end: number };

type Props = {
  duration: number;
  currentTime: number;
  selection: Range | null;
  scenes: Scene[];
  activeSceneId?: string | null;
  onSeek: (t: number) => void;
  onSceneActivate?: (scene: Scene) => void;
  onSelect: (sel: Range | null) => void;
};

const TRACK_H = 88;
const MAX_PX_PER_SEC = 600;
const DRAG_THRESHOLD_PX = 4;
const HANDLE_W = 10;

type DragMode = "playhead" | "sel-start" | "sel-end" | "sel-move" | "create" | null;

export default function ClipperTimeline({
  duration,
  currentTime,
  selection,
  scenes,
  activeSceneId,
  onSeek,
  onSceneActivate,
  onSelect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(800);
  const [pxPerSec, setPxPerSec] = useState(1);
  const scrollTarget = useRef<number | null>(null);
  const userZoomed = useRef(false);

  const drag = useRef<{
    mode: DragMode;
    downX: number;
    downT: number;
    moved: boolean;
    origSel: Range | null;
  }>({ mode: null, downX: 0, downT: 0, moved: false, origSel: null });
  const [dragging, setDragging] = useState<DragMode>(null);

  const dur = Math.max(0.001, duration);
  const minPxPerSec = Math.max(0.02, containerW / dur);
  const clampZoom = (z: number) => Math.max(minPxPerSec, Math.min(MAX_PX_PER_SEC, z));

  const contentW = Math.min(2_000_000, Math.max(containerW, dur * pxPerSec));
  const xOf = (t: number) => t * pxPerSec;
  const tOf = (x: number) => x / pxPerSec;
  const clampT = (t: number) => Math.max(0, Math.min(duration, t));

  // Measure container and fit zoom to the whole clip until the user zooms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerW(Math.max(320, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the real duration arrives (streaming mp4s may report a small value
  // first), reset to a fit view. Manual zoom only persists across resizes.
  useEffect(() => {
    userZoomed.current = false;
    setPxPerSec(clampZoom(containerW / Math.max(0.001, duration)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  useEffect(() => {
    if (!userZoomed.current) setPxPerSec(clampZoom(containerW / dur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerW]);

  // Apply any pending scroll re-centering after a zoom re-render.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && scrollTarget.current != null) {
      el.scrollLeft = Math.max(0, Math.min(contentW - containerW, scrollTarget.current));
      scrollTarget.current = null;
    }
  }, [pxPerSec, contentW, containerW]);

  // Keep the playhead in view during playback (unless the user is dragging).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || drag.current.mode) return;
    const px = xOf(currentTime);
    if (px < el.scrollLeft + 8 || px > el.scrollLeft + containerW - 8) {
      el.scrollLeft = Math.max(0, Math.min(contentW - containerW, px - containerW * 0.3));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, pxPerSec]);

  const zoomAt = useCallback(
    (newZoomRaw: number, anchorClientX?: number) => {
      const el = scrollRef.current;
      const z = clampZoom(newZoomRaw);
      if (el) {
        const rect = el.getBoundingClientRect();
        const anchorX = anchorClientX != null ? anchorClientX - rect.left : containerW / 2;
        const tAnchor = (el.scrollLeft + anchorX) / pxPerSec;
        scrollTarget.current = tAnchor * z - anchorX;
      }
      userZoomed.current = true;
      setPxPerSec(z);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pxPerSec, containerW, minPxPerSec],
  );

  const zoomByFactor = (factor: number, anchorClientX?: number) =>
    zoomAt(pxPerSec * factor, anchorClientX);

  const fitAll = () => {
    userZoomed.current = false;
    setPxPerSec(clampZoom(containerW / dur));
    scrollTarget.current = 0;
  };

  const fitSelection = () => {
    if (!selection) return;
    const span = Math.max(0.2, selection.end - selection.start);
    const z = clampZoom((containerW * 0.8) / span);
    userZoomed.current = true;
    scrollTarget.current = selection.start * z - containerW * 0.1;
    setPxPerSec(z);
  };

  // --- pointer helpers ------------------------------------------------------
  const contentX = (clientX: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(contentW, clientX - rect.left));
  };

  const beginDrag = (mode: DragMode, e: React.PointerEvent) => {
    const x = contentX(e.clientX);
    drag.current = {
      mode,
      downX: x,
      downT: clampT(tOf(x)),
      moved: false,
      origSel: selection ? { ...selection } : null,
    };
    setDragging(mode);
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
  };

  const onWindowMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d.mode || !contentRef.current) return;
      const x = contentX(e.clientX);
      const t = clampT(tOf(x));
      if (Math.abs(x - d.downX) > DRAG_THRESHOLD_PX) d.moved = true;

      if (d.mode === "playhead") {
        onSeek(t);
      } else if (d.mode === "create") {
        if (d.moved) onSelect({ start: Math.min(d.downT, t), end: Math.max(d.downT, t) });
      } else if (d.mode === "sel-start" && d.origSel) {
        onSelect({ start: Math.min(t, d.origSel.end - 0.05), end: d.origSel.end });
      } else if (d.mode === "sel-end" && d.origSel) {
        onSelect({ start: d.origSel.start, end: Math.max(t, d.origSel.start + 0.05) });
      } else if (d.mode === "sel-move" && d.origSel) {
        const len = d.origSel.end - d.origSel.start;
        let start = clampT(d.origSel.start + (t - d.downT));
        start = Math.min(start, duration - len);
        start = Math.max(0, start);
        onSelect({ start, end: start + len });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pxPerSec, duration, selection, onSeek, onSelect],
  );

  const onWindowUp = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (d.mode === "create" && !d.moved && contentRef.current) {
        onSeek(clampT(tOf(contentX(e.clientX))));
      }
      drag.current.mode = null;
      setDragging(null);
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onWindowMove, onSeek, pxPerSec],
  );

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
    },
    [onWindowMove, onWindowUp],
  );

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomByFactor(e.deltaY > 0 ? 1 / 1.15 : 1.15, e.clientX);
    } else if (scrollRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Translate vertical wheel into horizontal scroll (mouse users).
      scrollRef.current.scrollLeft += e.deltaY;
    }
  };

  // --- ruler ----------------------------------------------------------------
  const niceStep = (targetPx: number) => {
    const targetSec = targetPx / pxPerSec;
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return steps.find((v) => v >= targetSec) ?? 600;
  };
  const step = niceStep(90);
  const tickCount = Math.floor(dur / step) + 1;

  const zoomSliderValue =
    Math.log(pxPerSec / minPxPerSec) / Math.log(MAX_PX_PER_SEC / minPxPerSec || 1);

  if (duration <= 0) {
    return (
      <div
        ref={scrollRef}
        className="flex h-24 w-full items-center justify-center rounded-lg border border-slate-800 bg-slate-950 text-sm text-slate-500"
      >
        Loading video metadata…
      </div>
    );
  }

  return (
    <div className="select-none">
      {/* zoom bar */}
      <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-400">
        <button onClick={() => zoomByFactor(1 / 1.5)} className="zbtn" title="Zoom out">
          −
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={isFinite(zoomSliderValue) ? Math.max(0, Math.min(1, zoomSliderValue)) : 0}
          onChange={(e) => {
            const v = Number(e.target.value);
            zoomAt(minPxPerSec * Math.pow(MAX_PX_PER_SEC / minPxPerSec, v));
          }}
          className="w-40"
        />
        <button onClick={() => zoomByFactor(1.5)} className="zbtn" title="Zoom in">
          +
        </button>
        <span className="font-mono">{pxPerSec.toFixed(1)} px/s</span>
        <div className="mx-1 h-4 w-px bg-slate-700" />
        <button onClick={fitAll} className="zbtn px-2">
          Fit all
        </button>
        <button onClick={fitSelection} disabled={!selection} className="zbtn px-2 disabled:opacity-40">
          Fit selection
        </button>
        <span className="ml-auto text-[11px] text-slate-500">
          drag playhead/handles · ⌘/Ctrl+scroll to zoom · scroll to pan
        </span>
      </div>

      {/* scrollable track */}
      <div
        ref={scrollRef}
        className="overflow-x-auto overflow-y-hidden rounded-lg border border-slate-800 bg-slate-950"
        onWheel={onWheel}
        style={{ cursor: dragging === "playhead" ? "grabbing" : "default" }}
      >
        <div
          ref={contentRef}
          className="relative"
          style={{ width: `${contentW}px`, height: `${TRACK_H}px` }}
          onPointerDown={(e) => {
            // Background click/drag = seek or create selection.
            if (e.button !== 0) return;
            beginDrag("create", e);
          }}
        >
          {/* ruler */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-5 border-b border-slate-800/80">
            {Array.from({ length: tickCount }, (_, i) => {
              const t = i * step;
              return (
                <div key={i} className="absolute top-0 h-5" style={{ left: `${xOf(t)}px` }}>
                  <div className="h-2 w-px bg-slate-600" />
                  <span className="absolute left-1 top-1 whitespace-nowrap text-[9px] text-slate-500">
                    {fmtTick(t)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* saved scene blocks */}
          {scenes.map((sc) => (
            <div
              key={sc.id}
              className={`absolute top-5 h-7 overflow-hidden rounded border text-[10px] ${
                sc.id === activeSceneId
                  ? "border-emerald-400 bg-emerald-500/30"
                  : "border-sky-500/50 bg-sky-500/20"
              }`}
              style={{ left: `${xOf(sc.start)}px`, width: `${Math.max(3, xOf(sc.end) - xOf(sc.start))}px` }}
              title={`${sc.name} (${sc.start}–${sc.end}s)`}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (onSceneActivate) onSceneActivate(sc);
                else {
                  onSeek(sc.start);
                  onSelect({ start: sc.start, end: sc.end });
                }
              }}
            >
              <span className="truncate px-1 leading-7 text-slate-100">{sc.name}</span>
            </div>
          ))}

          {/* selection */}
          {selection && (
            <div
              className="absolute bottom-0 top-12 border-x border-amber-400/70 bg-amber-400/15"
              style={{
                left: `${xOf(selection.start)}px`,
                width: `${Math.max(2, xOf(selection.end) - xOf(selection.start))}px`,
              }}
            >
              {/* move body */}
              <div
                className="absolute inset-0 cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  beginDrag("sel-move", e);
                }}
              />
              {/* left handle */}
              <div
                className="absolute -left-1 top-0 h-full cursor-ew-resize bg-amber-400"
                style={{ width: `${HANDLE_W}px` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  beginDrag("sel-start", e);
                }}
              />
              {/* right handle */}
              <div
                className="absolute -right-1 top-0 h-full cursor-ew-resize bg-amber-400"
                style={{ width: `${HANDLE_W}px` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  beginDrag("sel-end", e);
                }}
              />
            </div>
          )}

          {/* playhead */}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-yellow-300"
            style={{ left: `${xOf(currentTime)}px` }}
          >
            <div
              className="pointer-events-auto absolute -left-2 -top-0 h-4 w-4 cursor-grab rounded-b bg-yellow-300 active:cursor-grabbing"
              onPointerDown={(e) => {
                e.stopPropagation();
                beginDrag("playhead", e);
              }}
            />
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
        <span className="font-mono">{fmtTick(currentTime)}</span>
        {selection && (
          <span className="font-mono text-amber-300/80">
            sel {selection.start.toFixed(2)}–{selection.end.toFixed(2)}s (
            {(selection.end - selection.start).toFixed(2)}s)
          </span>
        )}
        <span className="font-mono">{fmtTick(duration)}</span>
      </div>

      <style jsx>{`
        .zbtn {
          border: 1px solid #334155;
          border-radius: 0.375rem;
          background: #0f172a;
          padding: 0.1rem 0.5rem;
          color: #cbd5e1;
          line-height: 1.2;
        }
        .zbtn:hover {
          background: #1e293b;
        }
      `}</style>
    </div>
  );
}

function fmtTick(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (m > 0) return `${m}:${s.toFixed(0).padStart(2, "0")}`;
  return `${s.toFixed(2)}s`;
}
