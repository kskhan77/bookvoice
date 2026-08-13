// Popup UI: extracts text from the active tab (all frames, so ebook viewers
// rendered inside iframes work), sends it to the TTS engine, shows progress.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const fillEl = $("fill");
const pauseBtn = $("pause");
let paused = false;

// Runs inside the page/frame. Prefers the user's selection, otherwise pulls
// readable text from the main content area.
function extractText() {
  const sel = window.getSelection && window.getSelection().toString();
  if (sel && sel.trim().length > 20) {
    return { kind: "selection", text: sel.trim() };
  }
  const root =
    document.querySelector('main, article, [role="main"]') || document.body;
  if (!root) return { kind: "page", text: "" };
  const clone = root.cloneNode(true);
  clone
    .querySelectorAll(
      "script,style,noscript,nav,header,footer,aside,button,form,svg,figure figcaption"
    )
    .forEach((e) => e.remove());
  const text = (clone.innerText || clone.textContent || "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return { kind: "page", text };
}

async function getPageText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: extractText,
  });
  const values = results
    .filter((r) => r?.result)
    .map((r) => ({ ...r.result, frameId: r.frameId }));
  // A selection anywhere wins; otherwise read the frame with the most text.
  const best =
    values.find((v) => v.kind === "selection") ||
    values.sort((a, b) => b.text.length - a.text.length)[0];
  if (!best || best.text.length < 40) {
    throw new Error(
      "Couldn't find readable text. If this is a PDF, BookVoice can't read Chrome's PDF viewer yet — try the EPUB view."
    );
  }
  // Set up sentence/word highlighting inside the frame we'll be reading.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [best.frameId] },
      files: ["highlighter.js"],
    });
  } catch (e) {
    console.warn("Highlighter injection failed (reading continues):", e);
  }
  return { text: best.text, tabId: tab.id, frameId: best.frameId };
}

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
}

function render(st) {
  if (!st) return;
  const dev =
    st.device === "webgpu" ? " · GPU" : st.device === "wasm" ? " · CPU" : "";
  switch (st.state) {
    case "idle":
      statusEl.textContent = "Ready. Select text or just hit Read page." + dev;
      fillEl.style.width = "0";
      break;
    case "loading":
      statusEl.textContent =
        (st.detail || "Loading model") +
        (st.progress != null ? ` — ${st.progress}%` : "…");
      if (st.progress != null) fillEl.style.width = st.progress + "%";
      break;
    case "ready":
      statusEl.textContent = "Voice model ready." + dev;
      break;
    case "playing":
    case "paused":
      paused = st.state === "paused";
      pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
      statusEl.textContent =
        (paused ? "Paused" : "Reading") +
        ` — part ${Math.min(st.current + 1, st.total)} of ${st.total}` +
        dev;
      fillEl.style.width = (st.current / st.total) * 100 + "%";
      break;
    case "done":
      statusEl.textContent = "Finished reading." + dev;
      fillEl.style.width = "100%";
      break;
    case "error":
      statusEl.textContent = "⚠ " + (st.error || "Something went wrong");
      break;
  }
}

$("speed").addEventListener("input", (e) => {
  $("speedVal").textContent = Number(e.target.value).toFixed(1) + "×";
});

$("read").addEventListener("click", async () => {
  try {
    statusEl.textContent = "Extracting text…";
    const { text, tabId, frameId } = await getPageText();
    const voice = $("voice").value;
    const speed = $("speed").value;
    chrome.storage.local.set({ voice, speed });
    statusEl.textContent = "Starting…";
    await send("start", { text, voice, speed, tabId, frameId });
  } catch (e) {
    statusEl.textContent = "⚠ " + (e.message || e);
  }
});

pauseBtn.addEventListener("click", () => send(paused ? "resume" : "pause"));
$("stop").addEventListener("click", () => send("stop"));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === "status-broadcast") render(msg.status);
});

(async () => {
  const saved = await chrome.storage.local.get(["voice", "speed"]);
  if (saved.voice) $("voice").value = saved.voice;
  if (saved.speed) {
    $("speed").value = saved.speed;
    $("speedVal").textContent = Number(saved.speed).toFixed(1) + "×";
  }
  render(await send("status"));
  // Warm up the model in the background so the first Read is fast.
  send("preload");
})();
