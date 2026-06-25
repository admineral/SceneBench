"use client";

import type * as Ort from "onnxruntime-web";

export type Detection = {
  box: [number, number, number, number];
  score: number;
  classId: number;
  className: string;
};

export type BrowserModelConfig = {
  id: string;
  path: string;
  inputSize: number;
  outputFormat: "legacy-yolo-raw" | "yolo26-nms-xyxy";
};

export type ModelLoadState = {
  id: string;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

export const CLASS_NAMES = [
  "Light_OFF",
  "bike",
  "car_front",
  "car_rear",
  "car_side",
  "light",
  "light_front",
  "light_front_total",
  "light_rear",
  "light_reflection",
  "light_total",
];

export const CLASS_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#84cc16",
  "#14b8a6",
  "#f97316",
  "#eab308",
];

export const BROWSER_MODELS: BrowserModelConfig[] = [
  {
    id: "level:21",
    path: "/models/best-21_quantized_640.onnx",
    inputSize: 640,
    outputFormat: "legacy-yolo-raw",
  },
  {
    id: "level:44",
    path: "/models/pseudo_m43_yolo26n_512_e150_b16_best.onnx",
    inputSize: 512,
    outputFormat: "yolo26-nms-xyxy",
  },
];

const sessionPromises = new Map<string, Promise<Ort.InferenceSession>>();
const modelLoadStates = new Map<string, ModelLoadState>();
const MODEL_LOAD_EVENT = "rv2-model-load-state";
let ortPromise: Promise<typeof Ort> | null = null;
let ortConfigured = false;

export function modelConfig(modelId = "level:21"): BrowserModelConfig {
  return BROWSER_MODELS.find((model) => model.id === modelId) ?? BROWSER_MODELS[0];
}

export function loadModel(modelId = "level:21"): Promise<Ort.InferenceSession> {
  const config = modelConfig(modelId);
  if (!sessionPromises.has(config.id)) {
    setModelLoadState({ id: config.id, status: "loading" });
    const promise = getOrt()
      .then((ort) => {
        configureOrt(ort);
        return ort.InferenceSession.create(config.path, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
      })
      .then((session) => {
        setModelLoadState({ id: config.id, status: "ready" });
        return session;
      })
      .catch((error) => {
        sessionPromises.delete(config.id);
        setModelLoadState({
          id: config.id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    sessionPromises.set(config.id, promise);
  }
  return sessionPromises.get(config.id)!;
}

function getOrt(): Promise<typeof Ort> {
  if (!ortPromise) {
    ortPromise = import("onnxruntime-web/wasm") as Promise<typeof Ort>;
  }
  return ortPromise;
}

function configureOrt(ort: typeof Ort): void {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = "/ort/";
  // ONNX Runtime Web can use WASM threads only when the page is cross-origin
  // isolated. Otherwise keep single-threaded mode to avoid worker init errors.
  ort.env.wasm.numThreads =
    typeof self !== "undefined" && self.crossOriginIsolated
      ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
      : 1;
  ortConfigured = true;
}

export function getModelLoadState(modelId = "level:21"): ModelLoadState {
  const config = modelConfig(modelId);
  return modelLoadStates.get(config.id) ?? { id: config.id, status: "idle" };
}

export function subscribeModelLoadState(callback: (state: ModelLoadState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onState = (event: Event) => {
    callback((event as CustomEvent<ModelLoadState>).detail);
  };
  window.addEventListener(MODEL_LOAD_EVENT, onState);
  return () => window.removeEventListener(MODEL_LOAD_EVENT, onState);
}

function setModelLoadState(state: ModelLoadState): void {
  modelLoadStates.set(state.id, state);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MODEL_LOAD_EVENT, { detail: state }));
  }
}

export function getModelPath(modelId = "level:21"): string {
  return modelConfig(modelId).path;
}

export async function detectFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  options: { confThreshold: number; iouThreshold: number; modelId?: string }
): Promise<Detection[]> {
  const config = modelConfig(options.modelId);
  const [ort, session] = await Promise.all([getOrt(), loadModel(config.id)]);
  const input = canvasToTensor(sourceCanvas, config.inputSize);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const feeds: Record<string, Ort.Tensor> = {
    [inputName]: new ort.Tensor("float32", input, [1, 3, config.inputSize, config.inputSize]),
  };
  const started = performance.now();
  const results = await session.run(feeds);
  const elapsed = performance.now() - started;
  console.debug(`ONNX inference: ${elapsed.toFixed(1)}ms`);

  const output = results[outputName];
  if (!output || !(output.data instanceof Float32Array)) {
    throw new Error("Unexpected model output.");
  }

  return config.outputFormat === "yolo26-nms-xyxy"
    ? processYolo26NmsOutput(output.data, sourceCanvas.width, sourceCanvas.height, config.inputSize, options)
    : processRawOutput(output.data, sourceCanvas.width, sourceCanvas.height, config.inputSize, options);
}

function canvasToTensor(sourceCanvas: HTMLCanvasElement, inputSize: number): Float32Array {
  const work = document.createElement("canvas");
  work.width = inputSize;
  work.height = inputSize;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Could not create preprocessing canvas.");
  }

  ctx.drawImage(sourceCanvas, 0, 0, inputSize, inputSize);
  const { data } = ctx.getImageData(0, 0, inputSize, inputSize);
  const tensor = new Float32Array(3 * inputSize * inputSize);
  const planeSize = inputSize * inputSize;

  for (let i = 0; i < planeSize; i += 1) {
    const pixel = i * 4;
    tensor[i] = data[pixel] / 255;
    tensor[planeSize + i] = data[pixel + 1] / 255;
    tensor[planeSize * 2 + i] = data[pixel + 2] / 255;
  }

  return tensor;
}

function processRawOutput(
  output: Float32Array,
  imageWidth: number,
  imageHeight: number,
  inputSize: number,
  options: { confThreshold: number; iouThreshold: number }
): Detection[] {
  const valuesPerPrediction = 4 + CLASS_NAMES.length;
  const predictionCount = output.length / valuesPerPrediction;
  const detections: Detection[] = [];

  for (let anchor = 0; anchor < predictionCount; anchor += 1) {
    let bestScore = -Infinity;
    let bestClassId = -1;

    for (let classId = 0; classId < CLASS_NAMES.length; classId += 1) {
      const score = output[(4 + classId) * predictionCount + anchor];
      if (score > bestScore) {
        bestScore = score;
        bestClassId = classId;
      }
    }

    if (bestScore <= options.confThreshold || bestClassId < 0) {
      continue;
    }

    const cx = output[anchor];
    const cy = output[predictionCount + anchor];
    const w = output[predictionCount * 2 + anchor];
    const h = output[predictionCount * 3 + anchor];
    const scaleX = imageWidth / inputSize;
    const scaleY = imageHeight / inputSize;
    const x1 = (cx - w / 2) * scaleX;
    const y1 = (cy - h / 2) * scaleY;
    const x2 = (cx + w / 2) * scaleX;
    const y2 = (cy + h / 2) * scaleY;

    detections.push({
      box: [
        clamp(x1, 0, imageWidth),
        clamp(y1, 0, imageHeight),
        clamp(x2, 0, imageWidth),
        clamp(y2, 0, imageHeight),
      ],
      score: bestScore,
      classId: bestClassId,
      className: CLASS_NAMES[bestClassId],
    });
  }

  return multiclassNms(detections, options.iouThreshold);
}

function processYolo26NmsOutput(
  output: Float32Array,
  imageWidth: number,
  imageHeight: number,
  inputSize: number,
  options: { confThreshold: number; iouThreshold: number }
): Detection[] {
  const detections: Detection[] = [];
  const scaleX = imageWidth / inputSize;
  const scaleY = imageHeight / inputSize;
  const rows = Math.floor(output.length / 6);
  for (let row = 0; row < rows; row += 1) {
    const offset = row * 6;
    const x1 = output[offset] * scaleX;
    const y1 = output[offset + 1] * scaleY;
    const x2 = output[offset + 2] * scaleX;
    const y2 = output[offset + 3] * scaleY;
    const score = output[offset + 4];
    const classId = Math.round(output[offset + 5]);
    if (score <= options.confThreshold || classId < 0 || classId >= CLASS_NAMES.length) continue;
    if (x2 <= x1 || y2 <= y1) continue;
    detections.push({
      box: [
        clamp(x1, 0, imageWidth),
        clamp(y1, 0, imageHeight),
        clamp(x2, 0, imageWidth),
        clamp(y2, 0, imageHeight),
      ],
      score,
      classId,
      className: CLASS_NAMES[classId],
    });
  }
  return multiclassNms(detections, options.iouThreshold);
}

function multiclassNms(detections: Detection[], iouThreshold: number): Detection[] {
  const byClass = new Map<number, Detection[]>();
  for (const detection of detections) {
    const bucket = byClass.get(detection.classId) ?? [];
    bucket.push(detection);
    byClass.set(detection.classId, bucket);
  }

  const kept: Detection[] = [];
  for (const bucket of byClass.values()) {
    kept.push(...nms(bucket, iouThreshold));
  }

  return kept.sort((a, b) => b.score - a.score);
}

function nms(detections: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];

  while (sorted.length > 0) {
    const best = sorted.shift();
    if (!best) {
      break;
    }
    kept.push(best);

    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (iou(best.box, sorted[i].box) >= iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }

  return kept;
}

function iou(a: Detection["box"], b: Detection["box"]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
