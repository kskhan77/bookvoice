// Popup UI: start/resume reading, bookmarks, progress. Text extraction and
// reading orchestration live in background.js (so bookmarks can auto-start
// after navigation); the popup just sends commands.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const fillEl = $("fill");
const pauseBtn = $("pause");
let paused = false;

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ target: "bg", cmd, ...extra });
}

function prefs() {
  const voice = $("voice").value;
  const speed = $("speed").value;
  chrome.storage.local.set({ voice, speed });
  return { voice, speed };
}

// Cast panel: detected speakers with per-character voice pickers.
let lastCastKey = "";
function renderCast(speakers) {
  const key = JSON.stringify(speakers || []);
  if (key === lastCastKey) return; // don't rebuild while a dropdown is open
  lastCastKey = key;
  const section = $("castSection");
  const list = $("castList");
  list.textContent = "";
  if (!speakers || speakers.length === 0) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  const voiceOptions = [...$("voice").options].map((o) => ({
    value: o.value,
    label: o.textContent,
  }));
  for (const sp of speakers) {
    const row = document.createElement("div");
    row.className = "castRow";
    const name = document.createElement("div");
    name.className = "castName";
    name.textContent = sp.name;
    const sel = document.createElement("select");
    for (const v of voiceOptions) {
      const o = document.createElement("option");
      o.value = v.value;
      o.textContent = v.label;
      sel.appendChild(o);
    }
    sel.value = sp.voice;
    sel.addEventListener("change", async () => {
      const { castVoices = {} } = await chrome.storage.local.get("castVoices");
      castVoices[sp.name] = sel.value;
      chrome.storage.local.set({ castVoices });
    });
    row.append(name, sel);
    list.appendChild(row);
  }
}

function render(st) {
  if (!st) return;
  const dev =
    st.device === "webgpu" ? " · GPU" : st.device === "wasm" ? " · CPU" : "";
  const reading = st.state === "playing" || st.state === "paused";
  $("bmRow").style.display = reading ? "" : "none";
  if (reading) renderCast(st.speakers);
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
      statusEl.textContent = st.preparing
        ? "Generating audio… will start with: “" +
          (st.snippet || "…") +
          "”"
        : (paused ? "Paused" : "Reading") +
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

async function startReading(extra = {}) {
  statusEl.textContent = "Starting…";
  const r = await send("read-active-tab", { ...prefs(), ...extra });
  if (r && r.ok === false) statusEl.textContent = "⚠ " + r.error;
}

$("speed").addEventListener("input", (e) => {
  $("speedVal").textContent = Number(e.target.value).toFixed(1) + "×";
});
$("zoomChk").addEventListener("change", (e) => {
  chrome.storage.local.set({ zoomSent: e.target.checked });
});
$("mvChk").addEventListener("change", (e) => {
  chrome.storage.local.set({ multiVoice: e.target.checked });
});
$("read").addEventListener("click", () => startReading());
$("resume").addEventListener("click", () => startReading({ resume: true }));
pauseBtn.addEventListener("click", () => send(paused ? "resume" : "pause"));
$("stop").addEventListener("click", () => send("stop"));

$("bookmark").addEventListener("click", async () => {
  const r = await send("bookmark-current");
  if (r?.ok) {
    $("bookmark").textContent = "✓ Saved";
    setTimeout(() => ($("bookmark").textContent = "🔖 Bookmark this spot"), 1200);
    loadBookmarks();
  } else {
    statusEl.textContent = "⚠ " + (r?.error || "Could not bookmark");
  }
});

async function loadBookmarks() {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  const list = $("bmList");
  list.textContent = "";
  $("bmSection").style.display = bookmarks.length ? "" : "none";
  for (const b of bookmarks) {
    const item = document.createElement("div");
    item.className = "bm";
    const info = document.createElement("div");
    info.className = "bmInfo";
    const title = document.createElement("div");
    title.className = "bmTitle";
    title.textContent = b.title;
    const meta = document.createElement("div");
    meta.className = "bmMeta";
    meta.textContent =
      `part ${b.index + 1}${b.total ? " of " + b.total : ""}` +
      (b.snippet ? " — " + b.snippet : "");
    info.append(title, meta);
    const del = document.createElement("button");
    del.className = "bmDel";
    del.textContent = "✕";
    del.title = "Delete bookmark";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
      await chrome.storage.local.set({
        bookmarks: bookmarks.filter((x) => x.id !== b.id),
      });
      loadBookmarks();
    });
    item.append(info, del);
    item.addEventListener("click", async () => {
      statusEl.textContent = "Opening bookmark…";
      const r = await send("read-bookmark", { id: b.id });
      if (r && r.ok === false) statusEl.textContent = "⚠ " + r.error;
    });
    list.appendChild(item);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === "status-broadcast") render(msg.status);
});

async function refreshDiag() {
  try {
    const r = await send("get-diag");
    if (r?.log) $("diag").textContent = r.log.join("\n") || "(no activity yet)";
  } catch {}
}
setInterval(refreshDiag, 2000);
refreshDiag();

(async () => {
  const saved = await chrome.storage.local.get([
    "voice",
    "speed",
    "zoomSent",
    "multiVoice",
  ]);
  if (saved.voice) $("voice").value = saved.voice;
  if (saved.speed) {
    $("speed").value = saved.speed;
    $("speedVal").textContent = Number(saved.speed).toFixed(1) + "×";
  }
  if (saved.zoomSent === false) $("zoomChk").checked = false;
  if (saved.multiVoice === false) $("mvChk").checked = false;
  render(await send("status"));
  // Warm up the model in the background so the first Read is fast.
  send("preload");
  loadBookmarks();
  // Offer "Resume" if this page has a saved position.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // PDFs: Chrome's built-in viewer is closed to extensions, so offer our
  // own pdf.js-based reader where the full pipeline works.
  if (
    tab?.url &&
    /\.pdf($|[?#])/i.test(tab.url) &&
    !tab.url.startsWith(chrome.runtime.getURL(""))
  ) {
    $("pdfRow").style.display = "";
    $("pdfBtn").addEventListener("click", () => {
      chrome.tabs.update(tab.id, {
        url:
          chrome.runtime.getURL("pdfreader.html") +
          "?src=" +
          encodeURIComponent(tab.url),
      });
      window.close();
    });
  }
  if (tab?.url) {
    const key = "pos:" + tab.url;
    const pos = (await chrome.storage.local.get(key))[key];
    if (pos && pos.index > 0) {
      $("resumeRow").style.display = "";
      $("resume").textContent =
        `⏯ Resume part ${pos.index + 1}${pos.total ? " of " + pos.total : ""}`;
    }
  }
})();
