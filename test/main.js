import { KokoroTTS } from "kokoro-js";

const logEl = document.getElementById("log");
const log = (m) => {
  logEl.textContent += m + "\n";
  console.log("[test]", m);
};

const TEXT =
  "Hello! This is a test of the Kokoro voice engine running locally on your computer.";

async function run(device, dtype, voice) {
  log(`--- ${device} ${dtype} (crossOriginIsolated=${crossOriginIsolated}, cores=${navigator.hardwareConcurrency})`);
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX",
    {
      dtype,
      device,
      progress_callback: (p) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx") && p.total) {
          const pct = Math.round((p.loaded / p.total) * 100);
          if (pct % 25 === 0) log(`  download ${pct}%`);
        }
      },
    }
  );
  log("  model loaded");
  for (let i = 1; i <= 2; i++) {
    const t0 = performance.now();
    const audio = await tts.generate(TEXT, { voice });
    const secs = audio.audio.length / audio.sampling_rate;
    let sum = 0;
    for (let j = 0; j < audio.audio.length; j++) sum += audio.audio[j] ** 2;
    const rms = Math.sqrt(sum / audio.audio.length);
    const genMs = Math.round(performance.now() - t0);
    log(
      `  gen#${i}: ${secs.toFixed(1)}s audio in ${genMs}ms (RTF ${(secs / (genMs / 1000)).toFixed(2)}x) RMS=${rms.toFixed(4)}`
    );
    if (i === 2) {
      const ctx = new AudioContext({ sampleRate: audio.sampling_rate });
      await ctx.resume();
      const buf = ctx.createBuffer(1, audio.audio.length, audio.sampling_rate);
      buf.copyToChannel(audio.audio, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    }
  }
  log(`  DONE ${device} ${dtype}`);
}

const hook = (id, device, dtype) => {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      await run(device, dtype, "af_heart");
    } catch (e) {
      log("ERROR: " + (e && (e.stack || e.message || e)));
    }
  });
};
hook("gpu32", "webgpu", "fp32");
hook("gpu16", "webgpu", "fp16");
hook("gpuq8", "webgpu", "q8");
hook("wasmq8", "wasm", "q8");

// Numeric quality check: Kokoro generation is deterministic, so a healthy
// quantized waveform should correlate highly with fp32. Corruption shows up
// as low correlation, clipping, or NaNs.
async function compareWith(dtype) {
  const gen = async (dt) => {
    const m = await KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: dt, device: "webgpu" }
    );
    const t0 = performance.now();
    const a = await m.generate(TEXT, { voice: "af_heart" });
    log(`  ${dt} gen in ${Math.round(performance.now() - t0)}ms (cold)`);
    const t1 = performance.now();
    const b = await m.generate(TEXT, { voice: "af_heart" });
    log(`  ${dt} gen in ${Math.round(performance.now() - t1)}ms (warm)`);
    return b.audio;
  };
  log(`--- comparing fp32 vs ${dtype} output`);
  const ref = await gen("fp32");
  const alt = await gen(dtype);
  const n = Math.min(ref.length, alt.length);
  let dot = 0, sr = 0, sa = 0, nan = 0, maxA = 0;
  for (let i = 0; i < n; i++) {
    const x = ref[i], y = alt[i];
    if (Number.isNaN(y)) nan++;
    else {
      dot += x * y; sr += x * x; sa += y * y;
      if (Math.abs(y) > maxA) maxA = Math.abs(y);
    }
  }
  const corr = dot / Math.sqrt(sr * sa);
  log(`  lengths ${ref.length} vs ${alt.length}, corr=${corr.toFixed(4)}, NaNs=${nan}, maxAbs=${maxA.toFixed(3)}`);
  log(corr > 0.9 ? `  VERDICT: ${dtype} output is healthy` : `  VERDICT: ${dtype} output is CORRUPTED`);
}
document.getElementById("compare").addEventListener("click", () =>
  compareWith("fp16").catch((e) => log("ERROR: " + (e.stack || e)))
);
document.getElementById("compareq4").addEventListener("click", () =>
  compareWith("q4").catch((e) => log("ERROR: " + (e.stack || e)))
);
