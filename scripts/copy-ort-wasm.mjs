import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = join(root, "..");
const sourceDir = join(appRoot, "node_modules", "onnxruntime-web", "dist");
const targetDir = join(appRoot, "public", "ort");

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

const requiredFiles = new Set([
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]);

for (const file of readdirSync(sourceDir)) {
  if (requiredFiles.has(file)) {
    copyFileSync(join(sourceDir, file), join(targetDir, file));
  }
}
