"use client";

import { useEffect, useRef, useState } from "react";
import type { EventRecord, FrameRecord } from "@/lib/api";

type Props = {
  frames: FrameRecord[];
  events: EventRecord[];
  startSec: number;
  endSec: number;
  currentAbsSec: number;
  onSeekAbs: (absSec: number) => void;
};

const HEIGHT = 220;
const PAD = { top: 18, right: 12, bottom: 26, left: 36 };

const EVENT_COLORS: Record<string, string> = {
  switch: "#f472b6",
  drop: "#f87171",
  jitter: "#fbbf24",
  missing_track: "#a78bfa",
};

export default function TimelineChart({
  frames,
  events,
  startSec,
  endSec,
  currentAbsSec,
  onSeekAbs,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(360, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(0.001, endSec - startSec);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const xOf = (t: number) => PAD.left + ((t - startSec) / span) * plotW;
  const yOf = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

  const linePath = (pick: (f: FrameRecord) => number | null) => {
    let d = "";
    let started = false;
    for (const f of frames) {
      const v = pick(f);
      if (v === null || Number.isNaN(v)) {
        started = false;
        continue;
      }
      const x = xOf(f.t);
      const y = yOf(v);
      d += `${started ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
      started = true;
    }
    return d.trim();
  };

  const instabilityArea = () => {
    if (frames.length === 0) return "";
    const baseY = yOf(0);
    let d = `M${xOf(frames[0].t).toFixed(1)},${baseY.toFixed(1)} `;
    for (const f of frames) {
      d += `L${xOf(f.t).toFixed(1)},${yOf(f.health?.instability ?? 0).toFixed(1)} `;
    }
    d += `L${xOf(frames[frames.length - 1].t).toFixed(1)},${baseY.toFixed(1)} Z`;
    return d;
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = (x - PAD.left) / plotW;
    onSeekAbs(startSec + Math.max(0, Math.min(1, frac)) * span);
  };

  const gridYs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div ref={wrapRef} className="w-full">
      <svg
        width={width}
        height={HEIGHT}
        onClick={handleClick}
        className="cursor-pointer select-none"
      >
        {/* background */}
        <rect x={0} y={0} width={width} height={HEIGHT} fill="var(--chart-bg)" rx={10} />

        {/* horizontal grid + y labels */}
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

        {/* instability area */}
        <path d={instabilityArea()} fill="rgba(248,113,113,0.18)" stroke="none" />
        <path
          d={linePath((f) => f.health?.instability ?? null)}
          fill="none"
          stroke="#f87171"
          strokeWidth={1.5}
          opacity={0.85}
        />

        {/* second-best confidence (faint) */}
        <path
          d={linePath((f) => f.health?.second_conf ?? null)}
          fill="none"
          stroke="#64748b"
          strokeWidth={1.25}
          strokeDasharray="3 3"
        />

        {/* dominant confidence */}
        <path
          d={linePath((f) => f.health?.dominant_conf ?? null)}
          fill="none"
          stroke="#38bdf8"
          strokeWidth={2}
        />

        {/* event markers */}
        {events.map((ev, i) => (
          <g key={i}>
            <line
              x1={xOf(ev.t)}
              x2={xOf(ev.t)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              stroke={EVENT_COLORS[ev.reason] ?? "#e2e8f0"}
              strokeWidth={1}
              opacity={0.35}
            />
            <circle
              cx={xOf(ev.t)}
              cy={PAD.top - 6}
              r={3.5}
              fill={EVENT_COLORS[ev.reason] ?? "#e2e8f0"}
            />
          </g>
        ))}

        {/* playhead */}
        <line
          x1={xOf(currentAbsSec)}
          x2={xOf(currentAbsSec)}
          y1={PAD.top - 10}
          y2={HEIGHT - PAD.bottom}
          stroke="#fde047"
          strokeWidth={2}
        />

        {/* x labels */}
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

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <Legend color="#38bdf8" label="dominant conf" />
        <Legend color="#64748b" label="2nd conf" dashed />
        <Legend color="#f87171" label="instability" />
        <Legend color="#f472b6" label="switch" dot />
        <Legend color="#f87171" label="drop" dot />
        <Legend color="#fbbf24" label="jitter" dot />
        <Legend color="#a78bfa" label="missing" dot />
        <Legend color="#fde047" label="playhead" />
      </div>
    </div>
  );
}

function Legend({
  color,
  label,
  dashed,
  dot,
}: {
  color: string;
  label: string;
  dashed?: boolean;
  dot?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dot ? (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: color }}
        />
      ) : (
        <span
          className="inline-block h-0.5 w-4"
          style={{
            background: dashed
              ? `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)`
              : color,
          }}
        />
      )}
      {label}
    </span>
  );
}
