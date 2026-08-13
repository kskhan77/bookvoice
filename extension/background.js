// Service worker: routes messages between the popup and the offscreen TTS engine,
// and remembers the latest engine status so a reopened popup can catch up.

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "bg") {
    if (msg.cmd === "status") {
      sendResponse(lastStatus);
      return; // synchronous response
    }
    if (msg.cmd === "hl") {
      // Highlight event from the TTS engine -> forward to the frame being read.
      chrome.storage.session.get("hlTarget").then(({ hlTarget }) => {
        if (!hlTarget) return;
        chrome.tabs
          .sendMessage(
            hlTarget.tabId,
            { ...msg, target: "bookvoice-hl" },
            { frameId: hlTarget.frameId }
          )
          .catch(() => {}); // tab or frame is gone; not fatal
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.cmd === "start" && msg.tabId != null) {
      // Remember which tab/frame this reading session came from.
      chrome.storage.session.set({
        hlTarget: { tabId: msg.tabId, frameId: msg.frameId ?? 0 },
      });
    }
    // Commands bound for the TTS engine: make sure the offscreen doc exists first.
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ ...msg, target: "offscreen" }))
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response
  }
  if (msg?.target === "status-broadcast") {
    // Progress updates from the offscreen engine. Store, and let any open popup
    // receive the same broadcast directly (popups listen to onMessage too).
    lastStatus = msg.status;
  }
});
