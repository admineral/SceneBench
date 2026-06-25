"use client";

export type AssetTarget = {
  id: string;
  label: string;
  url: string;
  kind: "runtime" | "model" | "video" | "manifest";
};

export type AssetStatus = "idle" | "checking" | "reachable" | "cached" | "loading" | "error" | "unsupported";

export type AssetState = {
  status: AssetStatus;
  loadedBytes?: number;
  totalBytes?: number;
  message?: string;
};

export type StorageUsage = {
  usedBytes?: number;
  quotaBytes?: number;
};

export const ASSET_CACHE_NAME = "scenebench-assets-v1";

export const ORT_ASSET_PATHS = [
  "/ort/ort-wasm-simd-threaded.mjs",
  "/ort/ort-wasm-simd-threaded.wasm",
  "/ort/ort-wasm-simd-threaded.jsep.mjs",
  "/ort/ort-wasm-simd-threaded.jsep.wasm",
];

export function canUseAssetCache(): boolean {
  return typeof window !== "undefined" && "caches" in window;
}

export async function storageUsage(): Promise<StorageUsage> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return {};
  const estimate = await navigator.storage.estimate();
  return {
    usedBytes: estimate.usage,
    quotaBytes: estimate.quota,
  };
}

export async function checkAsset(target: AssetTarget): Promise<AssetState> {
  if (!canUseAssetCache()) {
    return { status: "unsupported", message: "Cache Storage is not available in this browser." };
  }

  const cache = await caches.open(ASSET_CACHE_NAME);
  const cached = await cache.match(target.url);
  if (cached) {
    return {
      status: "cached",
      totalBytes: contentLength(cached),
      message: "Stored in browser Cache Storage.",
    };
  }

  try {
    const res = await fetch(target.url, { method: "HEAD", cache: "force-cache" });
    if (!res.ok) {
      return { status: "error", message: `HTTP ${res.status}` };
    }
    return {
      status: "reachable",
      totalBytes: contentLength(res),
      message: "Reachable. Browser HTTP cache may still reuse it automatically.",
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function cacheAsset(
  target: AssetTarget,
  onProgress: (state: AssetState) => void,
): Promise<AssetState> {
  if (!canUseAssetCache()) {
    return { status: "unsupported", message: "Cache Storage is not available in this browser." };
  }

  const cache = await caches.open(ASSET_CACHE_NAME);
  const cached = await cache.match(target.url);
  if (cached) {
    const state = {
      status: "cached" as const,
      totalBytes: contentLength(cached),
      message: "Already stored in browser Cache Storage.",
    };
    onProgress(state);
    return state;
  }

  const res = await fetch(target.url, { cache: "force-cache" });
  if (!res.ok) {
    return { status: "error", message: `HTTP ${res.status}` };
  }

  const totalBytes = contentLength(res);
  if (!res.body) {
    await cache.put(target.url, res.clone());
    return { status: "cached", totalBytes, message: "Stored in browser Cache Storage." };
  }

  const reader = res.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let loadedBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      loadedBytes += value.byteLength;
      onProgress({ status: "loading", loadedBytes, totalBytes, message: "Downloading..." });
    }
  }

  const headers = new Headers(res.headers);
  const stored = new Response(new Blob(chunks), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
  await cache.put(target.url, stored);

  return {
    status: "cached",
    loadedBytes,
    totalBytes: totalBytes ?? loadedBytes,
    message: "Stored in browser Cache Storage.",
  };
}

export async function clearAssetCache(): Promise<void> {
  if (canUseAssetCache()) {
    await caches.delete(ASSET_CACHE_NAME);
  }
}

export function clearSceneBenchLocalStorage(): void {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("rv2.")) {
      window.localStorage.removeItem(key);
    }
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function contentLength(res: Response): number | undefined {
  const raw = res.headers.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
