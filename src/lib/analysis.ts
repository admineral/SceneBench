"use client";

import {
  CLASS_COLORS,
  CLASS_NAMES,
  type Detection as YoloDetection,
  detectFromCanvas,
} from "@/lib/yolo";
import type {
  AnalysisResult,
  AnalyzeRequest,
  Bridge,
  EventRecord,
  FrameRecord,
  Health,
  Scene,
  Track,
} from "@/lib/api";

export type AnalyzeSource = {
  src: string;
  label: string;
  level: number | null;
  originalStartSec: number;
  mediaStartSec: number;
};

type ProgressCallback = (progress: number, message: string) => void;

type TrackState = {
  id: number;
  clsId: number;
  cls: string;
  conf: number;
  box: [number, number, number, number];
  previousBox?: [number, number, number, number];
  lastSeen: number;
  previousSeen?: number;
  hits: number;
  missed: number;
};

type HealthState = {
  lastByTrack: Map<number, Health & { dominant_class_id: number; box: number[] }>;
};

const TRACK_IOU_THRESH = 0.25;
const TRACK_MAX_GAP_SEC = 0.6;
const TRACK_LOCAL_IOU_THRESH = 0.05;
const TRACK_LOCAL_EXPAND = 0.3;
const HEALTH_CONF_DROP_THRESH = 0.35;
const HEALTH_LOW_MARGIN_THRESH = 0.15;
const HEALTH_BOX_JITTER_THRESH = 0.45;
const HEALTH_BORDERLINE_THRESH = 0.2;
const HEALTH_WARNING_THRESH = 0.3;
const HEALTH_CRITICAL_THRESH = 0.6;
const CAR_COUNT_CLASSES = new Set(["car_front", "car_rear", "car"]);
const LIGHT_EVIDENCE_CLASSES = new Set([
  "light",
  "light_front",
  "light_front_total",
  "light_rear",
  "light_rear_total",
  "light_total",
  "light_reflection",
]);
const HEALTH_RELEVANT_CLASSES = new Set([
  "car",
  "car_front",
  "car_rear",
  "car_side",
  ...LIGHT_EVIDENCE_CLASSES,
]);

export async function analyzeSegmentInBrowser(
  req: AnalyzeRequest,
  source: AnalyzeSource,
  progress: ProgressCallback
): Promise<AnalysisResult> {
  progress(0.02, "Loading video");
  const video = document.createElement("video");
  video.src = source.src;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  await waitForMetadata(video);

  const fps = 25;
  const clipDuration = Number.isFinite(video.duration) ? video.duration : req.duration_sec;
  const startSec = Math.max(0, req.start_sec);
  const requestedDuration = Math.max(0.1, req.duration_sec);
  const endSec = startSec + requestedDuration;
  const stride = Math.max(1, Math.round(req.frame_stride || 1));
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 360;
  const scale = sourceWidth > req.max_width ? req.max_width / sourceWidth : 1;
  const outWidth = even(Math.max(1, Math.round(sourceWidth * scale)));
  const outHeight = even(Math.max(1, Math.round(sourceHeight * scale)));
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create analysis canvas.");

  const frames: FrameRecord[] = [];
  const events: EventRecord[] = [];
  const tracks = new TrackStore();
  const healthState: HealthState = { lastByTrack: new Map() };
  const dt = stride / fps;
  const maxFrames = Math.max(1, Math.ceil(Math.min(clipDuration, requestedDuration) / dt));

  progress(0.04, "Loading model");
  await detectFromCanvas(emptyCanvas(), { confThreshold: 0.99, iouThreshold: req.iou, modelId: req.model });

  for (let idx = 0; idx < maxFrames; idx += 1) {
    const rel = idx * dt;
    if (rel > clipDuration + 0.001 || rel > requestedDuration + 0.001) break;
    const absTime = startSec + rel;
    await seekVideo(video, source.mediaStartSec + rel);
    ctx.clearRect(0, 0, outWidth, outHeight);
    ctx.drawImage(video, 0, 0, outWidth, outHeight);

    let detections = await detectFromCanvas(canvas, {
      confThreshold: req.conf,
      iouThreshold: req.iou,
      modelId: req.model,
    });
    if (!req.show_light_off) {
      detections = detections.filter((d) => d.className !== "Light_OFF");
    }

    const matched = tracks.update(detections, absTime);
    const activeTracks = tracks.active();
    const primary = selectPrimaryTrack(matched, activeTracks);
    const health = computeHealth(detections, primary, activeTracks, healthState);
    const bridges = req.bridge_gaps ? bridgePredictions(tracks.candidates(req.bridge_max_gap_frames), absTime) : [];

    const frame: FrameRecord = {
      t: absTime,
      frame: Math.round(absTime * fps),
      detections: detections.map(toRecordDetection),
      tracks: activeTracks.map(toRecordTrack),
      bridges,
      health,
    };
    frames.push(frame);

    const reason = eventReason(health);
    if (reason && health.instability >= HEALTH_BORDERLINE_THRESH) {
      events.push({
        t: absTime,
        frame: frame.frame,
        reason,
        reasons: health.event_reasons,
        instability: health.instability,
      });
    }

    if (idx % 2 === 0) {
      progress(0.05 + 0.9 * (idx / maxFrames), `Analyzing frame ${idx + 1}/${maxFrames}`);
      await yieldToBrowser();
    }
  }

  progress(0.98, "Finalizing result");
  const classColors = Object.fromEntries(
    CLASS_NAMES.map((name, idx) => [name, hexToRgb(CLASS_COLORS[idx % CLASS_COLORS.length])])
  ) as Record<string, [number, number, number]>;

  return {
    meta: {
      source: source.label,
      source_url: source.src,
      model: req.model,
      conf: req.conf,
      iou: req.iou,
      backend: "browser-wasm",
      start_sec: startSec,
      end_sec: endSec,
      duration_sec: requestedDuration,
      fps,
      out_fps: fps / stride,
      replay_speed: req.replay_speed,
      time_scale: 1,
      frame_stride: stride,
      frames_processed: frames.length,
      source_width: sourceWidth,
      source_height: sourceHeight,
      out_width: outWidth,
      out_height: outHeight,
      bridge_gaps: req.bridge_gaps,
      suppress_flicker_boxes: req.suppress_flicker_boxes,
      show_box_labels: req.show_box_labels,
      num_events: events.length,
    },
    class_names: CLASS_NAMES,
    class_colors: classColors,
    events,
    frames,
    video: source.src,
  };
}

function emptyCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  return canvas;
}

function toRecordDetection(d: YoloDetection) {
  return { cls: d.className, cls_id: d.classId, conf: d.score, box: d.box };
}

function toRecordTrack(track: TrackState): Track {
  return {
    id: track.id,
    cls: track.cls,
    conf: track.conf,
    box: track.box,
    hits: track.hits,
    missed: track.missed,
  };
}

function bridgePredictions(candidates: TrackState[], timeSec: number): Bridge[] {
  return candidates.map((track) => ({
    id: track.id,
    cls: track.cls,
    conf: Math.max(0.25, track.conf * 0.85),
    box: predictBox(track, timeSec),
    reason: "short_gap",
  }));
}

function predictBox(track: TrackState, timeSec: number): number[] {
  if (!track.previousBox || track.previousSeen == null || track.lastSeen <= track.previousSeen) {
    return track.box;
  }
  const ratio = (timeSec - track.lastSeen) / (track.lastSeen - track.previousSeen);
  return track.box.map((v, i) => v + (v - track.previousBox![i]) * ratio);
}

class TrackStore {
  private tracks = new Map<number, TrackState>();
  private nextId = 1;

  update(detections: YoloDetection[], timeSec: number): TrackState[] {
    for (const [id, track] of this.tracks) {
      if (timeSec - track.lastSeen > TRACK_MAX_GAP_SEC) this.tracks.delete(id);
    }
    const carDets = detections.filter((d) => CAR_COUNT_CLASSES.has(d.className));
    const matches: Array<{ iou: number; track: TrackState; det: YoloDetection }> = [];
    for (const track of this.tracks.values()) {
      for (const det of carDets) {
        const overlap = boxIou(track.box, det.box);
        if (overlap >= TRACK_IOU_THRESH) matches.push({ iou: overlap, track, det });
      }
    }
    matches.sort((a, b) => b.iou - a.iou);
    const usedTracks = new Set<number>();
    const usedDets = new Set<YoloDetection>();
    const matched: TrackState[] = [];
    for (const match of matches) {
      if (usedTracks.has(match.track.id) || usedDets.has(match.det)) continue;
      match.track.previousBox = [...match.track.box];
      match.track.previousSeen = match.track.lastSeen;
      match.track.box = match.det.box;
      match.track.conf = match.det.score;
      match.track.clsId = match.det.classId;
      match.track.cls = match.det.className;
      match.track.lastSeen = timeSec;
      match.track.hits += 1;
      match.track.missed = 0;
      usedTracks.add(match.track.id);
      usedDets.add(match.det);
      matched.push(match.track);
    }
    for (const det of carDets) {
      if (usedDets.has(det)) continue;
      const track: TrackState = {
        id: this.nextId++,
        clsId: det.classId,
        cls: det.className,
        conf: det.score,
        box: det.box,
        lastSeen: timeSec,
        hits: 1,
        missed: 0,
      };
      this.tracks.set(track.id, track);
      matched.push(track);
    }
    for (const track of this.tracks.values()) {
      if (!matched.some((t) => t.id === track.id)) track.missed += 1;
    }
    return matched;
  }

  active(): TrackState[] {
    return [...this.tracks.values()];
  }

  candidates(maxGapFrames: number): TrackState[] {
    return this.active().filter((track) => track.missed > 0 && track.missed <= maxGapFrames);
  }
}

function selectPrimaryTrack(matched: TrackState[], active: TrackState[]): TrackState | null {
  const pool = matched.length ? matched : active;
  return pool.length ? [...pool].sort((a, b) => b.conf - a.conf)[0] : null;
}

function computeHealth(
  detections: YoloDetection[],
  primary: TrackState | null,
  activeTracks: TrackState[],
  state: HealthState
): Health {
  const confs = CLASS_NAMES.map(() => 0);
  const trackBox = primary?.box ?? null;
  const classBoxes = new Map<number, [number, number, number, number]>();
  for (const det of detections) {
    if (!HEALTH_RELEVANT_CLASSES.has(det.className)) continue;
    if (!isTrackLocalDetection(trackBox, det.box)) continue;
    if (det.score > confs[det.classId]) {
      confs[det.classId] = det.score;
      classBoxes.set(det.classId, det.box);
    }
  }
  const ranked = confs
    .map((conf, id) => ({ conf, id }))
    .filter((x) => x.conf > 0)
    .sort((a, b) => b.conf - a.conf);
  const dominantId = ranked[0]?.id ?? -1;
  const secondId = ranked[1]?.id ?? -1;
  const dominantConf = ranked[0]?.conf ?? 0;
  const secondConf = ranked[1]?.conf ?? 0;
  const margin = dominantConf - secondConf;
  const box = dominantId >= 0 ? classBoxes.get(dominantId) ?? trackBox ?? [] : trackBox ?? [];
  const trackId = primary?.id ?? 0;
  const prev = state.lastByTrack.get(trackId);
  const missing = dominantId < 0;
  const classSwitch = Boolean(prev && prev.dominant_class_id >= 0 && dominantId >= 0 && prev.dominant_class_id !== dominantId);
  const confidenceDrop = Boolean(prev && prev.dominant_conf - dominantConf >= HEALTH_CONF_DROP_THRESH);
  const boxJitter = boxJitterScore(prev?.box, box);
  const boxJitterFlag = boxJitter >= HEALTH_BOX_JITTER_THRESH;
  const lowMargin = !missing && margin <= HEALTH_LOW_MARGIN_THRESH;
  const instability = Math.min(
    0.35 * Number(classSwitch) +
      0.25 * Number(confidenceDrop) +
      0.2 * Math.min(boxJitter / HEALTH_BOX_JITTER_THRESH, 1) +
      0.3 * Number(missing) +
      0.25 * Number(lowMargin),
    1
  );
  const event_reasons = [
    classSwitch ? "class_switch" : "",
    confidenceDrop ? "confidence_drop" : "",
    boxJitterFlag ? "box_jitter" : "",
    missing ? "missing_track" : "",
    lowMargin ? "low_margin" : "",
  ].filter(Boolean);
  const health = {
    dominant_class: className(dominantId),
    dominant_conf: dominantConf,
    second_class: className(secondId),
    second_conf: secondConf,
    margin,
    instability,
    status: healthStatus(instability),
    missing,
    low_margin: lowMargin,
    confidence_drop: confidenceDrop,
    class_switch: classSwitch,
    box_jitter: boxJitter,
    box_jitter_flag: boxJitterFlag,
    event_reasons,
  };
  if (trackId) state.lastByTrack.set(trackId, { ...health, dominant_class_id: dominantId, box: [...box] });
  void activeTracks;
  return health;
}

function className(id: number): string {
  return id >= 0 ? CLASS_NAMES[id] ?? "" : "";
}

function healthStatus(score: number): string {
  if (score >= HEALTH_CRITICAL_THRESH) return "CRITICAL";
  if (score >= HEALTH_WARNING_THRESH) return "WARNING";
  if (score >= HEALTH_BORDERLINE_THRESH) return "BORDERLINE";
  return "STABLE";
}

function eventReason(health: Health): string {
  if (health.class_switch) return "switch";
  if (health.confidence_drop) return "drop";
  if (health.box_jitter_flag) return "jitter";
  if (health.missing) return "missing_track";
  return "";
}

function isTrackLocalDetection(trackBox: number[] | null, detBox: number[]): boolean {
  if (!trackBox) return true;
  if (boxIou(trackBox, detBox) >= TRACK_LOCAL_IOU_THRESH) return true;
  const [tx1, ty1, tx2, ty2] = trackBox;
  const [dx1, dy1, dx2, dy2] = detBox;
  const tw = Math.max(1, tx2 - tx1);
  const th = Math.max(1, ty2 - ty1);
  const dcx = (dx1 + dx2) / 2;
  const dcy = (dy1 + dy2) / 2;
  return tx1 - tw * TRACK_LOCAL_EXPAND <= dcx && dcx <= tx2 + tw * TRACK_LOCAL_EXPAND && ty1 - th * TRACK_LOCAL_EXPAND <= dcy && dcy <= ty2 + th * TRACK_LOCAL_EXPAND;
}

function boxJitterScore(prev: number[] | undefined, box: number[]): number {
  if (!prev || box.length < 4) return 0;
  const [, , pw, , pArea] = centerArea(prev);
  const [, , w, , area] = centerArea(box);
  if (pArea <= 0 || area <= 0) return 0;
  const centerShift = Math.hypot((box[0] + box[2] - prev[0] - prev[2]) / 2, (box[1] + box[3] - prev[1] - prev[3]) / 2);
  return centerShift / Math.max(1, pw) + Math.abs(area - pArea) / Math.max(area, pArea) + Math.abs(w - pw) / Math.max(1, Math.max(w, pw));
}

function centerArea(box: number[]): [number, number, number, number, number] {
  const w = Math.max(0, box[2] - box[0]);
  const h = Math.max(0, box[3] - box[1]);
  return [box[0] + w / 2, box[1] + h / 2, w, h, w * h];
}

function boxIou(a: number[], b: number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function even(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
    };
    const onMeta = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load video metadata."));
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onError);
  });
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = Math.max(0, Math.min(video.duration || time, time));
  });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export function sceneToSource(scene: Scene): AnalyzeSource {
  return {
    src: scene.clip_src ?? `/videos/scenes/level-${scene.level}/${scene.id}.mp4`,
    label: scene.name || `Level ${scene.level} scene`,
    level: scene.level,
    originalStartSec: scene.start,
    mediaStartSec: 0,
  };
}
