// Reference formatting for Science manuscripts.
//
// Sources in the Science store carry title, authors, year, container title
// (journal / book / site), publisher, and a canonical URI (DOI or URL). That is
// enough for the three families of style that cover almost every journal:
//   numeric   — Vancouver / IEEE-like "[3]" markers, numbered list in citation order
//   apa       — (Author, 2020) markers, alphabetical list, APA 7th edition shape
//   nature    — superscript-style numeric markers, abbreviated Nature reference shape
// The formatter never invents missing fields: an absent year prints as "n.d.",
// absent authors fall back to the container or title, and every entry keeps the
// canonical URI so a reviewer can resolve it.

export type BibliographyStyle = "numeric" | "apa" | "nature";

export interface BibliographyEntryInput {
  locator: string;
  ordinal: number;
  title: string;
  authors: string[];
  year: number | null;
  containerTitle: string | null;
  publisher: string | null;
  canonicalUri: string;
  kind: string;
  /** DOI extracted from the canonical URI when it is a doi.org link or a bare DOI. */
  doi: string | null;
  /** Set when the binding could not be resolved to a source; rendered honestly as unresolved. */
  unresolved?: boolean;
}

export interface FormattedReference {
  locator: string;
  ordinal: number;
  /** Plain text without markup (used by DOCX and LaTeX after escaping). */
  text: string;
  /** Minimal HTML with <i> for container/title italics. */
  html: string;
  /** BibTeX entry. */
  bibtex: string;
  /** In-text marker for this style, e.g. "[3]", "(Kim et al., 2021)". */
  marker: string;
  key: string;
}

export function extractDoi(canonicalUri: string): string | null {
  const match = /(?:doi\.org\/|^doi:\s*|^)(10\.\d{4,9}\/[^\s"<>]+)/i.exec(canonicalUri.trim());
  return match ? match[1].replace(/[.,;]+$/, "") : null;
}

function splitName(author: string): { family: string; given: string } {
  const trimmed = author.trim();
  if (!trimmed) return { family: "", given: "" };
  if (trimmed.includes(",")) {
    const [family, given = ""] = trimmed.split(",").map((part) => part.trim());
    return { family, given };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: "" };
  // CJK names are usually written family-first without a comma.
  if (/^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(parts[0]) && parts.length === 2 && parts[1].length <= 2) {
    return { family: parts[0], given: parts[1] };
  }
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(" ") };
}

function initials(given: string, withPeriods: boolean): string {
  return given.split(/[\s.-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + (withPeriods ? "." : "")).join(withPeriods ? " " : "");
}

function authorListApa(authors: string[]): string {
  const names = authors.map((author) => { const { family, given } = splitName(author); return given ? `${family}, ${initials(given, true)}` : family; });
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
}

function authorListVancouver(authors: string[]): string {
  const names = authors.map((author) => { const { family, given } = splitName(author); return given ? `${family} ${initials(given, false)}` : family; });
  if (!names.length) return "";
  if (names.length <= 6) return names.join(", ");
  return `${names.slice(0, 6).join(", ")}, et al.`;
}

function authorListNature(authors: string[]): string {
  const names = authors.map((author) => { const { family, given } = splitName(author); return given ? `${family}, ${initials(given, true)}` : family; });
  if (!names.length) return "";
  if (names.length > 5) return `${names[0]} et al.`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function markerApa(entry: BibliographyEntryInput): string {
  const year = entry.year ?? "n.d.";
  if (!entry.authors.length) return `(${truncate(entry.containerTitle ?? entry.title, 40)}, ${year})`;
  const families = entry.authors.map((author) => splitName(author).family);
  if (families.length === 1) return `(${families[0]}, ${year})`;
  if (families.length === 2) return `(${families[0]} & ${families[1]}, ${year})`;
  return `(${families[0]} et al., ${year})`;
}

function truncate(value: string, maximum: number): string { return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value; }

function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function bibtexKey(entry: BibliographyEntryInput): string {
  const family = entry.authors.length ? splitName(entry.authors[0]).family : (entry.containerTitle ?? "source");
  const base = `${family}${entry.year ?? "nd"}`.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "ref";
  return `${base}-${entry.ordinal}`;
}

function bibtexEntry(entry: BibliographyEntryInput, key: string): string {
  const escape = (value: string) => value.replace(/[{}]/g, "").replace(/([&%$#_])/g, "\\$1");
  const type = entry.kind === "dataset" ? "misc" : entry.kind === "book" ? "book" : entry.containerTitle ? "article" : "misc";
  const fields: string[] = [`  title = {${escape(entry.title)}}`];
  if (entry.authors.length) fields.push(`  author = {${entry.authors.map((author) => { const { family, given } = splitName(author); return given ? `${escape(family)}, ${escape(given)}` : escape(family); }).join(" and ")}}`);
  if (entry.year !== null) fields.push(`  year = {${entry.year}}`);
  if (entry.containerTitle) fields.push(`  ${type === "book" ? "publisher" : "journal"} = {${escape(entry.containerTitle)}}`);
  if (entry.publisher && type !== "book") fields.push(`  publisher = {${escape(entry.publisher)}}`);
  if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
  if (!entry.doi && entry.canonicalUri) fields.push(`  url = {${entry.canonicalUri}}`);
  fields.push(`  note = {Agentlas source locator ${entry.locator}}`);
  return `@${type}{${key},\n${fields.join(",\n")}\n}`;
}

export function formatReference(entry: BibliographyEntryInput, style: BibliographyStyle): FormattedReference {
  const key = bibtexKey(entry);
  const year = entry.year === null ? "n.d." : String(entry.year);
  const doiText = entry.doi ? `https://doi.org/${entry.doi}` : entry.canonicalUri;
  if (entry.unresolved) {
    const text = `[Unresolved citation binding "${entry.locator}"]`;
    return { locator: entry.locator, ordinal: entry.ordinal, text, html: escapeHtml(text), bibtex: `% unresolved ${entry.locator}`, marker: style === "apa" ? `(${entry.locator}, n.d.)` : `[${entry.ordinal}]`, key };
  }
  let text: string;
  let html: string;
  let marker: string;
  if (style === "apa") {
    const authors = authorListApa(entry.authors);
    const head = authors ? `${authors} (${year}). ` : `${entry.title}. (${year}). `;
    const titlePart = authors ? `${entry.title}. ` : "";
    const container = entry.containerTitle ? `${entry.containerTitle}. ` : "";
    const publisher = entry.publisher && entry.publisher !== entry.containerTitle ? `${entry.publisher}. ` : "";
    text = `${head}${titlePart}${container}${publisher}${doiText}`.trim();
    html = `${escapeHtml(head)}${escapeHtml(titlePart)}${entry.containerTitle ? `<i>${escapeHtml(entry.containerTitle)}</i>. ` : ""}${escapeHtml(publisher)}${escapeHtml(doiText)}`;
    marker = markerApa(entry);
  } else if (style === "nature") {
    const authors = authorListNature(entry.authors);
    const container = entry.containerTitle ? `${entry.containerTitle} ` : "";
    text = `${authors ? `${authors} ` : ""}${entry.title}. ${container}(${year}). ${doiText}`.replace(/\s+/g, " ").trim();
    html = `${escapeHtml(authors ? `${authors} ` : "")}${escapeHtml(entry.title)}. ${entry.containerTitle ? `<i>${escapeHtml(entry.containerTitle)}</i> ` : ""}(${year}). ${escapeHtml(doiText)}`;
    marker = `${entry.ordinal}`;
  } else {
    const authors = authorListVancouver(entry.authors);
    const container = entry.containerTitle ? `${entry.containerTitle}. ` : "";
    const publisher = entry.publisher && !entry.containerTitle ? `${entry.publisher}; ` : "";
    text = `${authors ? `${authors}. ` : ""}${entry.title}. ${container}${publisher}${year}. ${doiText}`.replace(/\s+/g, " ").trim();
    html = `${escapeHtml(authors ? `${authors}. ` : "")}${escapeHtml(entry.title)}. ${entry.containerTitle ? `<i>${escapeHtml(entry.containerTitle)}</i>. ` : ""}${escapeHtml(publisher)}${year}. ${escapeHtml(doiText)}`;
    marker = `[${entry.ordinal}]`;
  }
  return { locator: entry.locator, ordinal: entry.ordinal, text, html, bibtex: bibtexEntry(entry, key), marker, key };
}

/** Orders references the way the style expects: citation order for numeric styles, alphabetical for APA. */
export function orderReferences(entries: BibliographyEntryInput[], style: BibliographyStyle): BibliographyEntryInput[] {
  if (style !== "apa") return [...entries].sort((left, right) => left.ordinal - right.ordinal);
  return [...entries].sort((left, right) => {
    const leftKey = `${left.authors.length ? splitName(left.authors[0]).family : left.title} ${left.year ?? 9999}`.toLowerCase();
    const rightKey = `${right.authors.length ? splitName(right.authors[0]).family : right.title} ${right.year ?? 9999}`.toLowerCase();
    return leftKey.localeCompare(rightKey, "en");
  });
}

/** Marker for an in-text citation that may group several sources: "[1, 3]" or "(Kim, 2020; Lee et al., 2021)". */
export function citationMarker(entries: BibliographyEntryInput[], style: BibliographyStyle): string {
  if (!entries.length) return "[?]";
  if (style === "apa") return `(${entries.map((entry) => markerApa(entry).slice(1, -1)).join("; ")})`;
  const ordinals = [...new Set(entries.map((entry) => entry.ordinal))].sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = ordinals[0];
  let previous = ordinals[0];
  const flush = () => {
    if (start === previous) ranges.push(String(start));
    else if (previous === start + 1) ranges.push(String(start), String(previous));
    else ranges.push(`${start}–${previous}`);
  };
  for (const value of ordinals.slice(1)) {
    if (value === previous + 1) { previous = value; continue; }
    flush();
    start = value; previous = value;
  }
  flush();
  return style === "nature" ? ranges.join(",") : `[${ranges.join(", ")}]`;
}
