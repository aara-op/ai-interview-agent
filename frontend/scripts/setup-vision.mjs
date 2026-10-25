#!/usr/bin/env node
/**
 * Vendor the MediaPipe WASM runtime, the face-landmarker model and the Human
 * face-recognition models into `public/` so the demo works without internet.
 *
 *   npm run setup:vision
 *
 * The app already falls back to the CDN when these files are absent.
 */
import { cp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const publicDir = path.join(root, "public");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(path.join(publicDir, "mp"), { recursive: true });
  await mkdir(path.join(publicDir, "models"), { recursive: true });
  await mkdir(path.join(publicDir, "human", "models"), { recursive: true });

  const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  if (existsSync(wasmSrc)) {
    await cp(wasmSrc, path.join(publicDir, "mp", "wasm"), { recursive: true });
    console.log("✓ WASM runtime copied to public/mp/wasm");
  } else {
    console.warn("! @mediapipe/tasks-vision not installed; run npm install first");
  }

  const modelDest = path.join(publicDir, "models", "face_landmarker.task");
  if (await exists(modelDest)) {
    console.log("✓ face model already present");
  } else {
    console.log("↓ downloading face_landmarker.task ...");
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`model download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(modelDest, buf);
    console.log(`✓ model saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  // Human face-recognition models (detector + landmarks + embedding) ship
  // inside the npm package — copy the subset identity checks need.
  const humanSrc = path.join(root, "node_modules", "@vladmandic", "human", "models");
  const humanModels = ["blazeface", "facemesh", "faceres", "centernet"];
  if (existsSync(humanSrc)) {
    for (const name of humanModels) {
      for (const ext of ["bin", "json"]) {
        const src = path.join(humanSrc, `${name}.${ext}`);
        const dest = path.join(publicDir, "human", "models", `${name}.${ext}`);
        if (existsSync(src) && !(await exists(dest))) await cp(src, dest);
      }
    }
    const extraSrc = path.join(humanSrc, "models.json");
    const extraDest = path.join(publicDir, "human", "models", "models.json");
    if (existsSync(extraSrc) && !(await exists(extraDest))) await cp(extraSrc, extraDest);
    console.log("✓ Human identity models copied to public/human/models");
  } else {
    console.warn("! @vladmandic/human not installed — identity checks will be unavailable");
  }

  void readFile;
}

main().catch((err) => {
  console.error("setup:vision failed:", err.message);
  console.error("The app will fall back to the CDN at runtime.");
  process.exitCode = 1;
});
