// BookVoice floating control. Injected into the top frame while reading:
// play/pause, stop, progress, draggable, closable. Lives in a shadow root so
// page CSS can't affect it (and vice versa).
(() => {
  if (window.__bookvoiceFloat) return;
  window.__bookvoiceFloat = true;

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    right: "18px",
    bottom: "18px",
    zIndex: "2147483647",
  });
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .pill { display:flex; align-items:center; gap:7px; background:#1b1d22; color:#e8e8ea;
        border-radius:999px; padding:8px 12px; font-family:system-ui,sans-serif; font-size:13px;
        box-shadow:0 6px 24px rgba(0,0,0,.4); cursor:grab; user-select:none; }
      .pill:active { cursor:grabbing; }
      button { border:none; background:#2a2d35; color:#e8e8ea; border-radius:999px;
        width:30px; height:30px; font-size:13px; cursor:pointer; line-height:1; }
      button:hover { background:#3a3e48; }
      button.play { background:#4f7cff; color:#fff; }
      .prog { min-width:44px; text-align:center; color:#a5a8b0; font-variant-numeric:tabular-nums; }
    </style>
    <div class="pill" id="pill">
      <span>📖</span>
      <button id="pp" class="play" title="Pause">⏸</button>
      <button id="st" title="Stop">⏹</button>
      <span class="prog" id="prog">–/–</span>
      <button id="cl" title="Hide control">✕</button>
    </div>`;
  document.documentElement.appendChild(host);

  const el = (id) => root.getElementById(id);
  let paused = false;
  const send = (cmd) =>
    chrome.runtime.sendMessage({ target: "bg", cmd }).catch(() => {});

  el("pp").addEventListener("click", () => send(paused ? "resume" : "pause"));
  el("st").addEventListener("click", () => send("stop"));
  el("cl").addEventListener("click", () => {
    window.__bookvoiceFloat = false;
    host.remove();
  });

  // Drag anywhere on the pill (buttons excluded).
  const pill = el("pill");
  let drag = null;
  pill.addEventListener("pointerdown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    pill.setPointerCapture(e.pointerId);
  });
  pill.addEventListener("pointermove", (e) => {
    if (!drag) return;
    Object.assign(host.style, {
      left: Math.max(0, e.clientX - drag.dx) + "px",
      top: Math.max(0, e.clientY - drag.dy) + "px",
      right: "auto",
      bottom: "auto",
    });
  });
  pill.addEventListener("pointerup", () => (drag = null));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== "bookvoice-float") return;
    const st = msg.status || {};
    if (st.state === "playing" || st.state === "paused") {
      paused = st.state === "paused";
      el("pp").textContent = paused ? "▶" : "⏸";
      el("pp").title = paused ? "Resume" : "Pause";
      el("prog").textContent = `${Math.min((st.current || 0) + 1, st.total || 1)}/${st.total || "?"}`;
      host.style.display = "";
    } else if (st.state === "done" || st.state === "idle") {
      host.style.display = "none";
    }
  });
})();
