# Publishing BookVoice to the Chrome Web Store

Upload file: `bookvoice-v0.1.0.zip` (already built, in this folder).

## Step 1 — Developer account (you must do this yourself)

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account you want to own the extension
3. Accept the developer agreement and pay the **one-time $5 registration fee**

## Step 2 — Upload

1. In the developer console click **+ New item**
2. Upload `bookvoice-v0.1.0.zip`

## Step 3 — Store listing (copy-paste below)

**Name:** BookVoice - Natural Read Aloud

**Summary (132 chars max):**
Reads web pages and ebooks aloud with a natural neural voice. Runs 100%
locally on your device - private, free, works offline.

**Description:**

Tired of robotic read-aloud voices? BookVoice reads any web page, article, or
online ebook (EPUB viewers like EBSCO, library readers, documentation) with a
genuinely natural neural voice - powered by the open-source Kokoro AI voice
model running entirely on YOUR device.

- 7 natural voices (US & UK, male & female)
- Adjustable reading speed (0.5x - 2x) without chipmunk pitch
- Read the whole page, or select a passage to read just that part
- Works inside ebook viewers that use iframes
- 100% private: nothing you read ever leaves your computer
- Free forever, no account, no API keys
- Works offline after the one-time voice model download (~330 MB)
- Uses your GPU (WebGPU) when available, falls back to CPU

Note: Chrome's built-in PDF viewer is not readable by extensions; use a
book's EPUB/HTML view.

**Category:** Accessibility
**Language:** English

## Step 4 — Privacy tab (required, reviewers check this carefully)

**Single purpose description:**
Reads the text of the current page aloud using a locally-running
text-to-speech voice model.

**Permission justifications:**

- `activeTab` / `scripting`: Extracts the visible text of the page the user
  asked to have read aloud. Injection happens only when the user clicks
  "Read page" in the popup.
- `host_permissions (<all_urls>)`: Ebooks and library readers render their
  content inside cross-origin iframes; reading the text of those frames
  requires host access. Also allows the one-time download of the open-source
  voice model from huggingface.co. No data is sent anywhere.
- `offscreen`: Runs the text-to-speech engine and plays audio (Manifest V3
  service workers cannot play audio).
- `storage`: Saves the user's chosen voice and reading speed locally.

**Remote code:** No, all code is packaged in the extension. (The voice model
downloaded from Hugging Face is data/weights, not executable code.)

**Data usage:** Check "This item does not collect user data". BookVoice sends
no page content, telemetry, or personal data anywhere; all processing is
local.

**Privacy policy URL:** Host `privacy-policy.md` (in this folder) anywhere
public - a GitHub repository README/gist works fine - and paste its URL.

## Step 5 — Graphics assets (ready in `store-assets/`)

- **Screenshots (1280x800):** upload all three —
  `store-assets/shot1-hero.png`, `store-assets/shot2-highlight.png`,
  `store-assets/shot3-privacy.png`
- **Small promo tile (440x280):** `store-assets/tile-small.png`
- Optional extra: add a real screenshot of BookVoice reading an actual page
  (Win+Shift+S, crop to 1280x800) — real-usage shots build trust.
- To tweak these images: edit the HTML in `store-assets/src/` and re-render
  with headless Chrome (see the command in the repo history or ask).

## Step 6 — Visibility and submit

- Visibility: **Public** (anyone can find it) or **Unlisted** (only people
  with the link can install - good for a first release to classmates).
- Click **Submit for review**. Because the extension requests `<all_urls>`,
  review typically takes a few days to a couple of weeks. You'll get an
  email either way; rejections state a reason and you can fix and resubmit.

## Updating later

Bump `"version"` in `extension/manifest.json` (e.g. 0.1.1), rebuild the zip,
and upload it as a new package on the existing item - users update
automatically.
