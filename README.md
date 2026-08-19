# BookVoice — Natural Read-Aloud Chrome Extension

**✦ Crafted by [Khurram Shafique](https://github.com/kskhan77) ✦**

> **Status:** v0.2.0 submitted to the Chrome Web Store (August 2026).
> Until it's published, install by loading the `extension/` folder
> unpacked (instructions below).

Reads web pages and ebooks (EBSCO EPUB viewer, articles, any HTML page) aloud
with a **natural neural voice** — Kokoro-82M running 100% locally on your GPU
via WebGPU. No cloud, no API keys, works offline after the first model download.

## Roadmap

- **More languages** — Urdu, Hindi, and others via Meta's MMS-TTS models
  (local, in-browser), with automatic language detection and routing
- **Translate-and-listen** — translate pages on-device (Chrome's built-in
  Translator API) and read them aloud in your language
- Click any paragraph to start reading from there
- Export a chapter to MP3
- Auto-continue to the next book section
- Remember reading position per book
- PDF support via a bundled text extractor

Language and translation work will happen on the `feature/multilingual`
branch; `main` stays matched to the version under store review.

## Install (load unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder in this project
4. Pin **BookVoice** to the toolbar

## Use

1. Open the page or ebook you want read (e.g. the EBSCO ebook viewer)
2. Optional: select a passage to read just that part; otherwise it reads the page
3. Click the BookVoice icon → pick a voice and speed → **Read page**

The first click downloads the Kokoro voice model (~330 MB, one time only —
it's cached after that). Then audio starts within a few seconds and keeps
generating ahead of playback.

- **Pause / Resume / Stop** from the popup
- **Speed** applies to the next reading you start (it changes how the voice
  *speaks*, not a chipmunk-style pitch shift)
- Status line shows `GPU` (WebGPU) or `CPU` (WASM fallback)

## Known limitations (v0.1)

- Chrome's built-in **PDF viewer can't be read** (extensions can't see its
  text). Use the EPUB/HTML view of a book when available.
- Reading continues while you stay on the page; ebook viewers only load one
  section at a time, so start the next section when a chapter ends.
- No in-page sentence highlighting yet.

## Rebuild after changing the code

Node.js is vendored in `.tools/` (portable, doesn't touch your system):

```powershell
$env:Path = "$PWD\.tools\node-v22.18.0-win-x64;" + $env:Path
npm run build
```

Then click the reload icon on the extension in `chrome://extensions`.

## How it works

- `extension/popup.js` — extracts readable text from the active tab
  (`chrome.scripting`, all frames, so iframe-based ebook viewers work;
  a text selection takes priority)
- `extension/background.js` — service worker; spins up the offscreen document
  and relays status
- `src/offscreen.js` → bundled to `extension/dist/offscreen.js` — the TTS
  engine: kokoro-js + transformers.js, WebGPU first (fp32), WASM fallback
  (q8); splits text into sentence chunks, generates ~3 chunks ahead, plays
  through an AudioContext
- `extension/dist/ort-*.wasm|mjs` — onnxruntime runtime files served locally
  (Manifest V3 forbids CDN code)
