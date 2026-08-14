// BookVoice text pipeline: dialogue detection, chunking, voice casting, and
// position anchoring. Shared by the offscreen engine and the test harness so
// behavior can be reproduced and verified outside the extension.

export const VOICE_POOL = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "bf_emma",
  "bm_george",
];

const ATTR_VERBS =
  "said|asked|replied|answered|shouted|whispered|muttered|added|continued|cried|exclaimed|responded|snapped|murmured|called|agreed|admitted|began";

function normName(n) {
  return n.trim().replace(/\s+/g, " ").toLowerCase();
}

// Section headings masquerade as speaker labels ("The First Secret: ...");
// real speaker labels repeat and don't start with heading words.
const HEADING_WORDS =
  /^(the|a|an|chapter|part|section|page|step|note|figure|table|introduction|conclusion|summary|contents|index|appendix|preface|foreword|lesson|unit|book|volume|one|two|three|four|five)\b/i;
const PRONOUNS = new Set([
  "he",
  "she",
  "they",
  "i",
  "we",
  "you",
  "it",
  "him",
  "her",
  "them",
  "who",
  "someone",
  "everyone",
]);

export function detectSegments(text) {
  const lines = text.split("\n");
  // Layer 1: explicitly labeled lines (INTERVIEWER:, Alice:, Q:, A:).
  // A label only counts as a speaker if it appears at least twice.
  const labelRe = /^([A-Z][A-Za-z .'’-]{0,24}?)\s*:\s+(.+)$/;
  const labelCounts = new Map();
  for (const ln of lines) {
    const m = ln.match(labelRe);
    if (m) {
      const name = normName(m[1]);
      if (!HEADING_WORDS.test(name) && name.split(" ").length <= 3) {
        labelCounts.set(name, (labelCounts.get(name) || 0) + 1);
      }
    }
  }
  const usable = new Set(
    [...labelCounts].filter(([, n]) => n >= 2).map(([name]) => name)
  );
  const usableLines = [...labelCounts]
    .filter(([name]) => usable.has(name))
    .reduce((a, [, n]) => a + n, 0);
  if (usable.size >= 2 && usable.size <= 12 && usableLines >= 4) {
    const segs = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const m = ln.match(labelRe);
      if (m && usable.has(normName(m[1]))) {
        segs.push({ speaker: normName(m[1]), text: m[2] });
      } else {
        segs.push({ speaker: null, text: ln });
      }
    }
    return segs;
  }
  // Layer 1b: screenplay format - NAME alone on a line, dialogue beneath:
  //   MARK
  //   (leaning against the doorframe)
  //   You've been staring at that same line for three hours.
  const nameLineRe = /^([A-Z][A-Z .'’-]{1,24})$/;
  const nameCounts = new Map();
  for (const ln of lines) {
    const t = ln.trim();
    if (nameLineRe.test(t)) {
      const name = normName(t);
      if (!HEADING_WORDS.test(name) && name.split(" ").length <= 3) {
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
    }
  }
  const screenCast = new Set(
    [...nameCounts].filter(([, n]) => n >= 2).map(([name]) => name)
  );
  const screenLines = [...nameCounts]
    .filter(([name]) => screenCast.has(name))
    .reduce((a, [, n]) => a + n, 0);
  if (screenCast.size >= 2 && screenCast.size <= 12 && screenLines >= 4) {
    const segs = [];
    let current = null;
    let linesSince = 0;
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (nameLineRe.test(t) && screenCast.has(normName(t))) {
        current = normName(t); // the name line itself is not spoken
        linesSince = 0;
        continue;
      }
      // Stage directions and scene headings belong to the narrator and
      // don't end the character's speech block.
      if (
        /^[\[(].*[\])]$/.test(t) ||
        /^(INT\.|EXT\.|TITLE:|CHARACTERS:|SCENE\b|\[)/i.test(t)
      ) {
        segs.push({ speaker: null, text: t });
        continue;
      }
      if (current && linesSince < 8) {
        segs.push({ speaker: current, text: t });
        linesSince++;
      } else {
        segs.push({ speaker: null, text: t });
      }
    }
    return segs;
  }
  // Layer 2 + 3: quoted dialogue with attribution, alternation fallback.
  // (Text is left byte-identical to the page so highlighting keeps working;
  // the regex accepts straight and curly quotes.)
  const segs = [];
  const qRe = /["“]([^"”\n]{2,400})["”]/g;
  // Attribution accepts proper names ("said Alice"), titled names
  // ("said Mr. Bennet"), and lowercase descriptors ("said the young man",
  // "the manager replied").
  const NAME_PAT = `((?:[A-Z][a-z]{0,3}\\.\\s+)?[A-Za-z][a-z]+(?:\\s+[A-Za-z][a-z]+)?)`;
  const attrAfter = new RegExp(
    `^[\\s,.;—-]{0,6}(?:(?:${ATTR_VERBS})\\s+(?:the\\s+|his\\s+|her\\s+|their\\s+)?${NAME_PAT}|(?:the\\s+)?${NAME_PAT}\\s+(?:${ATTR_VERBS}))`
  );
  const attrBefore = new RegExp(
    `(?:^|[\\s(])(?:the\\s+|his\\s+|her\\s+|their\\s+)?${NAME_PAT}\\s+(?:${ATTR_VERBS})[^"“”]{0,20}$`
  );
  // A trailing function word means the capture overshot ("lady to" -> "lady").
  const STOP_SECOND = new Set([
    "to", "of", "in", "at", "on", "for", "with", "and", "that", "him",
    "her", "them", "one", "up", "down", "out", "as", "so", "but", "when",
  ]);
  const refineName = (cand) => {
    if (!cand) return cand;
    const parts = cand.split(" ");
    if (parts.length >= 2 && STOP_SECOND.has(parts[parts.length - 1])) {
      parts.pop();
    }
    return parts.join(" ");
  };
  const validSpeaker = (name) => name && !PRONOUNS.has(name.split(" ")[0]);
  let last = 0;
  let lastQuoteEnd = -1;
  let lastQuoteSpeaker = null;
  const recent = [];
  let m;
  while ((m = qRe.exec(text))) {
    const before = text.slice(last, m.index);
    if (before.trim()) segs.push({ speaker: null, text: before });
    // Long narration since the previous quote ends the conversation scene.
    if (lastQuoteEnd >= 0 && m.index - lastQuoteEnd > 400) {
      recent.length = 0;
      lastQuoteSpeaker = null;
    }
    let speaker = null;
    const after = text.slice(qRe.lastIndex, qRe.lastIndex + 80);
    const am = after.match(attrAfter);
    if (am) {
      const cand = refineName(normName(am[1] || am[2]));
      if (validSpeaker(cand)) speaker = cand;
    }
    if (!speaker) {
      const bm = before.match(attrBefore);
      if (bm) {
        const cand = refineName(normName(bm[1]));
        if (validSpeaker(cand)) speaker = cand;
      }
    }
    if (!speaker) {
      const others = recent.filter((s) => s !== lastQuoteSpeaker);
      speaker = others.length
        ? others[others.length - 1]
        : lastQuoteSpeaker
          ? "second speaker"
          : "speaker";
    }
    if (!recent.includes(speaker)) recent.push(speaker);
    if (recent.length > 4) recent.shift();
    lastQuoteSpeaker = speaker;
    segs.push({ speaker, text: m[1] });
    last = qRe.lastIndex;
    lastQuoteEnd = qRe.lastIndex;
  }
  const tail = text.slice(last);
  if (tail.trim()) segs.push({ speaker: null, text: tail });
  return segs;
}

export function voiceFor(speaker, narrator, cast) {
  if (!speaker) return narrator;
  if (cast && cast[speaker]) return cast[speaker];
  const pool = VOICE_POOL.filter((v) => v !== narrator);
  let h = 0;
  for (let i = 0; i < speaker.length; i++) {
    h = (h * 31 + speaker.charCodeAt(i)) >>> 0;
  }
  return pool[h % pool.length];
}

export function buildChunks(text, { multiVoice, narrator, cast }) {
  const segs = multiVoice ? detectSegments(text) : [{ speaker: null, text }];
  const chunks = [];
  for (const seg of segs) {
    const v = voiceFor(seg.speaker, narrator, cast);
    for (const t of splitIntoChunks(seg.text)) {
      chunks.push({ t, v, speaker: seg.speaker });
    }
  }
  return chunks;
}

export function castSummary(chunks) {
  const seen = new Map();
  for (const c of chunks) {
    if (c.speaker && !seen.has(c.speaker)) seen.set(c.speaker, c.v);
  }
  return [...seen].slice(0, 8).map(([name, voice]) => ({ name, voice }));
}

// Split text into sentence-boundary chunks small enough for Kokoro's context.
export function splitIntoChunks(text, maxLen = 300) {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [
    clean,
  ];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxLen) {
      chunks.push(cur.trim());
      cur = "";
    }
    // A single overlong sentence gets hard-split on commas/spaces.
    if (s.length > maxLen) {
      if (cur) {
        chunks.push(cur.trim());
        cur = "";
      }
      let rest = s;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(",", maxLen);
        if (cut < maxLen * 0.4) cut = rest.lastIndexOf(" ", maxLen);
        if (cut <= 0) cut = maxLen;
        chunks.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      cur = rest;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => /\p{L}|\p{N}/u.test(c));
}

// Must match the hash used by background.js when checking saved positions.
export function textHash(t) {
  return t.length + ":" + t.slice(0, 50) + ":" + t.slice(-50);
}

// Locate the chunk containing an anchor text (read-from-here). Compares
// letters/digits only: dialogue chunks drop quote marks and cleanup drops
// footnote markers, so punctuation can't be trusted to match.
export function findStartChunk(chunks, startText) {
  const strip = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const needle = strip(startText).slice(0, 60);
  if (needle.length < 12) return { index: null, needle };
  let acc = "";
  const bounds = chunks.map((c) => {
    const s = acc.length;
    acc += strip(c.t);
    return { s, e: acc.length };
  });
  const hit = acc.indexOf(needle);
  if (hit < 0) return { index: null, needle };
  return { index: bounds.findIndex((b) => hit < b.e), needle };
}
