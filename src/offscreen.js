// BookVoice TTS engine. Runs inside the extension's offscreen document.
// Loads Kokoro-82M via kokoro-js (WebGPU when available, WASM otherwise),
// generates audio sentence-chunk by sentence-chunk, and plays it through
// an AudioContext, generating a few chunks ahead of playback.

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";
import {
  buildChunks,
  castSummary,
  textHash,
  findStartChunk,
} from "./textpipe.js";

// Serve onnxruntime's .wasm/.mjs from inside the extension instead of a CDN
// (MV3 blocks remote code).
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const LOOKAHEAD = 3; // chunks generated ahead of playback

// Chrome closes an AUDIO_PLAYBACK offscreen document after ~30s without audio.
// That would kill the model download (minutes) and any paused session, so we
// loop inaudible audio while working and release it a minute after going idle.
let keepAlive = null;
let idleTimer = null;

function startKeepAlive() {
  clearTimeout(idleTimer);
  if (keepAlive) return;
  const kctx = new AudioContext();
  const buf = kctx.createBuffer(1, kctx.sampleRate, kctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 2e-4;
  const src = kctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = kctx.createGain();
  gain.gain.value = 0.001; // ~ -120 dB overall: inaudible
  src.connect(gain).connect(kctx.destination);
  src.start();
  if (kctx.state === "suspended") kctx.resume().catch(() => {});
  keepAlive = { ctx: kctx, src };
}

function releaseKeepAliveSoon() {
  clearTimeout(idleTimer);
  // 5 minutes: keeps the model warm between chapters/sections so the next
  // Read starts instantly, then lets Chrome reclaim the memory.
  idleTimer = setTimeout(() => {
    if (!session && keepAlive) {
      try {
        keepAlive.src.stop();
        keepAlive.ctx.close();
      } catch {}
      keepAlive = null; // Chrome may now close this document; that's fine
    }
  }, 300_000);
}

// ---- Resumable model download ----------------------------------------------
// transformers.js only caches COMPLETE files (cache "transformers-cache",
// keyed by the remote URL), so an interrupted download restarts from zero.
// We download the big .onnx ourselves in 16MB chunks persisted to IndexedDB,
// resume from the last saved byte after any failure, and hand the finished
// file to transformers.js's cache so it never downloads it again.

const HUB_URL = "https://huggingface.co/" + MODEL_ID + "/resolve/main/";
const CHUNK_SIZE = 16 * 1024 * 1024;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bookvoice-downloads", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function kvGet(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction("kv", "readonly").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function kvSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const r = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
function kvDelete(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}
async function clearDownload(db, url, chunkCount) {
  for (let i = 0; i < chunkCount; i++) await kvDelete(db, `${url}#${i}`);
  await kvDelete(db, `meta:${url}`);
}

function readWithTimeout(reader, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("network stalled"));
      reader.cancel().catch(() => {});
    }, ms);
    reader.read().then(
      (r) => (clearTimeout(t), resolve(r)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

async function ensureModelCached(relPath) {
  const url = HUB_URL + relPath;
  const cache = await caches.open("transformers-cache");
  if (await cache.match(url)) return; // already fully downloaded
  const db = await idbOpen();
  let meta = (await kvGet(db, `meta:${url}`)) || {
    bytes: 0,
    chunks: 0,
    total: null,
  };
  let attempt = 0;
  while (true) {
    try {
      const headers = {};
      if (meta.bytes > 0) headers["Range"] = `bytes=${meta.bytes}-`;
      const resp = await fetch(url, { headers, cache: "no-store" });
      if (meta.bytes > 0 && resp.status === 200) {
        // Server ignored the resume request; start over.
        await clearDownload(db, url, meta.chunks);
        meta = { bytes: 0, chunks: 0, total: null };
      } else if (!resp.ok && resp.status !== 206) {
        throw new Error("HTTP " + resp.status);
      }
      const range = resp.headers.get("content-range");
      if (range) {
        const total = parseInt(range.split("/")[1], 10);
        if (total) meta.total = total;
      } else if (resp.status === 200) {
        const len = parseInt(resp.headers.get("content-length") || "", 10);
        if (len) meta.total = len;
      }
      const reader = resp.body.getReader();
      let parts = [];
      let partBytes = 0;
      const flush = async () => {
        if (partBytes === 0) return;
        const merged = new Uint8Array(partBytes);
        let o = 0;
        for (const p of parts) {
          merged.set(p, o);
          o += p.byteLength;
        }
        await kvSet(db, `${url}#${meta.chunks}`, merged.buffer);
        meta = {
          ...meta,
          chunks: meta.chunks + 1,
          bytes: meta.bytes + partBytes,
        };
        await kvSet(db, `meta:${url}`, meta);
        parts = [];
        partBytes = 0;
      };
      while (true) {
        const { done, value } = await readWithTimeout(reader, 45_000);
        if (value && value.byteLength) {
          parts.push(value);
          partBytes += value.byteLength;
          attempt = 0; // progress resets the retry backoff
          if (partBytes >= CHUNK_SIZE) await flush();
          const soFar = meta.bytes + partBytes;
          broadcast({
            state: "loading",
            progress: meta.total
              ? Math.round((soFar / meta.total) * 100)
              : null,
            detail: meta.total
              ? "Downloading voice model (safe to interrupt — it resumes)"
              : `Downloading voice model — ${Math.round(soFar / 1048576)} MB so far`,
          });
        }
        if (done) break;
      }
      await flush();
      if (meta.total && meta.bytes < meta.total)
        throw new Error("connection closed early");
      break; // download complete
    } catch (e) {
      attempt++;
      if (attempt > 30) {
        db.close();
        throw e;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      broadcast({
        state: "loading",
        progress: meta.total
          ? Math.round((meta.bytes / meta.total) * 100)
          : null,
        detail: `Connection hiccup — resuming in ${Math.round(delay / 1000)}s (progress saved)`,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  broadcast({ state: "loading", detail: "Saving voice model" });
  const blobParts = [];
  for (let i = 0; i < meta.chunks; i++) {
    blobParts.push(new Blob([await kvGet(db, `${url}#${i}`)]));
  }
  const blob = new Blob(blobParts, { type: "application/octet-stream" });
  await cache.put(
    url,
    new Response(blob, {
      status: 200,
      headers: { "Content-Length": String(blob.size) },
    })
  );
  await clearDownload(db, url, meta.chunks);
  db.close();
}

let tts = null;
let ttsDevice = null;
let loadPromise = null;
let warmedUp = false;

// First generation after a model load compiles GPU shaders (~10s). Run a tiny
// generation during idle preload so the user's first Read starts fast — but
// never block or compete with a real reading session.
function resetEngine() {
  tts = null;
  loadPromise = null;
  warmedUp = false;
  ttsDevice = null;
}

async function warmup() {
  if (warmedUp || session) return;
  try {
    const t0 = performance.now();
    await tts.generate("Hi.", { voice: "af_heart" });
    const ms = performance.now() - t0;
    diag(`warmup gen ${Math.round(ms)}ms`);
    warmedUp = true;
    if (ttsDevice === "webgpu" && ms > 45_000) {
      // Real hardware does this in ~10s; minutes means a fake/broken GPU.
      diag("webgpu warmup too slow -> forcing CPU mode");
      localStorage.setItem("bv_forceWasm", "1");
      resetEngine();
      broadcast({
        state: "loading",
        detail: "GPU too slow for live reading — switching to CPU mode",
      });
      await loadModel();
      warmedUp = false;
      await warmup();
    }
  } catch (e) {
    diag("warmup failed: " + (e.message || e));
  }
}
let ctx = null;
let session = null; // current reading session

function broadcast(status) {
  chrome.runtime
    .sendMessage({ target: "status-broadcast", status })
    .catch(() => {});
}

// Rolling diagnostics log, viewable from the popup's Diagnostics panel.
const diagLog = [];
function diag(m) {
  const line = new Date().toISOString().slice(11, 19) + " " + m;
  diagLog.push(line);
  if (diagLog.length > 60) diagLog.shift();
  console.log("[bookvoice]", m);
}

async function gpuAdapterInfo() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return null;
    const i = a.info || {};
    return {
      vendor: i.vendor || "",
      arch: i.architecture || "",
      fallback: !!a.isFallbackAdapter,
    };
  } catch {
    return null;
  }
}

// Highlight events -> background -> content script in the frame being read.
function relayHighlight(event, data = {}) {
  chrome.runtime
    .sendMessage({ target: "bg", cmd: "hl", event, ...data })
    .catch(() => {});
}

function report(extra = {}) {
  if (!session) return;
  broadcast({
    state: session.paused ? "paused" : "playing",
    device: ttsDevice,
    current: session.played,
    total: session.chunks.length,
    snippet: session.snippet || "",
    preparing: !session.audioStarted,
    speakers: session.speakers || [],
    ...extra,
  });
}

async function loadModel() {
  if (tts) return tts;
  if (loadPromise) return loadPromise;
  startKeepAlive();
  loadPromise = (async () => {
    const progress_callback = (p) => {
      if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) {
        // Some servers omit content-length; fall back to a byte counter.
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : null;
        broadcast({
          state: "loading",
          progress: pct,
          detail:
            pct == null
              ? `Downloading voice model — ${Math.round(p.loaded / 1048576)} MB so far`
              : "Downloading voice model (one time only)",
        });
      }
    };
    // NOTE: offscreen documents cannot use chrome.storage - only runtime
    // messaging. Engine-internal flags use localStorage; anything the popup
    // or background needs goes through background messages.
    const forceWasm = localStorage.getItem("bv_forceWasm") === "1";
    try {
      if (forceWasm) throw new Error("CPU mode forced (GPU previously too slow)");
      if (!navigator.gpu) throw new Error("WebGPU not available");
      // Offscreen documents sometimes only get a SOFTWARE WebGPU adapter,
      // which reports as "GPU" but generates ~50x slower than real time.
      // Detect that and use the multi-threaded CPU path instead.
      const g = await gpuAdapterInfo();
      diag("gpu adapter: " + JSON.stringify(g));
      if (!g || g.fallback || /swiftshader|llvmpipe|software/i.test(g.vendor + " " + g.arch)) {
        throw new Error("No hardware WebGPU adapter in this context");
      }
      // fp32 only: fp16 produces corrupted audio (NaNs/garbage) on Intel
      // WebGPU drivers. With onnxruntime >= 1.26 (via transformers.js 4.x),
      // fp32 runs ~1.7x real-time on integrated GPUs - fast enough.
      await ensureModelCached("onnx/model.onnx");
      broadcast({ state: "loading", detail: "Loading model on GPU" });
      const t0 = performance.now();
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "fp32",
        device: "webgpu",
        progress_callback,
      });
      diag(`model loaded webgpu/fp32 in ${Math.round(performance.now() - t0)}ms`);
      ttsDevice = "webgpu";
    } catch (e) {
      diag("webgpu unavailable -> wasm: " + (e.message || e));
      await ensureModelCached("onnx/model_quantized.onnx"); // q8
      broadcast({ state: "loading", detail: "Loading model on CPU" });
      const t0 = performance.now();
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback,
      });
      diag(
        `model loaded wasm/q8 in ${Math.round(performance.now() - t0)}ms (isolated=${crossOriginIsolated}, cores=${navigator.hardwareConcurrency})`
      );
      ttsDevice = "wasm";
    }
    broadcast({ state: "ready", device: ttsDevice });
    if (!session) releaseKeepAliveSoon();
    return tts;
  })();
  try {
    return await loadPromise;
  } catch (e) {
    loadPromise = null;
    throw e;
  }
}


function stopSession() {
  if (!session) return;
  session.stopped = true;
  try {
    session.currentSrc?.stop();
  } catch {}
  session = null;
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  broadcast({ state: "idle", device: ttsDevice });
  relayHighlight("stop");
  releaseKeepAliveSoon();
}

function playNext() {
  const s = session;
  if (!s || s.stopped) return;
  const item = s.queue.shift();
  if (!item) {
    s.playingNow = false;
    if (s.doneProducing) {
      broadcast({ state: "done", device: ttsDevice, total: s.chunks.length });
      // Finished this page: clear the saved position (via background).
      if (s.url) {
        chrome.runtime
          .sendMessage({ target: "bg", cmd: "clear-pos", url: s.url })
          .catch(() => {});
      }
      session = null;
      relayHighlight("stop");
      releaseKeepAliveSoon();
    }
    return;
  }
  s.playingNow = true;
  s.audioStarted = true;
  const buf = ctx.createBuffer(1, item.samples.length, item.rate);
  buf.copyToChannel(item.samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  s.currentSrc = src;
  s.snippet = s.chunks[item.index].t.slice(0, 90);
  relayHighlight("chunk", {
    text: s.chunks[item.index].t,
    duration: buf.duration,
    index: item.index,
  });
  // Persist the reading position so the popup can offer "Resume".
  // (chrome.storage is unavailable here - the background worker writes it.)
  if (s.url) {
    chrome.runtime
      .sendMessage({
        target: "bg",
        cmd: "save-pos",
        url: s.url,
        value: {
          index: item.index,
          total: s.chunks.length,
          hash: s.hash,
          title: s.title || "",
          savedAt: Date.now(),
        },
      })
      .catch(() => {});
  }
  src.onended = () => {
    if (s.stopped) return;
    s.played = item.index + 1;
    report();
    s.wake?.();
    playNext();
  };
  src.start();
  diag(`play#${item.index} started (${buf.duration.toFixed(1)}s)`);
  report(); // audio is now audible; clears the "preparing" state in the UI
}

async function produce(s) {
  for (let i = s.startAt; i < s.chunks.length; i++) {
    if (s.stopped) return;
    // Throttle generation to stay only LOOKAHEAD chunks ahead of playback.
    while (!s.stopped && i - s.played >= LOOKAHEAD) {
      await new Promise((resolve) => (s.wake = resolve));
    }
    if (s.stopped) return;
    try {
      const t0 = performance.now();
      const audio = await tts.generate(s.chunks[i].t, {
        voice: s.chunks[i].v || s.voice,
        speed: s.speed,
      });
      const genMs = performance.now() - t0;
      diag(
        `gen#${i} ${Math.round(genMs)}ms for ${(audio.audio.length / audio.sampling_rate).toFixed(1)}s audio [${ttsDevice}${s.chunks[i].speaker ? " · " + s.chunks[i].speaker : ""}]`
      );
      if (s.stopped) return;
      if (ttsDevice === "webgpu" && genMs > 45_000) {
        // GPU path is effectively broken here; switch to CPU and continue
        // this same reading session from the current chunk.
        diag("webgpu generation too slow -> switching to CPU and restarting");
        localStorage.setItem("bv_forceWasm", "1");
        const params = {
          text: s.textFull,
          voice: s.voice,
          speed: s.speed,
          url: s.url,
          title: s.title,
          resumeIndex: i,
          multiVoice: s.multiVoice,
          cast: s.cast,
        };
        resetEngine();
        broadcast({
          state: "loading",
          detail: "GPU too slow for live reading — switching to CPU mode",
        });
        startReading(params);
        return;
      }
      s.genErrors = 0;
      s.queue.push({
        samples: audio.audio,
        rate: audio.sampling_rate,
        index: i,
      });
      if (!s.playingNow) playNext();
    } catch (e) {
      console.error("Generation failed for chunk", i, e);
      s.genErrors = (s.genErrors || 0) + 1;
      if (s.genErrors >= 3) {
        // Persistent failure: stop and tell the user instead of sitting silent.
        broadcast({
          state: "error",
          error: "Voice generation failed: " + (e.message || e),
        });
        stopSession();
        return;
      }
    }
  }
  s.doneProducing = true;
}

async function startReading({
  text,
  voice,
  speed,
  url,
  title,
  resumeIndex,
  startText,
  multiVoice,
  cast,
}) {
  stopSession();
  startKeepAlive();
  await loadModel();
  if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
  if (ctx.state === "suspended") await ctx.resume();
  const chunks = buildChunks(text, {
    multiVoice: multiVoice !== false,
    narrator: voice || "af_heart",
    cast: cast || {},
  });
  if (chunks.length === 0) {
    broadcast({ state: "error", error: "No readable text found on the page." });
    return;
  }
  // "Read from here": find the chunk containing the right-clicked text.
  let fromText = null;
  if (startText && resumeIndex == null) {
    // Start-from-here must be precise: clear any saved position for this
    // page so stored state can never influence where reading begins.
    if (url) {
      chrome.runtime
        .sendMessage({ target: "bg", cmd: "clear-pos", url })
        .catch(() => {});
    }
    const r = findStartChunk(chunks, startText);
    fromText = r.index;
    diag(
      `read-from-here: "${(r.needle || "").slice(0, 24)}…" ${r.index != null ? "found at chunk " + r.index : "NOT FOUND"}`
    );
    if (fromText == null) {
      // Never silently read from the top when the user picked a spot -
      // being wrong loudly beats being wrong quietly.
      broadcast({
        state: "error",
        error:
          "Couldn't locate that spot in the page text. Try clicking a longer paragraph, or use Read page.",
      });
      return;
    }
  }
  const startAt = Math.min(
    Math.max(0, fromText ?? resumeIndex ?? 0),
    chunks.length - 1
  );
  // Shorten the first chunk to be spoken so audio starts sooner.
  const first = chunks[startAt];
  if (first.t.length > 160) {
    let cut = first.t.lastIndexOf(" ", 120);
    if (cut < 60) cut = 120;
    chunks.splice(
      startAt,
      1,
      { ...first, t: first.t.slice(0, cut).trim() },
      { ...first, t: first.t.slice(cut).trim() }
    );
  }
  const speakers = castSummary(chunks);
  diag(
    `session start: ${chunks.length} chunks, from #${startAt}, cast: ${speakers.map((s) => s.name).join(", ") || "none"}`
  );
  session = {
    chunks,
    textFull: text,
    voice: voice || "af_heart",
    speed: Number(speed) || 1,
    multiVoice: multiVoice !== false,
    cast: cast || {},
    speakers,
    url: url || null,
    title: title || "",
    hash: textHash(text),
    startAt,
    snippet: chunks[startAt].t.slice(0, 90), // preview before audio starts
    queue: [],
    played: startAt,
    playingNow: false,
    doneProducing: false,
    stopped: false,
    paused: false,
    currentSrc: null,
    wake: null,
  };
  relayHighlight("session-start");
  report({ state: "playing" });
  produce(session);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  (async () => {
    switch (msg.cmd) {
      case "start":
        await startReading(msg);
        return { ok: true };
      case "pause":
        if (session && ctx) {
          session.paused = true;
          await ctx.suspend();
          relayHighlight("pause");
          report();
        }
        return { ok: true };
      case "resume":
        if (session && ctx) {
          session.paused = false;
          await ctx.resume();
          relayHighlight("resume");
          report();
        }
        return { ok: true };
      case "skip":
        // Jump to the next sentence: stopping the source fires onended,
        // which advances playback naturally.
        if (session && session.currentSrc && !session.paused) {
          try {
            session.currentSrc.stop();
          } catch {}
        }
        return { ok: true };
      case "stop":
        stopSession();
        return { ok: true };
      case "preload":
        loadModel()
          .then(() => warmup())
          .catch((e) => broadcast({ state: "error", error: String(e) }));
        return { ok: true };
      case "get-diag":
        return { ok: true, log: diagLog };
      case "benchmark": {
        // Real generation timings for the device-check page. Assumes the
        // model is already loaded (the page preloads first for progress UI).
        await loadModel();
        const t0 = performance.now();
        const a1 = await tts.generate(
          "This is a quick test of the BookVoice reading engine on your device.",
          { voice: "af_heart" }
        );
        const coldMs = performance.now() - t0;
        const t1 = performance.now();
        const a2 = await tts.generate(
          "Here is a second sentence to measure the true steady reading speed.",
          { voice: "af_heart" }
        );
        const warmMs = performance.now() - t1;
        diag(
          `benchmark: cold ${Math.round(coldMs)}ms, warm ${Math.round(warmMs)}ms [${ttsDevice}]`
        );
        return {
          ok: true,
          device: ttsDevice,
          coldMs: Math.round(coldMs),
          coldSecs: a1.audio.length / a1.sampling_rate,
          warmMs: Math.round(warmMs),
          warmSecs: a2.audio.length / a2.sampling_rate,
        };
      }
      default:
        return { ok: false, error: "unknown command" };
    }
  })().then(sendResponse, (e) => {
    broadcast({ state: "error", error: String(e) });
    sendResponse({ ok: false, error: String(e) });
  });
  return true;
});

broadcast({ state: "idle" });
