"use client";

import { useMemo } from "react";
import { rgb, type FrameRecord } from "@/lib/api";

type Props = {
  frames: FrameRecord[];
  classColors: Record<string, [number, number, number]>;
  height?: number;
};

// Compact, axis-free per-class confidence plot for run-history cards. Uses a
// fixed viewBox and scales to its container width.
const VW = 240;

export default function ConfidenceSparkline({ frames, classColors, height = 46 }: Props) {
  const classNames = useMemo(() => {
    const s = new Set<string>();
    for (const f of frames) for (const d of f.detections) s.add(d.cls);
    return [...s].sort();
  }, [frames]);

  const { tMin, span } = useMemo(() => {
    if (frames.length === 0) return { tMin: 0, span: 1 };
    const first = frames[0].t;
    const last = frames[frames.length - 1].t;
    return { tMin: first, span: Math.max(0.001, last - first) };
  }, [frames]);

  const xOf = (t: number) => ((t - tMin) / span) * VW;
  const yOf = (v: number) => 2 + (1 - Math.max(0, Math.min(1, v))) * (height - 4);

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

  return (
    <svg
      viewBox={`0 0 ${VW} ${height}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      style={{ height }}
    >
      <rect x={0} y={0} width={VW} height={height} fill="var(--chart-bg)" />
      {[0.5].map((g) => (
        <line
          key={g}
          x1={0}
          x2={VW}
          y1={yOf(g)}
          y2={yOf(g)}
          stroke="var(--chart-grid)"
          strokeWidth={0.5}
        />
      ))}
      {classNames.map((cls) => (
        <path
          key={cls}
          d={classPath(cls)}
          fill="none"
          stroke={rgb(classColors[cls])}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {classNames.length === 0 && (
        <text
          x={VW / 2}
          y={height / 2 + 3}
          fill="var(--chart-label)"
          fontSize={9}
          textAnchor="middle"
        >
          no detections
        </text>
      )}
    </svg>
  );
}
