// BookVoice highlighter. Injected into the frame being read. Uses the CSS
// Custom Highlight API so the page's DOM is never modified (important for
// fragile ebook viewers). Word timing is estimated by weighting each word's
// share of the sentence's real audio duration.
(() => {
  if (window.__bookvoiceHL) return;
  window.__bookvoiceHL = true;

  const SENT = "bookvoice-sentence";
  const WORD = "bookvoice-word";
  const style = document.createElement("style");
  style.textContent =
    `::highlight(${SENT}){background-color:rgba(79,124,255,.25);}` +
    `::highlight(${WORD}){background-color:rgba(255,196,0,.65);}`;
  (document.head || document.documentElement).appendChild(style);

  let searchFrom = 0; // stripped-char offset; keeps repeated phrases in order
  let timers = [];
  let wordPlan = null;

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }
  function clearAll() {
    clearTimers();
    CSS.highlights.delete(SENT);
    CSS.highlights.delete(WORD);
    wordPlan = null;
  }

  // Concatenate every text node's characters (whitespace removed, lowercased)
  // with a map from stripped index -> (node, offset), so a match can be turned
  // back into a precise DOM Range.
  function buildIndex() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    const chars = [];
    const map = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.data;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ")
          continue;
        chars.push(c.toLowerCase());
        map.push([node, i]);
      }
    }
    return { hay: chars.join(""), map };
  }

  function stripNeedle(text) {
    let needle = "";
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const s = needle.length;
      needle += m[0].toLowerCase();
      words.push({ s, e: needle.length, raw: m[0] });
    }
    return { needle, words };
  }

  function makeRange(map, sIdx, eIdxInclusive) {
    const r = new Range();
    const [sn, so] = map[sIdx];
    const [en, eo] = map[eIdxInclusive];
    r.setStart(sn, so);
    r.setEnd(en, eo + 1);
    return r;
  }

  function onChunk({ text, duration }) {
    clearTimers();
    CSS.highlights.delete(WORD);
    const { needle, words } = stripNeedle(text || "");
    if (!needle) return;
    const { hay, map } = buildIndex();
    let idx = hay.indexOf(needle, searchFrom);
    if (idx === -1) idx = hay.indexOf(needle);
    if (idx === -1) {
      CSS.highlights.delete(SENT);
      return; // text not found (e.g. page changed) - keep reading, no highlight
    }
    searchFrom = idx + needle.length;
    const sentRange = makeRange(map, idx, idx + needle.length - 1);
    CSS.highlights.set(SENT, new Highlight(sentRange));
    sentRange.startContainer.parentElement?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });

    // Longer words get proportionally more of the audio's real duration;
    // trailing punctuation adds a pause share.
    const weights = words.map(
      (w) => w.e - w.s + (/[.,;:!?]["')\]]*$/.test(w.raw) ? 4 : 1)
    );
    const totalW = weights.reduce((a, b) => a + b, 0);
    const ranges = words.map((w) => makeRange(map, idx + w.s, idx + w.e - 1));
    wordPlan = {
      ranges,
      weights,
      totalW,
      durationMs: (duration || 0) * 1000,
      elapsed: 0,
      startedAt: performance.now(),
    };
    scheduleWords();
  }

  function scheduleWords() {
    if (!wordPlan || !wordPlan.durationMs) return;
    clearTimers();
    const { ranges, weights, totalW, durationMs } = wordPlan;
    let acc = 0;
    for (let i = 0; i < ranges.length; i++) {
      const at = (acc / totalW) * durationMs;
      acc += weights[i];
      const delay = at - wordPlan.elapsed;
      if (delay < -250) continue; // already spoken (resuming mid-sentence)
      timers.push(
        setTimeout(() => {
          CSS.highlights.set(WORD, new Highlight(ranges[i]));
        }, Math.max(0, delay))
      );
    }
    wordPlan.startedAt = performance.now() - wordPlan.elapsed;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== "bookvoice-hl") return;
    switch (msg.event) {
      case "session-start":
        clearAll();
        searchFrom = 0;
        break;
      case "chunk":
        onChunk(msg);
        break;
      case "pause":
        if (wordPlan) wordPlan.elapsed = performance.now() - wordPlan.startedAt;
        clearTimers();
        break;
      case "resume":
        scheduleWords();
        break;
      case "stop":
        clearAll();
        searchFrom = 0;
        break;
    }
  });
})();
