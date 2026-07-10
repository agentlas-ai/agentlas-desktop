// Deterministic source-offset tagger for site design screens.
//
// The renderer never receives raw generated HTML: every render goes through
// prepareSiteRenderHtml(), which (1) stamps each selectable element with
// data-agentlas-id="a<sourceOffset>" so a click in the preview maps back to an
// exact character range of the SOURCE file (React-19-safe: no fiber, no
// sourcemaps), and (2) injects a network-blocking CSP plus the selection
// overlay script. We own the generation contract (self-contained HTML5), so a
// small quote-aware tokenizer is sufficient — no HTML parser dependency.
import type { SiteTaggedElement } from "../../shared/site-studio";
import { buildSiteOverlayScript } from "./overlay-script";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/** Metadata/structural tags that are never selectable design targets. */
const UNTAGGED_ELEMENTS = new Set([
  "html", "head", "title", "meta", "link", "style", "script", "base", "noscript",
]);

type OpenTagToken = {
  tagName: string;
  /** Offset of "<". */
  start: number;
  /** Offset of the closing ">". */
  gt: number;
  /** Offset just past ">". */
  afterGt: number;
  selfClosing: boolean;
};

/** Scan an open tag starting at `lt` ("<"). Returns null if malformed. */
function scanOpenTag(html: string, lt: number): OpenTagToken | null {
  let i = lt + 1;
  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i])) i += 1;
  if (i === nameStart) return null;
  const tagName = html.slice(nameStart, i).toLowerCase();
  let lastMeaningful = "";
  while (i < html.length) {
    const ch = html[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < html.length && html[i] !== quote) i += 1;
      i += 1; // past closing quote
      lastMeaningful = quote;
      continue;
    }
    if (ch === ">") {
      return {
        tagName,
        start: lt,
        gt: i,
        afterGt: i + 1,
        selfClosing: lastMeaningful === "/",
      };
    }
    if (!/\s/.test(ch)) lastMeaningful = ch;
    i += 1;
  }
  return null;
}

export type SiteTagResult = {
  taggedHtml: string;
  elements: SiteTaggedElement[];
};

/**
 * Stamp selectable elements with data-agentlas-id and return element source
 * ranges. Ids and ranges always reference the ORIGINAL source string, so a
 * patch can splice source[start..end) regardless of the injected attributes.
 */
export function tagSiteHtml(html: string): SiteTagResult {
  const parts: string[] = [];
  let emitted = 0;
  const elements: SiteTaggedElement[] = [];
  const byId = new Map<string, SiteTaggedElement>();
  const stack: { tagName: string; element: SiteTaggedElement | null }[] = [];
  let i = 0;

  const closeStackTo = (matchIndex: number, endOffset: number) => {
    for (let s = stack.length - 1; s >= matchIndex; s -= 1) {
      const entry = stack[s];
      if (entry.element) entry.element.end = endOffset;
    }
    stack.length = matchIndex;
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;

    // Comment
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    // Doctype / CDATA / other declarations
    if (html[lt + 1] === "!") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    // Close tag
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      const name = html.slice(lt + 2, end).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].tagName === name) {
          closeStackTo(s, end + 1);
          break;
        }
      }
      i = end + 1;
      continue;
    }
    // Open tag
    const token = scanOpenTag(html, lt);
    if (!token) {
      i = lt + 1;
      continue;
    }

    const taggable = !UNTAGGED_ELEMENTS.has(token.tagName);
    let element: SiteTaggedElement | null = null;
    if (taggable) {
      element = {
        id: `a${token.start}`,
        tagName: token.tagName,
        start: token.start,
        end: token.afterGt,
      };
      elements.push(element);
      byId.set(element.id, element);
      // Inject the attribute just before ">" (before "/" for self-closing).
      let insertAt = token.gt;
      if (token.selfClosing) {
        let slash = token.gt - 1;
        while (slash > token.start && /\s/.test(html[slash])) slash -= 1;
        if (html[slash] === "/") insertAt = slash;
      }
      parts.push(html.slice(emitted, insertAt));
      parts.push(` data-agentlas-id="${element.id}"`);
      emitted = insertAt;
    }

    const isVoid = VOID_ELEMENTS.has(token.tagName) || token.selfClosing;
    if (!isVoid) {
      if (RAW_TEXT_ELEMENTS.has(token.tagName)) {
        // Raw text: skip straight to the matching close tag.
        const closeRe = new RegExp(`</${token.tagName}\\s*>`, "i");
        closeRe.lastIndex = 0;
        const rest = html.slice(token.afterGt);
        const match = closeRe.exec(rest);
        if (match) {
          const closeEnd = token.afterGt + match.index + match[0].length;
          if (element) element.end = closeEnd;
          i = closeEnd;
        } else {
          if (element) element.end = html.length;
          i = html.length;
        }
        continue;
      }
      stack.push({ tagName: token.tagName, element });
    }
    i = token.afterGt;
  }

  // Anything left open ends at EOF.
  closeStackTo(0, html.length);

  parts.push(html.slice(emitted));
  return { taggedHtml: parts.join(""), elements };
}

/**
 * Network-blocking CSP for the sandboxed preview: inline style/script only,
 * data:/blob: images and fonts, no connect/media/frame targets.
 */
export const SITE_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; " +
  "media-src data: blob:; base-uri 'none'; form-action 'none'";

export type SiteRenderPrep = {
  renderHtml: string;
  elements: SiteTaggedElement[];
};

/**
 * Produce the HTML actually loaded into the sandboxed iframe:
 * tagged source + CSP meta + selection overlay (nonce-scoped postMessage).
 * Both are injected at the TOP of <head> so the console/error hooks are live
 * before any design-authored <script> executes (parse-time errors included);
 * the overlay defers its DOM mount to DOMContentLoaded.
 */
export function prepareSiteRenderHtml(sourceHtml: string, nonce: string): SiteRenderPrep {
  const { taggedHtml, elements } = tagSiteHtml(sourceHtml);
  const injection =
    `<meta http-equiv="Content-Security-Policy" content="${SITE_PREVIEW_CSP}">` +
    `<script data-agentlas-overlay="1">${buildSiteOverlayScript(nonce)}</script>`;

  let renderHtml: string;
  const headMatch = /<head\b[^>]*>/i.exec(taggedHtml);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    renderHtml = `${taggedHtml.slice(0, at)}${injection}${taggedHtml.slice(at)}`;
  } else {
    renderHtml = `${injection}${taggedHtml}`;
  }
  return { renderHtml, elements };
}
