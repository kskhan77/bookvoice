// Bundles the TTS engine (kokoro-js + transformers.js) for the offscreen
// document and copies onnxruntime's wasm runtime files into the extension.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const outDir = "extension/dist";
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: ["src/offscreen.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome124",
  minify: true,
  outfile: join(outDir, "offscreen.js"),
  logLevel: "info",
});

// Readability article extractor, injected into page frames before extraction.
await esbuild.build({
  entryPoints: ["src/readability-inject.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome124",
  minify: true,
  outfile: "extension/readability.js",
  logLevel: "info",
});

// onnxruntime-web loads these at runtime; MV3 forbids fetching them from a CDN.
const ortDist = "node_modules/onnxruntime-web/dist";
for (const f of readdirSync(ortDist)) {
  if (/^ort-.*\.(wasm|mjs)$/.test(f)) {
    cpSync(join(ortDist, f), join(outDir, f));
    console.log("copied", f);
  }
}

// pdf.js for the BookVoice PDF reader page (self-contained ESM builds).
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  cpSync(join("node_modules/pdfjs-dist/build", f), join(outDir, f));
  console.log("copied", f);
}
console.log("Build complete -> extension/");
