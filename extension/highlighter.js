// BookVoice highlighter. Injected into the frame being read. The sentence
// being spoken is wrapped in a styled span (blue tint + 25% zoom) - the CSS
// Custom Highlight API can't change font-size, so this is real DOM wrapping,
// carefully undone when the sentence ends. The spoken word uses the CSS
// Highlight API (no DOM changes). Word timing is estimated by weighting each
// word's share of the sentence's real audio duration.
(() => {
  if (window.__bookvoiceHL) return;
  window.__bookvoiceHL = true;

  const SENT = "bookvoice-sentence";
  const WORD = "bookvoice-word";
  const style = document.createElement("style");
  style.textContent =
    `::highlight(${SENT}){background-color:rgba(79,124,255,.25);}` +
    `::highlight(${WORD}){background-color:rgba(255,196,0,.65);}` +
    `.bv-zoom{background:rgba(79,124,255,.22);font-size:1.25em;line-height:1.3;` +
    `border-radius:3px;transition:font-size .15s ease;}`;
  (document.head || document.documentElement).appendChild(style);

  // User toggle: enlarge the sentence being read (default on).
  let zoomEnabled = true;
  try {
    chrome.storage.local.get("zoomSent").then((v) => {
      if (v && v.zoomSent === false) zoomEnabled = false;
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.zoomSent) zoomEnabled = ch.zoomSent.newValue !== false;
    });
  } catch {}

  let searchFrom = 0; // stripped-char offset; keeps repeated phrases in order
  let timers = [];
  let wordPlan = null;
  let zoomSpans = [];

  const isWs = (c) =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ";

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function clearZoom() {
    for (const sp of zoomSpans) {
      if (!sp.isConnected) continue;
      const parent = sp.parentNode;
      while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
      parent.removeChild(sp);
      parent.normalize(); // merge the split text nodes back together
    }
    zoomSpans = [];
  }

  function clearAll() {
    clearTimers();
    clearZoom();
    CSS.highlights.delete(SENT);
    CSS.highlights.delete(WORD);
    wordPlan = null;
  }

  // Concatenate every text node's characters (whitespace removed, lowercased)
  // with a map from stripped index -> (node, offset), so a match can be turned
  // back into precise DOM positions.
  function buildIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const chars = [];
    const map = [];
    let node;
    while ((node = walker.nextNode())) {
      const t = node.data;
      for (let i = 0; i < t.length; i++) {
        if (isWs(t[i])) continue;
        chars.push(t[i].toLowerCase());
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

  // Wrap the matched sentence in .bv-zoom spans. Segments are grouped per
  // text node and processed in reverse so earlier offsets stay valid as
  // nodes get split by the wrapping.
  function wrapSentence(map, sIdx, eIdxInclusive) {
    const segs = [];
    for (let i = sIdx; i <= eIdxInclusive; i++) {
      const [node, off] = map[i];
      const last = segs[segs.length - 1];
      if (last && last.node === node && off === last.end) last.end = off + 1;
      else segs.push({ node, start: off, end: off + 1 });
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i];
      try {
        const r = new Range();
        r.setStart(seg.node, seg.start);
        r.setEnd(seg.node, seg.end);
        const span = document.createElement("span");
        span.className = "bv-zoom";
        r.surroundContents(span);
        zoomSpans.unshift(span); // keep document order
      } catch {}
    }
    return zoomSpans;
  }

  // Fresh char map over just the wrapped sentence (its nodes were split).
  function mapFromSpans(spans) {
    const chars = [];
    const map = [];
    for (const sp of spans) {
      const walker = document.createTreeWalker(sp, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.data;
        for (let i = 0; i < t.length; i++) {
          if (isWs(t[i])) continue;
          chars.push(t[i].toLowerCase());
          map.push([n, i]);
        }
      }
    }
    return { map };
  }

  function onChunk({ text, duration }) {
    clearTimers();
    CSS.highlights.delete(WORD);
    clearZoom(); // restore the DOM before rebuilding the index
    const { needle, words } = stripNeedle(text || "");
    if (!needle) return;
    const { hay, map } = buildIndex(document.body);
    let idx = hay.indexOf(needle, searchFrom);
    if (idx === -1) idx = hay.indexOf(needle);
    if (idx === -1) {
      CSS.highlights.delete(SENT);
      return; // text not found (e.g. page changed) - keep reading, no highlight
    }
    searchFrom = idx + needle.length;

    let wordMap; // stripped sentence-relative index -> (node, offset)
    let scrollTarget;
    if (zoomEnabled) {
      CSS.highlights.delete(SENT);
      const spans = wrapSentence(map, idx, idx + needle.length - 1);
      if (spans.length === 0) return;
      wordMap = mapFromSpans(spans).map;
      scrollTarget = spans[0];
    } else {
      const sentRange = makeRange(map, idx, idx + needle.length - 1);
      CSS.highlights.set(SENT, new Highlight(sentRange));
      wordMap = map.slice(idx, idx + needle.length);
      scrollTarget = sentRange.startContainer.parentElement;
    }
    scrollTarget?.scrollIntoView({ block: "center", behavior: "smooth" });

    // Longer words get proportionally more of the audio's real duration;
    // trailing punctuation adds a pause share.
    const weights = words.map(
      (w) => w.e - w.s + (/[.,;:!?]["')\]]*$/.test(w.raw) ? 4 : 1)
    );
    const totalW = weights.reduce((a, b) => a + b, 0);
    const ranges = words.map((w) => makeRange(wordMap, w.s, w.e - 1));
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
