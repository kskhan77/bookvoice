// Service worker: extracts page text, drives the offscreen TTS engine,
// routes highlight/floater events, and manages bookmarks + resume positions.

let lastStatus = { state: "idle" };

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  // Note: AUDIO_PLAYBACK alone gives the document a 30s no-audio lifetime,
  // which would kill the multi-minute model download. Declaring WORKERS as
  // well (the ML inference runtime) removes that timeout.
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK", "WORKERS"],
    justification:
      "Runs the local text-to-speech model and plays the generated audio",
  });
}

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

// Must match the hash used by the offscreen engine when saving positions.
function textHash(t) {
  return t.length + ":" + t.slice(0, 50) + ":" + t.slice(-50);
}

// Extract text from a tab and start reading it. `resume` continues from the
// saved position if the page text still matches; `startIndex` (bookmarks)
// forces a specific chunk.
async function readTab(tabId, { voice, speed, resume, startIndex } = {}) {
  const tab = await chrome.tabs.get(tabId);

  // Ebook viewers render asynchronously; retry extraction a few times.
  let best = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: extractText,
    });
    const values = results
      .filter((r) => r?.result)
      .map((r) => ({ ...r.result, frameId: r.frameId }));
    best =
      values.find((v) => v.kind === "selection") ||
      values.sort((a, b) => b.text.length - a.text.length)[0];
    if (best && best.text.length >= 40) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!best || best.text.length < 40) {
    throw new Error(
      "Couldn't find readable text. If this is a PDF, BookVoice can't read Chrome's PDF viewer yet — try the EPUB view."
    );
  }

  let resumeIndex = 0;
  const hash = textHash(best.text);
  if (typeof startIndex === "number") {
    resumeIndex = startIndex;
  } else if (resume) {
    const posKey = "pos:" + tab.url;
    const saved = (await chrome.storage.local.get(posKey))[posKey];
    if (saved && saved.hash === hash) resumeIndex = saved.index;
  }

  // Set up in-page UI: highlighter in the frame being read, floating
  // play/pause control in the top frame.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [best.frameId] },
      files: ["highlighter.js"],
    });
  } catch (e) {
    console.warn("Highlighter injection failed:", e);
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["floater.js"],
    });
  } catch (e) {
    console.warn("Floater injection failed:", e);
  }

  await chrome.storage.session.set({
    hlTarget: { tabId, frameId: best.frameId },
  });
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: "offscreen",
    cmd: "start",
    text: best.text,
    voice,
    speed,
    url: tab.url,
    title: tab.title || tab.url,
    resumeIndex,
  });
  return { ok: true, resumeIndex };
}

async function addBookmark() {
  const { hlTarget } = await chrome.storage.session.get("hlTarget");
  if (!hlTarget || !["playing", "paused"].includes(lastStatus.state)) {
    throw new Error("Start reading first, then bookmark the spot.");
  }
  const tab = await chrome.tabs.get(hlTarget.tabId);
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  bookmarks.unshift({
    id: Date.now().toString(36),
    url: tab.url,
    title: tab.title || tab.url,
    index: lastStatus.current || 0,
    total: lastStatus.total || 0,
    snippet: lastStatus.snippet || "",
    createdAt: Date.now(),
  });
  await chrome.storage.local.set({ bookmarks: bookmarks.slice(0, 50) });
  return { ok: true };
}

async function openBookmark(id) {
  const { bookmarks = [] } = await chrome.storage.local.get("bookmarks");
  const bm = bookmarks.find((b) => b.id === id);
  if (!bm) throw new Error("Bookmark not found");
  const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url === bm.url) {
    return readTab(tab.id, { voice, speed, startIndex: bm.index });
  }
  // Navigate first; the onUpdated listener below starts reading when loaded.
  await chrome.storage.session.set({
    pendingRead: { tabId: tab.id, index: bm.index },
  });
  await chrome.tabs.update(tab.id, { url: bm.url });
  return { ok: true, navigating: true };
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const { pendingRead } = await chrome.storage.session.get("pendingRead");
  if (!pendingRead || pendingRead.tabId !== tabId) return;
  await chrome.storage.session.remove("pendingRead");
  const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);
  // Give SPA ebook viewers a moment to render before extracting.
  setTimeout(() => {
    readTab(tabId, { voice, speed, startIndex: pendingRead.index }).catch(
      (e) => console.warn("Bookmark auto-read failed:", e)
    );
  }, 2000);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "status-broadcast") {
    lastStatus = msg.status;
    // Keep the floating control in the top frame up to date.
    chrome.storage.session.get("hlTarget").then(({ hlTarget }) => {
      if (!hlTarget) return;
      chrome.tabs
        .sendMessage(
          hlTarget.tabId,
          { target: "bookvoice-float", status: msg.status },
          { frameId: 0 }
        )
        .catch(() => {});
    });
    return;
  }
  if (msg?.target !== "bg") return;

  switch (msg.cmd) {
    case "status":
      sendResponse(lastStatus);
      return; // synchronous
    case "save-pos":
      // Written on behalf of the offscreen engine (no chrome.storage there).
      if (msg.url) {
        chrome.storage.local.set({ ["pos:" + msg.url]: msg.value });
      }
      sendResponse({ ok: true });
      return;
    case "clear-pos":
      if (msg.url) chrome.storage.local.remove("pos:" + msg.url);
      sendResponse({ ok: true });
      return;
    case "hl":
      // Highlight event from the TTS engine -> frame being read.
      chrome.storage.session.get("hlTarget").then(({ hlTarget }) => {
        if (!hlTarget) return;
        chrome.tabs
          .sendMessage(
            hlTarget.tabId,
            { ...msg, target: "bookvoice-hl" },
            { frameId: hlTarget.frameId }
          )
          .catch(() => {});
      });
      sendResponse({ ok: true });
      return;
    case "read-active-tab":
      (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) throw new Error("No active tab");
        return readTab(tab.id, msg);
      })().then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e.message || String(e) })
      );
      return true;
    case "read-bookmark":
      openBookmark(msg.id).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e.message || String(e) })
      );
      return true;
    case "bookmark-current":
      addBookmark().then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e.message || String(e) })
      );
      return true;
    default:
      // pause / resume / stop / preload -> forward to the TTS engine.
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ ...msg, target: "offscreen" }))
        .then(
          (r) => sendResponse(r ?? { ok: true }),
          (e) => sendResponse({ ok: false, error: String(e) })
        );
      return true;
  }
});
