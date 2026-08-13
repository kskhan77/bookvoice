// BookVoice TTS engine. Runs inside the extension's offscreen document.
// Loads Kokoro-82M via kokoro-js (WebGPU when available, WASM otherwise),
// generates audio sentence-chunk by sentence-chunk, and plays it through
// an AudioContext, generating a few chunks ahead of playback.

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

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
  idleTimer = setTimeout(() => {
    if (!session && keepAlive) {
      try {
        keepAlive.src.stop();
        keepAlive.ctx.close();
      } catch {}
      keepAlive = null; // Chrome may now close this document; that's fine
    }
  }, 60_000);
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
let ctx = null;
let session = null; // current reading session

function broadcast(status) {
  chrome.runtime
    .sendMessage({ target: "status-broadcast", status })
    .catch(() => {});
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
    const hasWebGPU = !!navigator.gpu;
    try {
      if (!hasWebGPU) throw new Error("WebGPU not available");
      await ensureModelCached("onnx/model.onnx"); // fp32
      broadcast({ state: "loading", detail: "Loading model on GPU" });
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "fp32",
        device: "webgpu",
        progress_callback,
      });
      ttsDevice = "webgpu";
    } catch (e) {
      console.warn("WebGPU load failed, falling back to WASM:", e);
      await ensureModelCached("onnx/model_quantized.onnx"); // q8
      broadcast({ state: "loading", detail: "Loading model on CPU" });
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback,
      });
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

// Split text into sentence-boundary chunks small enough for Kokoro's context.
function splitIntoChunks(text, maxLen = 300) {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [
    clean,
  ];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxLen) {
      chunks.push(cur.trim());
      cur = "";
    }
    // A single overlong sentence gets hard-split on commas/spaces.
    if (s.length > maxLen) {
      if (cur) {
        chunks.push(cur.trim());
        cur = "";
      }
      let rest = s;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(",", maxLen);
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf(" ", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => /\p{L}|\p{N}/u.test(c));
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
      session = null;
      relayHighlight("stop");
      releaseKeepAliveSoon();
    }
    return;
  }
  s.playingNow = true;
  const buf = ctx.createBuffer(1, item.samples.length, item.rate);
  buf.copyToChannel(item.samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  s.currentSrc = src;
  relayHighlight("chunk", {
    text: s.chunks[item.index],
    duration: buf.duration,
    index: item.index,
  });
  src.onended = () => {
    if (s.stopped) return;
    s.played = item.index + 1;
    report();
    s.wake?.();
    playNext();
  };
  src.start();
}

async function produce(s) {
  for (let i = 0; i < s.chunks.length; i++) {
    if (s.stopped) return;
    // Throttle generation to stay only LOOKAHEAD chunks ahead of playback.
    while (!s.stopped && i - s.played >= LOOKAHEAD) {
      await new Promise((resolve) => (s.wake = resolve));
    }
    if (s.stopped) return;
    try {
      const audio = await tts.generate(s.chunks[i], {
        voice: s.voice,
        speed: s.speed,
      });
      if (s.stopped) return;
      s.queue.push({
        samples: audio.audio,
        rate: audio.sampling_rate,
        index: i,
      });
      if (!s.playingNow) playNext();
    } catch (e) {
      console.error("Generation failed for chunk", i, e);
    }
  }
  s.doneProducing = true;
}

async function startReading({ text, voice, speed }) {
  stopSession();
  startKeepAlive();
  await loadModel();
  if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
  if (ctx.state === "suspended") await ctx.resume();
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) {
    broadcast({ state: "error", error: "No readable text found on the page." });
    return;
  }
  session = {
    chunks,
    voice: voice || "af_heart",
    speed: Number(speed) || 1,
    queue: [],
    played: 0,
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
      case "stop":
        stopSession();
        return { ok: true };
      case "preload":
        loadModel().catch((e) =>
          broadcast({ state: "error", error: String(e) })
        );
        return { ok: true };
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
