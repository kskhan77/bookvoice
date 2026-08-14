// BookVoice device-check page. Instant hardware probes plus an optional real
// benchmark using the actual TTS engine in the offscreen document.

const $ = (id) => document.getElementById(id);

let gpuState = "none"; // "hardware" | "software" | "none"

async function instantChecks() {
  // GPU
  let gpuText = "Not available";
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (a) {
      const info = a.info || {};
      const soft =
        a.isFallbackAdapter ||
        /swiftshader|llvmpipe|software/i.test(
          (info.vendor || "") + " " + (info.architecture || "")
        );
      gpuState = soft ? "software" : "hardware";
      gpuText = soft
        ? "Software only (slow)"
        : `Yes — ${info.vendor || "GPU"} ${info.architecture || ""}`.trim();
    }
  } catch {}
  $("cGpu").textContent = gpuText;

  const cores = navigator.hardwareConcurrency || 0;
  $("cCores").textContent = cores || "Unknown";

  const mem = navigator.deviceMemory;
  $("cMem").textContent = mem ? `${mem} GB${mem >= 8 ? "+" : ""}` : "Unknown";

  $("cIso").textContent = crossOriginIsolated ? "Enabled" : "Unavailable";

  const v = $("verdict");
  if (gpuState === "hardware") {
    v.className = "good";
    v.innerHTML =
      "✅ Looks great — your GPU can generate the voice faster than it plays." +
      '<span class="small">Run the full test below to confirm with real numbers.</span>';
  } else if (cores >= 8 && crossOriginIsolated) {
    v.className = "ok";
    v.innerHTML =
      "🟡 Should work — no usable GPU, but your CPU can carry it. Expect short pauses on long text." +
      '<span class="small">Run the full test below to measure it for real.</span>';
  } else {
    v.className = "bad";
    v.innerHTML =
      "🔴 This device may be too slow for smooth live reading." +
      '<span class="small">You can still try the full test — and cloud reading mode is planned for devices like this one.</span>';
  }
}

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
}

const benchBtn = $("bench");
const result = $("benchResult");

// Live progress from the engine while the model downloads/loads.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "status-broadcast") return;
  const st = msg.status || {};
  if (!benchRunning) return;
  if (st.state === "loading") {
    result.style.display = "block";
    result.textContent =
      (st.detail || "Loading…") +
      (st.progress != null ? ` — ${st.progress}%` : "");
  }
});

let benchRunning = false;

benchBtn.addEventListener("click", async () => {
  benchRunning = true;
  benchBtn.disabled = true;
  result.style.display = "block";
  result.textContent = "Starting engine…";
  try {
    // Ensure the model is loaded (shows download progress via broadcasts),
    // then measure two real generations.
    await send("preload");
    const r = await send("benchmark");
    if (!r?.ok) throw new Error(r?.error || "Benchmark failed");
    const rtf = r.warmSecs / (r.warmMs / 1000);
    const device = r.device === "webgpu" ? "GPU" : "CPU";
    let verdict;
    if (rtf >= 1.15) {
      verdict = "✅ Smooth continuous reading — you're all set.";
    } else if (rtf >= 0.7) {
      verdict =
        "🟡 Workable — reading will mostly keep up, with occasional short pauses.";
    } else {
      verdict =
        "🔴 Too slow for live reading on this device. Cloud reading mode (planned) would solve this.";
    }
    result.textContent =
      `Engine: ${device}\n` +
      `First sentence (includes one-time warm-up): ${(r.coldMs / 1000).toFixed(1)}s\n` +
      `Steady speed: ${r.warmSecs.toFixed(1)}s of audio in ${(r.warmMs / 1000).toFixed(1)}s ` +
      `(${rtf.toFixed(2)}× real-time)\n\n${verdict}`;
  } catch (e) {
    result.textContent = "⚠ " + (e.message || e);
  } finally {
    benchRunning = false;
    benchBtn.disabled = false;
    benchBtn.textContent = "🎤 Run the voice test again";
  }
});

instantChecks();
