"use client";

import { useRef, useState } from "react";
import type { ModelInfo, Scene, VideoInfo } from "@/lib/api";
import { useModelPrefs } from "@/lib/prefs";
import ModelPicker from "./ModelPicker";
import ModelDetails from "./ModelDetails";

export type Settings = {
  video: string;
  model: string;
  conf: number;
  iou: number;
  backend: string;
  start_sec: number;
  duration_sec: number;
  frame_stride: number;
  bridge_gaps: boolean;
  bridge_max_gap_frames: number;
  suppress_flicker_boxes: boolean;
  suppress_min_hits: number;
  show_light_off: boolean;
  show_box_labels: boolean;
  max_width: number;
  replay_speed: number;
};

type Props = {
  models: ModelInfo[];
  videos: VideoInfo[];
  scenes: Scene[];
  settings: Settings;
  activeSceneName: string | null;
  onChange: (next: Partial<Settings>) => void;
  onUpload: (file: File) => Promise<void>;
  onAnalyze: () => void;
  onLoadScene: (scene: Scene) => void;
  onRunScene: (scene: Scene) => void;
  busy: boolean;
};

export default function ConfigPanel({
  models,
  videos,
  scenes,
  settings,
  activeSceneName,
  onChange,
  onUpload,
  onAnalyze,
  onLoadScene,
  onRunScene,
  busy,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { prefs, setDefaults } = useModelPrefs();

  const selectedModel = models.find((m) => m.id === settings.model);
  const selectedVideo = videos.find((v) => v.id === settings.video);
  const builtinVideos = videos.filter((v) => v.source === "builtin");
  const maxStart = selectedVideo?.duration_sec
    ? Math.max(0, Math.floor(selectedVideo.duration_sec - 1))
    : undefined;
  const isCurrentDefault =
    prefs.defaultModel === settings.model && prefs.defaultConf === settings.conf;

  return (
    <div className="flex flex-col gap-4">
      {/* Model */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Model
        </p>
        <ModelPicker
          models={models}
          value={settings.model}
          onChange={(id) => onChange({ model: id })}
        />
        {settings.model && !isCurrentDefault && (
          <button
            type="button"
            onClick={() => setDefaults(settings.model, settings.conf)}
            className="mt-1 text-[11px] text-slate-500 hover:text-slate-300"
          >
            Set as default
          </button>
        )}
        <ModelDetails model={selectedModel} />
      </div>

      {/* Video level buttons */}
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Video
        </p>
        <div className="flex flex-wrap gap-1.5">
          {builtinVideos.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onChange({ video: v.id })}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                settings.video === v.id
                  ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                  : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"
              }`}
            >
              {v.label.split(" - ")[0]}
            </button>
          ))}
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
              selectedVideo?.source === "upload"
                ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200"
            }`}
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setUploading(true);
              try {
                await onUpload(f);
              } finally {
                setUploading(false);
                if (fileRef.current) fileRef.current.value = "";
              }
            }}
          />
        </div>
        {selectedVideo && (
          <p className="mt-1 text-[11px] text-slate-500">
            {selectedVideo.duration_sec != null
              ? `${selectedVideo.width}×${selectedVideo.height} · ${fmt(selectedVideo.duration_sec)} · ${selectedVideo.fps}fps`
              : selectedVideo.label}
          </p>
        )}
      </div>

      {/* Saved scenes */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Saved scenes
          </p>
          <a href="/scenes" className="text-[11px] text-sky-400 hover:text-sky-300">
            Manage →
          </a>
        </div>
        {scenes.length === 0 ? (
          <p className="text-xs text-slate-500">No saved scenes yet.</p>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {scenes.map((sc) => {
              const isActive =
                activeSceneName === sc.name &&
                settings.video === `builtin:${sc.level}` &&
                Math.round(settings.start_sec) === Math.round(sc.start);
              return (
                <li
                  key={sc.id}
                  className={`flex items-center gap-2 rounded-lg border p-2 ${
                    isActive
                      ? "border-sky-500/50 bg-sky-500/5"
                      : "border-slate-800"
                  }`}
                >
                  <button
                    onClick={() => onLoadScene(sc)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm text-slate-100">
                      {sc.name || `scene @ ${sc.start.toFixed(1)}s`}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      L{sc.level} · {sc.start.toFixed(1)}–{sc.end.toFixed(1)}s
                    </div>
                  </button>
                  <button
                    onClick={() => onRunScene(sc)}
                    disabled={busy}
                    className="shrink-0 rounded-md border border-sky-700 px-2 py-1 text-xs text-sky-300 transition hover:bg-sky-900/40 disabled:opacity-40"
                  >
                    ▶ Run
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Collapsible: Segment */}
      <CollapsibleSection title="Segment">
        <NumberField
          label="Start (s)"
          value={settings.start_sec}
          min={0}
          max={maxStart}
          step={1}
          onChange={(v) => onChange({ start_sec: v })}
        />
        <SliderRow
          label="Duration"
          value={settings.duration_sec}
          min={1}
          max={30}
          step={1}
          suffix="s"
          onChange={(v) => onChange({ duration_sec: v })}
        />
        <SliderRow
          label="Frame stride"
          value={settings.frame_stride}
          min={1}
          max={10}
          step={1}
          suffix="×"
          onChange={(v) => onChange({ frame_stride: v })}
          hint="Process every Nth frame (higher = faster, coarser)."
        />
        <Field label="Replay speed">
          <select
            className="input"
            value={settings.replay_speed}
            onChange={(e) => onChange({ replay_speed: Number(e.target.value) })}
          >
            <option value={1}>1× realtime</option>
            <option value={0.5}>0.5× (half speed)</option>
            <option value={0.25}>0.25× (quarter speed)</option>
            <option value={0.1}>0.1× (slow motion)</option>
          </select>
        </Field>
      </CollapsibleSection>

      {/* Collapsible: Detector */}
      <CollapsibleSection title="Detector">
        <SliderRow
          label="Confidence"
          value={settings.conf}
          min={0.05}
          max={0.9}
          step={0.05}
          onChange={(v) => onChange({ conf: v })}
        />
        <SliderRow
          label="IoU (NMS)"
          value={settings.iou}
          min={0.1}
          max={0.9}
          step={0.05}
          onChange={(v) => onChange({ iou: v })}
        />
        <Field label="Output width">
          <select
            className="input"
            value={settings.max_width}
            onChange={(e) => onChange({ max_width: Number(e.target.value) })}
          >
            <option value={854}>854 (fast)</option>
            <option value={1280}>1280 (balanced)</option>
            <option value={1920}>1920 (sharp)</option>
          </select>
        </Field>
      </CollapsibleSection>

      {/* Collapsible: Repair */}
      <CollapsibleSection title="Repair / Stability">
        <Toggle
          label="Bridge short gaps"
          checked={settings.bridge_gaps}
          onChange={(v) => onChange({ bridge_gaps: v })}
          hint="Predict car boxes across brief detector dropouts."
        />
        {settings.bridge_gaps && (
          <SliderRow
            label="Max gap frames"
            value={settings.bridge_max_gap_frames}
            min={1}
            max={6}
            step={1}
            onChange={(v) => onChange({ bridge_max_gap_frames: v })}
          />
        )}
        <Toggle
          label="Suppress flicker boxes"
          checked={settings.suppress_flicker_boxes}
          onChange={(v) => onChange({ suppress_flicker_boxes: v })}
          hint="Hide cars until they survive enough consecutive frames."
        />
        {settings.suppress_flicker_boxes && (
          <SliderRow
            label="Min hits"
            value={settings.suppress_min_hits}
            min={1}
            max={8}
            step={1}
            onChange={(v) => onChange({ suppress_min_hits: v })}
          />
        )}
        <Toggle
          label="Show Light_OFF"
          checked={settings.show_light_off}
          onChange={(v) => onChange({ show_light_off: v })}
        />
        <Toggle
          label="Box labels"
          checked={settings.show_box_labels}
          onChange={(v) => onChange({ show_box_labels: v })}
        />
      </CollapsibleSection>

      <button
        onClick={onAnalyze}
        disabled={busy || !settings.video || !settings.model}
        className="w-full rounded-lg bg-sky-500 px-4 py-2.5 font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Analyzing…" : "Analyze segment"}
      </button>
    </div>
  );
}

function CollapsibleSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-slate-800 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-400"
      >
        <span>{title}</span>
        <span className="text-slate-600 text-[10px]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-slate-300">{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        className="input"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-100">
          {value}
          {suffix ?? ""}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-sm text-slate-300">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative h-5 w-9 rounded-full transition ${
            checked ? "bg-sky-500" : "bg-slate-700"
          }`}
        >
          <span
            className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition"
            style={{ left: checked ? "1.125rem" : "0.125rem" }}
          />
        </button>
      </label>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
