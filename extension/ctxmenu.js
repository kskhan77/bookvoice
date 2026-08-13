// Tiny always-on content script: remembers the text near the user's last
// right-click so "BookVoice: Read from here" knows where to start. Nothing is
// stored or transmitted; the value lives only in this page until used.
(() => {
  if (window.__bvCtxHooked) return;
  window.__bvCtxHooked = true;
  document.addEventListener(
    "contextmenu",
    (e) => {
      let el = e.target;
      let text = "";
      // Walk up until we have a meaningful amount of text (a paragraph).
      while (el && (text = (el.innerText || "").trim()).length < 60) {
        el = el.parentElement;
      }
      window.__bvCtxText = text.slice(0, 200);
    },
    true
  );
})();
