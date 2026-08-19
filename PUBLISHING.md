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

- **Screenshots (1280x800, max 5):** upload all five, in this order —
  1. `store-assets/shot1-hero.png` (popup + headline)
  2. `store-assets/shot4-multivoice.png` (dialogue cast - headline feature)
  3. `store-assets/shot2-highlight.png` (follow-along highlighting)
  4. `store-assets/shot5-pdf.png` (built-in PDF reader)
  5. `store-assets/shot3-privacy.png` (private by design)
- **Small promo tile (440x280):** `store-assets/tile-small.png`
- Optional extra: swap one for a real screenshot of BookVoice reading an
  actual page - real-usage shots build trust.
- To tweak these images: edit the HTML in `store-assets/src/` and re-render
  with headless Chrome (see the command in the repo history or ask).

## v0.2.0 listing description (paste into Description)

Tired of robotic read-aloud voices? BookVoice reads any web page, article,
online ebook (EPUB viewers like EBSCO and library readers), or PDF with a
genuinely natural neural voice - powered by the open-source Kokoro AI voice
model running entirely on YOUR device.

WHY BOOKVOICE
- 7 natural voices (US & UK, male & female), adjustable speed (0.5x-2x)
- Multi-voice dialogue: interviews, scripts, and novels get a full cast -
  each character speaks in their own voice, with a Cast panel to recast
  anyone in one click
- Live follow-along: the sentence being read is highlighted (and gently
  enlarged), the spoken word sweeps in yellow, and the page scrolls itself
- Start anywhere: pick any paragraph visually and reading begins right there
- Bookmarks & resume: save your spot in any book and continue with one click
- Floating on-page control: pause, skip a sentence, or stop without opening
  the popup
- Built-in PDF reader: open any PDF (web or local file) and every feature
  works there too
- Clean reading: article extraction drops ads, menus, cookie banners, and
  footnote clutter before a single word is spoken

PRIVATE BY DESIGN
- 100% local: nothing you read ever leaves your computer
- No account, no API keys, no telemetry - free forever
- Works offline after the one-time voice model download (~330 MB)
- Uses your GPU (WebGPU) when available; falls back to CPU automatically
- A device compatibility check on install tells you upfront how well your
  hardware will handle it

GETTING STARTED
1. Open any article, ebook, or PDF
2. Click the BookVoice icon
3. Pick a voice and press Read page - or use "Start from a spot on the
   page" and click exactly where you want to begin

NOTE
Chrome's built-in PDF viewer is closed to extensions - use the "Open in
BookVoice PDF Reader" button the popup offers on PDFs. Ebook viewers load
one section at a time, so start each new chapter when the previous ends.

## v0.2.0 new permission justification (Privacy tab)

contextMenus:
Adds a "BookVoice: Read from here" option to the right-click menu so the
user can start reading aloud from a chosen paragraph. Used only when the
user clicks that menu item.

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
