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

// Runs inside the page/frame. Priority: user selection > Readability article
// (Firefox Reader Mode extraction - drops ads, nav, "related" boxes) >
// heuristic fallback. All results pass a junk-line filter.
function extractText(ignoreSelection) {
  function cleanup(raw) {
    return raw
      .replace(/\[\d{1,3}\]/g, "") // footnote markers like [12]
      .replace(/\{\d{1,4}\}/g, "") // page markers like {1} (Gutenberg)
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter((l) => l.length > 0)
      .filter((l) => !/^(advertisement|sponsored( content)?|ad)$/i.test(l))
      .filter(
        (l) =>
          !(
            l.length < 40 &&
            /^(share|tweet|print|copy link|download( pdf)?|cite( this)?|related( articles?| content)?|references?|see also|read more|skip to .*|accept( all)? cookies?|cookie settings)$/i.test(
              l
            )
          )
      )
      .join("\n")
      .trim();
  }
  const sel =
    !ignoreSelection && window.getSelection && window.getSelection().toString();
  if (sel && sel.trim().length > 20) {
    return { kind: "selection", text: cleanup(sel) };
  }
  // Readability (injected as readability.js before this runs)
  try {
    if (window.__bvReadability) {
      const article = new window.__bvReadability(document.cloneNode(true), {
        charThreshold: 250,
      }).parse();
      if (article && (article.content || article.textContent)) {
        // article.textContent loses line structure on SPA pages (chat UIs,
        // scripts), which dialogue detection depends on. Render the article
        // HTML off-screen and take innerText, which restores line breaks.
        let raw = article.textContent || "";
        if (article.content) {
          const div = document.createElement("div");
          div.innerHTML = article.content;
          div.style.cssText =
            "position:absolute;left:-99999px;top:0;width:800px;";
          document.body.appendChild(div);
          const it = div.innerText;
          div.remove();
          if (it && it.trim().length >= raw.trim().length * 0.8) raw = it;
        }
        const body = cleanup(raw);
        if (body.length > 500) {
          const title = (article.title || "").trim();
          return {
            kind: "article",
            title,
            text: title ? title + ".\n" + body : body,
          };
        }
      }
    }
  } catch (e) {
    // fall through to heuristic
  }
  const root =
    document.querySelector('main, article, [role="main"]') || document.body;
  if (!root) return { kind: "page", text: "" };
  const clone = root.cloneNode(true);
  clone
    .querySelectorAll(
      "script,style,noscript,nav,header,footer,aside,button,form,svg,figure figcaption,[aria-hidden='true'],[role='complementary'],[class*='cookie'],[id*='cookie']"
    )
    .forEach((e) => e.remove());
  return { kind: "page", text: cleanup(clone.innerText || clone.textContent || "") };
}

// Must match the hash used by the offscreen engine when saving positions.
function textHash(t) {
  return t.length + ":" + t.slice(0, 50) + ":" + t.slice(-50);
}

// Extract text from a tab and start reading it. `resume` continues from the
// saved position if the page text still matches; `startIndex` (bookmarks)
// forces a specific chunk.
async function readTab(
  tabId,
  { voice, speed, resume, startIndex, startText } = {}
) {
  const tab = await chrome.tabs.get(tabId);

  // Give every frame the Readability article extractor first.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["readability.js"],
    });
  } catch (e) {
    console.warn("Readability injection failed (using fallback):", e);
  }

  // Ebook viewers render asynchronously; retry extraction a few times.
  let best = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: extractText,
      // "Read from here" wants the whole article even if text is selected -
      // the selection only marks the starting point.
      args: [Boolean(startText)],
    });
    const values = results
      .filter((r) => r?.result)
      .map((r) => ({ ...r.result, frameId: r.frameId }));
    best =
      (!startText && values.find((v) => v.kind === "selection")) ||
      values
        .filter((v) => v.kind === "article")
        .sort((a, b) => b.text.length - a.text.length)[0] ||
      values.sort((a, b) => b.text.length - a.text.length)[0];
    if (best && best.text.length >= 40) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!best || best.text.length < 40) {
    throw new Error(
      "Couldn't find readable text. If this is a PDF, BookVoice can't read Chrome's PDF viewer yet — try the EPUB view."
    );
  }

  // null (not 0!) when no explicit position: the engine only honors the
  // startText anchor when resumeIndex is absent, so a default of 0 silently
  // discarded every read-from-here anchor.
  let resumeIndex = null;
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
  const { multiVoice, castVoices } = await chrome.storage.local.get([
    "multiVoice",
    "castVoices",
  ]);
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
    startText,
    multiVoice: multiVoice !== false,
    cast: castVoices || {},
  });
  return { ok: true, resumeIndex };
}

// --- "Read from here" context menu ------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "bv-read-here",
      title: "BookVoice: Read from here",
      contexts: ["page", "selection"],
    });
  });
  // Tabs opened before this install/update don't have the right-click helper
  // yet; inject it so read-from-here works without a page refresh.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const t of tabs) {
    chrome.scripting
      .executeScript({
        target: { tabId: t.id, allFrames: true },
        files: ["ctxmenu.js"],
      })
      .catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "bv-read-here" || !tab?.id) return;
  // On our own PDF reader page, scripts can't be injected - the page itself
  // handles read-from-here.
  if ((tab.url || "").startsWith(chrome.runtime.getURL(""))) {
    chrome.tabs
      .sendMessage(tab.id, {
        target: "bookvoice-pdfreader",
        cmd: "read-from-ctx",
        selectionText: info.selectionText || "",
      })
      .catch(() => {});
    return;
  }
  try {
    let startText = (info.selectionText || "").trim();
    // A short selection (a word or two) can't locate a position in a long
    // text - use the right-clicked paragraph as the anchor instead.
    if (startText.length < 20) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          const t = document.documentElement.dataset.bvCtx;
          delete document.documentElement.dataset.bvCtx;
          return t || null;
        },
      });
      const ctxText = results.map((r) => r?.result).find(Boolean) || "";
      if (ctxText.length > startText.length) startText = ctxText;
    }
    const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);
    await readTab(tab.id, { voice, speed, startText });
  } catch (e) {
    console.warn("Read-from-here failed:", e);
  }
});

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
    case "pick-start":
      // Arm the in-page start-point picker on the active tab (all frames).
      (async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) throw new Error("No active tab");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["picker.js"],
        });
        await chrome.tabs.sendMessage(tab.id, {
          target: "bookvoice-pick",
          cmd: "arm",
        });
        return { ok: true };
      })().then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e.message || String(e) })
      );
      return true;
    case "read-from-anchor":
      // The picker was clicked: start reading this tab from the anchor.
      (async () => {
        const tabId = sender.tab?.id;
        if (tabId == null) throw new Error("No sender tab");
        const { voice, speed } = await chrome.storage.local.get([
          "voice",
          "speed",
        ]);
        return readTab(tabId, { voice, speed, startText: msg.startText });
      })().then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e.message || String(e) })
      );
      return true;
    case "read-text":
      // Pre-extracted text from our own pages (PDF reader). The sender tab
      // hosts the highlighter/floater, so highlight events go back to it.
      (async () => {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          await chrome.storage.session.set({
            hlTarget: { tabId, frameId: 0 },
          });
        }
        const { multiVoice, castVoices } = await chrome.storage.local.get([
          "multiVoice",
          "castVoices",
        ]);
        await ensureOffscreen();
        await chrome.runtime.sendMessage({
          target: "offscreen",
          cmd: "start",
          text: msg.text,
          voice: msg.voice,
          speed: msg.speed,
          url: msg.url,
          title: msg.title,
          startText: msg.startText,
          multiVoice: multiVoice !== false,
          cast: castVoices || {},
        });
        return { ok: true };
      })().then(sendResponse, (e) =>
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
