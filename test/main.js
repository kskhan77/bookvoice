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
hook("wasmq8", "wasm", "q8");
