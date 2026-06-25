import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const repoRoot = resolve(appRoot, "..");
const scenesPath = resolve(repoRoot, "webapp/backend/scenes/scenes.json");
const outputRoot = resolve(appRoot, "public/videos/scenes");
const manifestPath = resolve(appRoot, "public/scenes/manifest.json");

const sourceDirs = (process.env.SCENEBENCH_VIDEO_DIRS ?? "")
  .split(":")
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => resolve(dir));

if (sourceDirs.length === 0) {
  console.warn("No source video dirs configured. Set SCENEBENCH_VIDEO_DIRS=/path/to/videos[:/another/path].");
}

function resolveSourceVideo(filename) {
  const aliases = {
    "Lvl1.mp4": ["Lvl1.mp4", "lvl1.mp4"],
    "vid.mp4": ["vid.mp4"],
    "Level_3.mp4": ["Level_3.mp4", "Lvl3.mp4", "level_3.mp4"],
  }[filename] ?? [filename];

  for (const dir of sourceDirs) {
    for (const alias of aliases) {
      const candidate = resolve(dir, alias);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

const raw = JSON.parse(readFileSync(scenesPath, "utf8"));
const scenes = raw.scenes ?? [];

if (!existsSync(scenesPath)) {
  throw new Error(`Scenes file not found: ${scenesPath}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
mkdirSync(dirname(manifestPath), { recursive: true });

const manifest = {
  generated_at: new Date().toISOString(),
  scale: "640:-2",
  scenes: [],
  skipped: [],
};

for (const scene of scenes) {
  const source = resolveSourceVideo(scene.video_filename);
  if (!source || !existsSync(source)) {
    manifest.skipped.push({
      id: scene.id,
      level: scene.level,
      video_filename: scene.video_filename,
      reason: "source video not found",
    });
    continue;
  }

  const duration = Math.max(0.1, Number(scene.end) - Number(scene.start));
  const levelDir = join(outputRoot, `level-${scene.level}`);
  mkdirSync(levelDir, { recursive: true });
  const filename = `${scene.id}.mp4`;
  const outPath = join(levelDir, filename);
  const publicPath = `/videos/scenes/level-${scene.level}/${filename}`;

  const args = [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    String(scene.start),
    "-t",
    String(duration),
    "-i",
    source,
    "-vf",
    "scale=640:-2",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-movflags",
    "+faststart",
    outPath,
  ];

  const result = spawnSync("ffmpeg", args, { stdio: "inherit" });
  if (result.status !== 0) {
    manifest.skipped.push({
      id: scene.id,
      level: scene.level,
      video_filename: scene.video_filename,
      reason: `ffmpeg failed for ${basename(outPath)}`,
    });
    continue;
  }

  manifest.scenes.push({
    ...scene,
    duration_sec: Number(duration.toFixed(3)),
    clip_src: publicPath,
  });
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifest.scenes.length} clips to ${outputRoot}`);
console.log(`Skipped ${manifest.skipped.length} scenes`);
console.log(`Manifest: ${manifestPath}`);
