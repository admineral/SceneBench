// Browser-local adapter that preserves the original FastAPI client contract.
// The UI can stay nearly 1:1 while jobs run in the tab against static assets.

import { analyzeSegmentInBrowser, sceneToSource, type AnalyzeSource } from "@/lib/analysis";
import { BROWSER_MODELS } from "@/lib/yolo";

export type ModelInfo = {
  id: string;
  level: number;
  label: string;
  filename: string;
  summary?: string;
  architecture?: string;
  imgsz?: number;
  dataset?: string;
  train_images?: number;
  total_images?: number;
  epochs?: string;
  run_name?: string;
  notes?: string;
};

export type VideoInfo = {
  id: string;
  label: string;
  source: "builtin" | "upload";
  filename: string;
  duration_sec: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
};

export type JobStatus = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  error: string | null;
};

export type Detection = {
  cls: string;
  cls_id: number;
  conf: number;
  box: [number, number, number, number];
};

export type Track = {
  id: number;
  cls: string;
  conf: number;
  box: number[];
  hits: number;
  missed: number;
};

export type Bridge = {
  id: number;
  cls: string;
  conf: number;
  box: number[];
  reason: string;
};

export type Health = {
  dominant_class: string;
  dominant_conf: number;
  second_class: string;
  second_conf: number;
  margin: number;
  instability: number;
  status: string;
  missing: boolean;
  low_margin: boolean;
  confidence_drop: boolean;
  class_switch: boolean;
  box_jitter: number;
  box_jitter_flag: boolean;
  event_reasons: string[];
};

export type FrameRecord = {
  t: number;
  frame: number;
  detections: Detection[];
  tracks: Track[];
  bridges: Bridge[];
  health: Health | null;
};

export type EventRecord = {
  t: number;
  frame: number;
  reason: string;
  reasons: string[];
  instability: number;
};

export type AnalysisResult = {
  meta: Record<string, unknown>;
  class_names: string[];
  class_colors: Record<string, [number, number, number]>;
  events: EventRecord[];
  frames: FrameRecord[];
  video: string;
};

export type AnalyzeRequest = {
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

export type Scene = {
  id: string;
  level: number;
  video_filename: string;
  name: string;
  start: number;
  end: number;
  labels: string[];
  notes: string;
  created_at: number;
  updated_at: number;
  duration_sec?: number;
  clip_src?: string;
};

export type ScenePayload = {
  level: number;
  name: string;
  start: number;
  end: number;
  labels: string[];
  notes: string;
};

type SceneManifest = {
  scenes: Scene[];
  skipped: unknown[];
};

type BrowserJob = JobStatus & {
  result?: AnalysisResult;
  source?: AnalyzeSource;
};

type LevelVideoAsset = {
  src: string;
  filename: string;
  duration_sec: number;
  fps: number;
  width: number;
  height: number;
};

const MODELS: ModelInfo[] = [
  {
    id: "level:21",
    level: 21,
    label: "Level 21 - best-21 quantized browser ONNX",
    filename: "best-21_quantized_640.onnx",
    summary: "Browser-local INT8 ONNX model served from public/models.",
    architecture: "Legacy raw ONNX Runtime Web WASM",
    imgsz: 640,
  },
  {
    id: "level:44",
    level: 44,
    label: "Level 44 - pseudo_m43 YOLO26n 512",
    filename: "pseudo_m43_yolo26n_512_e150_b16_best.onnx",
    summary: "Pseudo-label YOLO26n model exported from best.pt for browser inference.",
    architecture: "YOLO26n ONNX Runtime Web WASM",
    imgsz: 512,
    dataset: "pseudo_m43_all_levels",
    notes: "Exported locally from pseudo_m43_yolo26n_512_e150_b16/weights/best.pt.",
  },
];

const RAW_LEVEL_VIDEO: Record<number, LevelVideoAsset> = {
  1: {
    src: "/videos/output-640.mp4",
    filename: "output.mp4",
    duration_sec: 13.76,
    fps: 25,
    width: 640,
    height: 472,
  },
  2: {
    src: "/videos/vid-sample-640.mp4",
    filename: "vid.mp4",
    duration_sec: 1080.16,
    fps: 25,
    width: 640,
    height: 414,
  },
  3: {
    src: "/videos/level-3-sample-640.mp4",
    filename: "Level_3.mp4",
    duration_sec: 1795.44,
    fps: 25,
    width: 640,
    height: 414,
  },
};

const uploadVideos = new Map<string, VideoInfo & { url: string }>();
const jobs = new Map<string, BrowserJob>();
let sceneManifestPromise: Promise<SceneManifest> | null = null;

function storageKey(level?: number): string {
  return `rv2.browserScenes${level != null ? `.${level}` : ""}`;
}

function uuid(prefix = "local"): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`;
}

async function loadManifest(): Promise<SceneManifest> {
  if (!sceneManifestPromise) {
    sceneManifestPromise = fetch("/scenes/manifest.json", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`manifest -> ${res.status}`);
        return res.json() as Promise<SceneManifest>;
      })
      .catch(() => ({ scenes: [], skipped: [] }));
  }
  return sceneManifestPromise;
}

function readLocalScenes(level?: number): Scene[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(level));
    return raw ? (JSON.parse(raw) as Scene[]) : [];
  } catch {
    return [];
  }
}

function writeLocalScenes(scenes: Scene[], level?: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(level), JSON.stringify(scenes));
}

async function allScenes(): Promise<Scene[]> {
  const manifest = await loadManifest();
  const local = readLocalScenes();
  const deleted = new Set(readDeletedSceneIds());
  const byId = new Map<string, Scene>();
  for (const scene of manifest.scenes) {
    if (!deleted.has(scene.id)) byId.set(scene.id, scene);
  }
  for (const scene of local) byId.set(scene.id, scene);
  return [...byId.values()].sort((a, b) => a.level - b.level || a.start - b.start);
}

function readDeletedSceneIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem("rv2.browserDeletedScenes") ?? "[]") as string[];
  } catch {
    return [];
  }
}

function writeDeletedSceneIds(ids: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("rv2.browserDeletedScenes", JSON.stringify([...new Set(ids)]));
}

async function metadataFor(src: string): Promise<Pick<VideoInfo, "duration_sec" | "fps" | "width" | "height">> {
  if (typeof document === "undefined") {
    return { duration_sec: null, fps: null, width: null, height: null };
  }
  const video = document.createElement("video");
  video.src = src;
  video.preload = "metadata";
  return new Promise((resolve) => {
    const done = () => {
      resolve({
        duration_sec: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
        fps: 25,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };
    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("error", () => resolve({ duration_sec: null, fps: null, width: null, height: null }), {
      once: true,
    });
  });
}

async function videoInfoForLevel(level: number, scenes: Scene[]): Promise<VideoInfo> {
  const asset = RAW_LEVEL_VIDEO[level];
  const levelScenes = scenes.filter((scene) => scene.level === level);
  const maxSceneEnd = Math.max(0, ...levelScenes.map((scene) => scene.end));
  const meta = asset ? await metadataFor(asset.src) : { duration_sec: null, fps: null, width: null, height: null };
  const duration = Math.max(asset?.duration_sec ?? 0, maxSceneEnd, meta.duration_sec ?? 0);

  return {
    id: `builtin:${level}`,
    label: `Level ${level} - ${levelScenes.length} cut scenes`,
    source: "builtin",
    filename: asset?.filename ?? `level-${level}.mp4`,
    duration_sec: duration || null,
    fps: meta.fps ?? asset?.fps ?? 25,
    width: meta.width ?? asset?.width ?? 640,
    height: meta.height ?? asset?.height ?? 414,
  };
}

function closestSceneFor(req: AnalyzeRequest, scenes: Scene[]): Scene | null {
  const level = levelFromVideo(req.video);
  if (level == null) return null;
  const reqStart = req.start_sec;
  const reqEnd = req.start_sec + req.duration_sec;
  const candidates = scenes.filter((s) => s.level === level && s.clip_src);
  return (
    candidates.find((s) => reqStart >= s.start - 0.75 && reqEnd <= s.end + 0.75) ??
    candidates
      .map((s) => ({ scene: s, delta: Math.abs(s.start - reqStart) + Math.abs(s.end - reqEnd) }))
      .sort((a, b) => a.delta - b.delta)[0]?.scene ??
    null
  );
}

function levelFromVideo(video: string): number | null {
  const m = /^builtin:(\d+)$/.exec(video);
  return m ? Number(m[1]) : null;
}

async function resolveAnalyzeSource(req: AnalyzeRequest): Promise<AnalyzeSource> {
  if (req.video.startsWith("upload:")) {
    const info = uploadVideos.get(req.video);
    if (!info) throw new Error("Uploaded video is no longer available in this tab.");
    return {
      src: info.url,
      label: info.label,
      level: null,
      originalStartSec: req.start_sec,
      mediaStartSec: req.start_sec,
    };
  }
  const scenes = await allScenes();
  const scene = closestSceneFor(req, scenes);
  if (scene) return sceneToSource(scene);
  const level = levelFromVideo(req.video);
  if (level != null) {
    const asset = RAW_LEVEL_VIDEO[level];
    return {
      src: asset?.src ?? "/videos/output-640.mp4",
      label: `Level ${level} preview`,
      level,
      originalStartSec: req.start_sec,
      mediaStartSec: 0,
    };
  }
  return {
    src: "/videos/output-640.mp4",
    label: "Output sample",
    level: null,
    originalStartSec: req.start_sec,
    mediaStartSec: 0,
  };
}

export const api = {
  async listModels(): Promise<ModelInfo[]> {
    void BROWSER_MODELS;
    return MODELS;
  },

  async listVideos(): Promise<VideoInfo[]> {
    const scenes = await allScenes();
    const builtins = await Promise.all([1, 2, 3].map((level) => videoInfoForLevel(level, scenes)));
    return [
      ...builtins,
      ...[...uploadVideos.values()].map(({ url: _url, ...info }) => info),
    ];
  },

  async upload(file: File): Promise<VideoInfo> {
    const id = `upload:${uuid("video")}`;
    const url = URL.createObjectURL(file);
    const meta = await metadataFor(url);
    const info: VideoInfo & { url: string } = {
      id,
      label: `Uploaded - ${file.name}`,
      source: "upload",
      filename: file.name,
      ...meta,
      url,
    };
    uploadVideos.set(id, info);
    return info;
  },

  async analyze(req: AnalyzeRequest): Promise<string> {
    const id = uuid("job");
    const job: BrowserJob = { id, status: "queued", progress: 0, message: "Queued", error: null };
    jobs.set(id, job);
    void (async () => {
      try {
        job.status = "running";
        job.message = "Preparing browser analysis";
        const source = await resolveAnalyzeSource(req);
        job.source = source;
        job.result = await analyzeSegmentInBrowser(req, source, (progress, message) => {
          job.progress = progress;
          job.message = message;
        });
        job.status = "done";
        job.progress = 1;
        job.message = "Done";
      } catch (error) {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        job.message = "Failed";
      }
    })();
    return id;
  },

  async jobStatus(id: string): Promise<JobStatus> {
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return { id: job.id, status: job.status, progress: job.progress, message: job.message, error: job.error };
  },

  async jobResult(id: string): Promise<AnalysisResult> {
    const job = jobs.get(id);
    if (!job?.result) throw new Error(`Job not ready: ${id}`);
    return job.result;
  },

  videoUrl(id: string): string {
    return jobs.get(id)?.result?.video ?? jobs.get(id)?.source?.src ?? "/videos/output-640.mp4";
  },

  rawVideoUrl(level: number): string {
    return RAW_LEVEL_VIDEO[level]?.src ?? "/videos/output-640.mp4";
  },

  async rawVideoInfo(level: number): Promise<VideoInfo> {
    const scenes = await allScenes();
    return videoInfoForLevel(level, scenes);
  },

  async listScenes(level?: number): Promise<Scene[]> {
    const scenes = await allScenes();
    return level != null ? scenes.filter((s) => s.level === level) : scenes;
  },

  async createScene(payload: ScenePayload): Promise<Scene> {
    const now = Date.now() / 1000;
    const scene: Scene = {
      id: uuid("scene"),
      level: payload.level,
      video_filename: payload.level === 1 ? "Lvl1.mp4" : payload.level === 2 ? "vid.mp4" : "Level_3.mp4",
      name: payload.name || `scene @ ${payload.start.toFixed(2)}s`,
      start: payload.start,
      end: payload.end,
      labels: payload.labels,
      notes: payload.notes,
      created_at: now,
      updated_at: now,
    };
    const local = readLocalScenes();
    writeLocalScenes([...local, scene]);
    return scene;
  },

  async updateScene(id: string, payload: ScenePayload): Promise<Scene> {
    const scenes = await allScenes();
    const existing = scenes.find((scene) => scene.id === id);
    if (!existing) throw new Error(`Scene not found: ${id}`);
    const updated: Scene = {
      ...existing,
      ...payload,
      updated_at: Date.now() / 1000,
    };
    const local = readLocalScenes().filter((scene) => scene.id !== id);
    writeLocalScenes([...local, updated]);
    return updated;
  },

  async deleteScene(id: string): Promise<void> {
    writeLocalScenes(readLocalScenes().filter((scene) => scene.id !== id));
    writeDeletedSceneIds([...readDeletedSceneIds(), id]);
  },
};

export function rgb(c: [number, number, number] | undefined): string {
  if (!c) return "rgb(148,163,184)";
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
