// Tiny always-on content script: remembers the text near the user's last
// right-click so "BookVoice: Read from here" knows where to start. The anchor
// is stored on the DOM (dataset) so it survives extension reloads that orphan
// this script's isolated world. Nothing is stored or transmitted beyond this
// page until used.
(() => {
  if (window.__bvCtxHooked2) return;
  window.__bvCtxHooked2 = true;
  document.addEventListener(
    "contextmenu",
    (e) => {
      // Find the clicked block of text - but never a huge container (whose
      // text would start at the top of the page and wreck the anchor).
      let el = e.target;
      while (el && el !== document.body) {
        const t = (el.innerText || "").trim();
        if (t.length >= 25) break;
        el = el.parentElement;
      }
      let text =
        el && el !== document.body ? (el.innerText || "").trim() : "";
      if (text.length > 400) text = "";
      // Short block (a one-line quote): extend with following siblings so
      // the anchor is long enough to be located uniquely.
      let sib = el;
      while (text && text.length < 80 && sib) {
        sib = sib.nextElementSibling;
        if (sib) text += " " + (sib.innerText || "").trim();
      }
      const clean = text.replace(/\s+/g, " ").trim().slice(0, 240);
      if (clean) document.documentElement.dataset.bvCtx = clean;
    },
    true
  );
})();
