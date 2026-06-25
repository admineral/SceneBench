"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rgb, type FrameRecord } from "@/lib/api";

type Props = {
  frames: FrameRecord[];
  classColors: Record<string, [number, number, number]>;
  startSec: number;
  endSec: number;
  currentAbsSec: number;
  onSeekAbs: (absSec: number) => void;
};

const HEIGHT = 220;
const PAD = { top: 18, right: 12, bottom: 26, left: 36 };

export default function ConfidenceCurvesChart({
  frames,
  classColors,
  startSec,
  endSec,
  currentAbsSec,
  onSeekAbs,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(360, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Per-frame max confidence for each class (mirrors the per-class curves in
  // run_video_onnx.py: a class line is the strongest detection of that class).
  const classNames = useMemo(() => {
    const s = new Set<string>();
    for (const f of frames) for (const d of f.detections) s.add(d.cls);
    return [...s].sort();
  }, [frames]);

  const span = Math.max(0.001, endSec - startSec);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const xOf = (t: number) => PAD.left + ((t - startSec) / span) * plotW;
  const yOf = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

  const classPath = (cls: string) => {
    let d = "";
    let started = false;
    for (const f of frames) {
      let conf = -1;
      for (const det of f.detections) if (det.cls === cls && det.conf > conf) conf = det.conf;
      if (conf < 0) {
        started = false;
        continue;
      }
      d += `${started ? "L" : "M"}${xOf(f.t).toFixed(1)},${yOf(conf).toFixed(1)} `;
      started = true;
    }
    return d.trim();
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = (x - PAD.left) / plotW;
    onSeekAbs(startSec + Math.max(0, Math.min(1, frac)) * span);
  };

  const toggleClass = (cls: string) =>
    setHidden((cur) => {
      const next = new Set(cur);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });

  const gridYs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={width} height={HEIGHT} onClick={handleClick} className="cursor-pointer select-none">
        <rect x={0} y={0} width={width} height={HEIGHT} fill="var(--chart-bg)" rx={10} />

        {gridYs.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yOf(g)}
              y2={yOf(g)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text x={6} y={yOf(g) + 4} fill="var(--chart-label)" fontSize={10}>
              {g.toFixed(2)}
            </text>
          </g>
        ))}

        {classNames.map((cls) =>
          hidden.has(cls) ? null : (
            <path
              key={cls}
              d={classPath(cls)}
              fill="none"
              stroke={rgb(classColors[cls])}
              strokeWidth={2}
              strokeLinejoin="round"
              opacity={0.95}
            />
          ),
        )}

        {/* playhead */}
        <line
          x1={xOf(currentAbsSec)}
          x2={xOf(currentAbsSec)}
          y1={PAD.top - 10}
          y2={HEIGHT - PAD.bottom}
          stroke="#fde047"
          strokeWidth={2}
        />

        <text x={PAD.left} y={HEIGHT - 8} fill="var(--chart-axis)" fontSize={10}>
          {startSec.toFixed(1)}s
        </text>
        <text
          x={width - PAD.right}
          y={HEIGHT - 8}
          fill="var(--chart-axis)"
          fontSize={10}
          textAnchor="end"
        >
          {endSec.toFixed(1)}s
        </text>
      </svg>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
        {classNames.length === 0 && <span className="text-slate-500">No detections in this segment.</span>}
        {classNames.map((cls) => (
          <button
            key={cls}
            onClick={() => toggleClass(cls)}
            className={`inline-flex items-center gap-1.5 rounded px-1 transition hover:bg-slate-800 ${
              hidden.has(cls) ? "opacity-35" : ""
            }`}
            title={hidden.has(cls) ? "Show" : "Hide"}
          >
            <span className="inline-block h-0.5 w-4" style={{ background: rgb(classColors[cls]) }} />
            {cls}
          </button>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: "#fde047" }} />
          playhead
        </span>
      </div>
    </div>
  );
}
