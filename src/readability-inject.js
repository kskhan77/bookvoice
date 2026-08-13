// Bundled into extension/readability.js (IIFE) and injected into page frames
// before text extraction. Exposes Mozilla Readability (Firefox Reader Mode's
// article extractor) as a page global for the extraction function to use.
import { Readability, isProbablyReaderable } from "@mozilla/readability";

if (!window.__bvReadability) {
  window.__bvReadability = Readability;
  window.__bvIsReaderable = isProbablyReaderable;
}
