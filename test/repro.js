// Reproduces the exact read-from-here pipeline against the real Pride &
// Prejudice page: proxy-fetch HTML -> Readability -> innerText -> cleanup ->
// buildChunks (multi-voice) -> findStartChunk with real user anchors.
import { Readability } from "@mozilla/readability";
import { buildChunks, findStartChunk, castSummary } from "../src/textpipe.js";

const logEl = document.getElementById("log");
const log = (m) => {
  logEl.textContent += m + "\n";
  console.log("[repro]", m);
};

// Copy of background.js cleanup() - keep in sync.
function cleanup(raw) {
  return raw
    .replace(/\[\d{1,3}\]/g, "")
    .replace(/\{\d{1,4}\}/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^(advertisement|sponsored( content)?|ad)$/i.test(l))
    .filter(
      (l) =>
        !(
          l.length < 40 &&
          /^(share|tweet|print|copy link|download( pdf)?|cite( this)?|related( articles?| content)?|references?|see also|read more|skip to .*|accept( all)? cookies?|cookie settings)$/i.test(
            l
          )
        )
    )
    .join("\n")
    .trim();
}

const PP_URL = "https://www.gutenberg.org/files/1342/1342-h/1342-h.htm";

const ANCHORS = [
  "a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.",
  "“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”",
  "My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?",
];

document.getElementById("run").addEventListener("click", async () => {
  try {
    log("fetching page (local copy of " + PP_URL + ")…");
    const html = await (await fetch("/pp.html")).text();
    log(`fetched ${Math.round(html.length / 1024)} KB`);

    const doc = new DOMParser().parseFromString(html, "text/html");
    const article = new Readability(doc, { charThreshold: 250 }).parse();
    if (!article) {
      log("READABILITY RETURNED NULL");
      return;
    }
    log(`readability title: ${article.title}`);

    // Same as background.js: render article HTML and take innerText.
    let raw = article.textContent || "";
    if (article.content) {
      const div = document.createElement("div");
      div.innerHTML = article.content;
      div.style.cssText = "position:absolute;left:-99999px;top:0;width:800px;";
      document.body.appendChild(div);
      const it = div.innerText;
      div.remove();
      if (it && it.trim().length >= raw.trim().length * 0.8) raw = it;
    }
    const text = cleanup(raw);
    log(`extracted ${text.length} chars; first 200:\n  ${JSON.stringify(text.slice(0, 200))}`);

    const chunks = buildChunks(text, {
      multiVoice: true,
      narrator: "af_heart",
      cast: {},
    });
    log(`chunks: ${chunks.length}`);
    log(
      "cast: " +
        (castSummary(chunks)
          .map((s) => s.name)
          .join(", ") || "(none)")
    );
    for (let i = 0; i < 4; i++) {
      log(`  chunk[${i}] (${chunks[i].speaker || "narrator"}): ${chunks[i].t.slice(0, 70)}`);
    }

    for (const anchor of ANCHORS) {
      const r = findStartChunk(chunks, anchor);
      log(`\nanchor: ${anchor.slice(0, 50)}…`);
      log(
        r.index != null
          ? `  FOUND at chunk ${r.index}: "${chunks[r.index].t.slice(0, 70)}"`
          : `  *** NOT FOUND *** (needle: ${r.needle})`
      );
    }
    log("\nDONE");
  } catch (e) {
    log("ERROR: " + (e.stack || e));
  }
});
