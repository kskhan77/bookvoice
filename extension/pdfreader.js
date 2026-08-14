// BookVoice PDF reader page. Renders a PDF's text with pdf.js so the normal
// reading pipeline (TTS, highlighting, floating control, resume) works on
// PDFs - Chrome's built-in viewer is walled off from extensions.
import * as pdfjsLib from "./dist/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "dist/pdf.worker.min.mjs"
);

const $ = (id) => document.getElementById(id);
let fullText = "";

function setStatus(t) {
  $("status").textContent = t;
  $("status").style.display = t ? "" : "none";
}

// Merge pdf.js's per-visual-line text into readable paragraphs.
function linesToParagraphs(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const paras = [];
  let cur = "";
  for (const ln of lines) {
    if (!ln) {
      if (cur) {
        paras.push(cur);
        cur = "";
      }
      continue;
    }
    cur = cur ? cur + " " + ln : ln;
    if (/[.!?]["')\]]?$/.test(ln) && ln.length < 80) {
      paras.push(cur);
      cur = "";
    }
  }
  if (cur) paras.push(cur);
  return paras;
}

async function renderPdf(source, title) {
  setStatus("Loading PDF…");
  $("filePick").style.display = "none";
  const doc = await pdfjsLib.getDocument(source).promise;
  $("docTitle").textContent = title;
  document.title = title + " — BookVoice";
  const content = $("content");
  content.textContent = "";
  const parts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    setStatus(`Extracting text — page ${p} of ${doc.numPages}…`);
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let text = "";
    for (const item of tc.items) {
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    text = text
      .replace(/-\n(?=[a-z])/g, "") // re-join hyphenated line breaks
      .replace(/[ \t]+/g, " ");
    const mark = document.createElement("div");
    mark.className = "pageMark";
    mark.textContent = "Page " + p;
    content.appendChild(mark);
    for (const para of linesToParagraphs(text)) {
      const el = document.createElement("p");
      el.textContent = para;
      content.appendChild(el);
      parts.push(para);
    }
  }
  fullText = parts.join("\n");
  setStatus("");
  $("readBtn").disabled = false;
  $("pickBtnBar").disabled = false;
}

async function startReading(startText) {
  if (!fullText) return;
  const { voice, speed } = await chrome.storage.local.get(["voice", "speed"]);
  const r = await chrome.runtime.sendMessage({
    target: "bg",
    cmd: "read-text",
    text: fullText,
    voice: voice || "af_heart",
    speed: speed || 1,
    url: location.href,
    title: $("docTitle").textContent,
    startText: startText || null,
  });
  if (r && r.ok === false) setStatus("⚠ " + r.error);
}

$("readBtn").addEventListener("click", () => startReading());

// "Pick start": highlight the paragraph under the cursor; click starts there.
let picking = false;
let pickHover = null;
const pickStyle = document.createElement("style");
pickStyle.textContent =
  ".bv-pick-hover{outline:3px solid #4f7cff;outline-offset:2px;background:rgba(79,124,255,.10);border-radius:4px;}" +
  ".bv-picking,.bv-picking *{cursor:crosshair !important;}";
document.head.appendChild(pickStyle);

$("pickBtnBar").addEventListener("click", () => {
  picking = true;
  document.documentElement.classList.add("bv-picking");
  setStatus("Click a paragraph to start reading — Esc to cancel");
});
document.addEventListener(
  "mousemove",
  (e) => {
    if (!picking) return;
    const p = e.target.closest("#content p");
    if (pickHover !== p) {
      pickHover?.classList.remove("bv-pick-hover");
      pickHover = p;
      pickHover?.classList.add("bv-pick-hover");
    }
  },
  true
);
document.addEventListener(
  "click",
  (e) => {
    if (!picking) return;
    const p = e.target.closest("#content p");
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    picking = false;
    document.documentElement.classList.remove("bv-picking");
    pickHover?.classList.remove("bv-pick-hover");
    pickHover = null;
    setStatus("");
    let anchor = (p.innerText || "").trim();
    let sib = p;
    while (anchor.length < 80 && sib) {
      sib = sib.nextElementSibling;
      if (sib) anchor += " " + (sib.innerText || "").trim();
    }
    startReading(anchor.replace(/\s+/g, " ").slice(0, 240));
  },
  true
);
document.addEventListener("keydown", (e) => {
  if (picking && e.key === "Escape") {
    picking = false;
    document.documentElement.classList.remove("bv-picking");
    pickHover?.classList.remove("bv-pick-hover");
    pickHover = null;
    setStatus("");
  }
});

// "Read from here" support: remember the last right-clicked paragraph; the
// background routes the context-menu click to us (content scripts and
// scripting injection don't run on extension pages).
let lastCtxText = "";
document.addEventListener(
  "contextmenu",
  (e) => {
    let el = e.target;
    while (el && el !== document.body) {
      const t = (el.innerText || "").trim();
      if (t.length >= 25) break;
      el = el.parentElement;
    }
    let text = el && el !== document.body ? (el.innerText || "").trim() : "";
    if (text.length > 400) text = ""; // clicked a container, not a paragraph
    let sib = el;
    while (text && text.length < 80 && sib) {
      sib = sib.nextElementSibling;
      if (sib) text += " " + (sib.innerText || "").trim();
    }
    lastCtxText = text.replace(/\s+/g, " ").trim().slice(0, 240);
  },
  true
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "bookvoice-pdfreader" && msg.cmd === "read-from-ctx") {
    startReading((msg.selectionText || "").trim() || lastCtxText);
    sendResponse({ ok: true });
  }
});

// Boot: load from ?src= URL, or offer a file picker (works for local files
// without the file-URL permission).
const src = new URLSearchParams(location.search).get("src");
(async () => {
  if (src) {
    try {
      const name = decodeURIComponent(
        (src.split("/").pop() || "Document").split("?")[0]
      );
      await renderPdf({ url: src }, name || "Document");
      return;
    } catch (e) {
      setStatus("Couldn't load that PDF automatically: " + (e.message || e));
    }
  } else {
    setStatus("");
  }
  $("filePick").style.display = "block";
})();

$("pickBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  try {
    await renderPdf({ data: buf }, f.name);
  } catch (err) {
    setStatus("⚠ " + (err.message || err));
  }
});
