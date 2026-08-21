// BookVoice start-point picker. Armed via a message from the background;
// highlights the paragraph under the cursor and, on click, sends its text as
// the reading anchor. Esc cancels.
(() => {
  if (window.__bvPicker) return;
  window.__bvPicker = true;

  const style = document.createElement("style");
  style.textContent =
    `.bv-pick-hover{outline:3px solid #4f7cff !important;outline-offset:2px;` +
    `background:rgba(79,124,255,.10) !important;border-radius:4px;}` +
    `.bv-picking,.bv-picking *{cursor:crosshair !important;}`;
  (document.head || document.documentElement).appendChild(style);

  let armed = false;
  let hoverEl = null;
  let banner = null;

  function findBlock(el) {
    let n = el;
    while (n && n !== document.body) {
      const t = (n.innerText || "").trim();
      if (t.length >= 25 && t.length <= 2000) return n;
      n = n.parentElement;
    }
    return null;
  }

  function anchorFrom(el) {
    let text = (el.innerText || "").trim();
    let sib = el;
    while (text.length < 80 && sib) {
      sib = sib.nextElementSibling;
      if (sib) text += " " + (sib.innerText || "").trim();
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function setHover(el) {
    if (hoverEl === el) return;
    hoverEl?.classList.remove("bv-pick-hover");
    hoverEl = el;
    hoverEl?.classList.add("bv-pick-hover");
  }

  function showBanner() {
    banner = document.createElement("div");
    banner.textContent = "📖 Click a paragraph to start reading — Esc to cancel";
    Object.assign(banner.style, {
      position: "fixed",
      top: "14px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#1b1d22",
      color: "#e8e8ea",
      padding: "10px 18px",
      borderRadius: "999px",
      font: "600 13px system-ui, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.4)",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(banner);
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    setHover(null);
    banner?.remove();
    banner = null;
    document.documentElement.classList.remove("bv-picking");
  }

  function arm() {
    if (armed) return;
    armed = true;
    document.documentElement.classList.add("bv-picking");
    showBanner();
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!armed) return;
      setHover(findBlock(e.target));
    },
    true
  );

  function toast(text, ms) {
    const t = document.createElement("div");
    t.textContent = text;
    Object.assign(t.style, {
      position: "fixed",
      top: "14px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: "#1b1d22",
      color: "#e8e8ea",
      padding: "10px 18px",
      borderRadius: "999px",
      font: "600 13px system-ui, sans-serif",
      boxShadow: "0 6px 24px rgba(0,0,0,.4)",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!armed) return;
      e.preventDefault();
      e.stopPropagation();
      const block = findBlock(e.target);
      const startText = block ? anchorFrom(block) : "";
      disarm();
      if (startText) {
        toast("▶ Starting from this paragraph…", 4000);
        chrome.runtime
          .sendMessage({ target: "bg", cmd: "read-from-anchor", startText })
          .catch(() => {});
      } else {
        toast("Couldn't read that spot — click on a text paragraph", 3000);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (armed && e.key === "Escape") disarm();
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.target !== "bookvoice-pick") return;
    if (msg.cmd === "arm") arm();
    sendResponse({ ok: true });
  });
})();
