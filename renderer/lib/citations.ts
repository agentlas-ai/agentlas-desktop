// 결정적 인용/참고문헌 엔진 — 순수 함수(LLM·네트워크 없음). 5개 스타일 지원.
// 구조화 Reference[] → 인라인 인용 문자열 + 참고문헌 목록(markdown). 격리 하네스로 유닛 검증.
// 참고: APA=저자-연도/References, MLA=Works Cited, Chicago(author-date)=Bibliography,
//       IEEE=[n] 숫자순, Harvard=저자-연도/References.

export type ReferenceType = "article" | "book" | "web" | "report" | "chapter";
export type CitationStyle = "APA" | "MLA" | "Chicago" | "IEEE" | "Harvard";

export const CITATION_STYLES: CitationStyle[] = ["APA", "MLA", "Chicago", "IEEE", "Harvard"];

export interface Reference {
  id: string;
  type: ReferenceType;
  authors: string[]; // "Last, First" 또는 "First Last" 자유 입력 — 파서가 정규화.
  title: string;
  year: string;
  container?: string; // 저널/웹사이트/수록서명
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  url?: string;
  doi?: string;
}

interface Name {
  family: string;
  given: string;
}

// "Last, First M." / "First M. Last" / "Last" 모두 처리.
function parseName(raw: string): Name {
  const s = (raw || "").trim();
  if (!s) return { family: "", given: "" };
  if (s.includes(",")) {
    const [family, given = ""] = s.split(",").map((x) => x.trim());
    return { family, given };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: "" };
  const family = parts[parts.length - 1];
  return { family, given: parts.slice(0, -1).join(" ") };
}

// "John Michael" → "J. M."
function initials(given: string): string {
  return (given || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `${tok[0].toUpperCase()}.`)
    .join(" ");
}

const italic = (s: string) => (s ? `*${s}*` : "");
const dropTrailingDot = (s: string) => s.replace(/\.\s*$/, "");
const ensureDot = (s: string) => (/[.?!]\s*$/.test(s) ? s.trim() : `${s.trim()}.`);
const clean = (parts: (string | undefined | false)[]) => parts.filter((p): p is string => Boolean(p && p.trim()));

function doiUrl(ref: Reference): string | undefined {
  if (ref.doi) return `https://doi.org/${ref.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`;
  return ref.url;
}

function volIssuePages(ref: Reference, style: CitationStyle): string {
  const v = ref.volume?.trim();
  const i = ref.issue?.trim();
  const p = ref.pages?.trim();
  if (style === "IEEE") {
    return clean([v && `vol. ${v}`, i && `no. ${i}`, p && `pp. ${p}`]).join(", ");
  }
  if (style === "MLA") {
    return clean([v && `vol. ${v}`, i && `no. ${i}`]).join(", ");
  }
  // APA/Chicago/Harvard: Volume(Issue), pages
  const vi = v ? `${v}${i ? `(${i})` : ""}` : "";
  return vi;
}

// ─────────────────────────── 저자 목록 포맷 ───────────────────────────

// APA/Harvard: "Family, F. M." (이니셜). APA=serial comma, Harvard=no serial comma.
function authorsInitialFamily(authors: string[], amp: "&" | "and", oxford: boolean): string {
  const people = authors.map(parseName).filter((p) => p.family);
  const parts = people.map((p) => (p.given ? `${p.family}, ${initials(p.given)}` : p.family));
  return joinList(parts, amp, oxford);
}

// 독립 저작(book/report)=이탤릭 제목, 부분 저작(article/web/chapter)=인용부호.
// APA만 webpage도 이탤릭(독립 저작 취급), article/chapter는 무장식.
function isStandaloneWork(type: ReferenceType): boolean {
  return type === "book" || type === "report";
}

// IEEE: "F. M. Family" (이니셜 먼저).
function authorsInitialsFirst(authors: string[]): string {
  const people = authors.map(parseName).filter((p) => p.family);
  const parts = people.map((p) => (p.given ? `${initials(p.given)} ${p.family}` : p.family));
  if (parts.length >= 7) return `${parts[0]} et al.`;
  return joinList(parts, "and", false);
}

// MLA: 첫 저자 "Family, Given", 이후 "Given Family"; 3+ = "et al."
function authorsMLA(authors: string[]): string {
  const people = authors.map(parseName).filter((p) => p.family);
  if (people.length === 0) return "";
  const first = people[0].given ? `${people[0].family}, ${people[0].given}` : people[0].family;
  if (people.length === 1) return first;
  if (people.length >= 3) return `${first}, et al.`;
  const second = people[1].given ? `${people[1].given} ${people[1].family}` : people[1].family;
  return `${first}, and ${second}`;
}

// Chicago(author-date): 첫 저자 "Family, Given", 이후 "Given Family". serial comma 사용.
function authorsChicago(authors: string[]): string {
  const people = authors.map(parseName).filter((p) => p.family);
  if (people.length === 0) return "";
  const first = people[0].given ? `${people[0].family}, ${people[0].given}` : people[0].family;
  const rest = people.slice(1).map((p) => (p.given ? `${p.given} ${p.family}` : p.family));
  return joinList([first, ...rest], "and", true);
}

// 목록 결합: oxfordComma=true면 3+에서 마지막 앞에 콤마(APA).
function joinList(parts: string[], conj: "&" | "and", oxfordComma: boolean): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]}${oxfordComma ? "," : ""} ${conj} ${parts[1]}`;
  const head = parts.slice(0, -1).join(", ");
  return `${head}${oxfordComma ? "," : ""} ${conj} ${parts[parts.length - 1]}`;
}

// ─────────────────────────── 참고문헌 항목 ───────────────────────────

export function formatReference(ref: Reference, style: CitationStyle): string {
  const year = ref.year?.trim() || "n.d.";
  const title = ref.title?.trim() || "Untitled";
  const container = ref.container?.trim();
  const link = doiUrl(ref);
  const vip = volIssuePages(ref, style);
  const pages = ref.pages?.trim();

  switch (style) {
    case "APA": {
      const auth = authorsInitialFamily(ref.authors, "&", true);
      // APA: book/report/web 제목 이탤릭(독립 저작), article/chapter 무장식.
      const apaItalicTitle = ref.type === "book" || ref.type === "report" || ref.type === "web";
      const containerPart =
        ref.type === "article" && container
          ? `${italic(container)}${vip ? `, ${vip}` : ""}${pages ? `, ${pages}` : ""}`
          : italic(container || "") || (ref.publisher ?? "");
      return clean([
        auth && ensureDot(auth),
        `(${year}).`,
        apaItalicTitle ? ensureDot(italic(title)) : ensureDot(title),
        containerPart && ensureDot(containerPart),
        link,
      ]).join(" ");
    }
    case "Harvard": {
      const auth = authorsInitialFamily(ref.authors, "and", false);
      const containerPart = clean([
        italic(container || ""),
        vip,
        pages && `pp. ${pages}`,
      ]).join(", ");
      return clean([
        auth,
        `(${year})`,
        isStandaloneWork(ref.type) ? `${italic(title)}.` : `'${dropTrailingDot(title)}',`,
        containerPart && `${containerPart}.`,
        link && `Available at: ${link}.`,
      ]).join(" ");
    }
    case "MLA": {
      const auth = authorsMLA(ref.authors);
      const containerPart = clean([
        italic(container || ""),
        vip,
        year,
        pages && `pp. ${pages}`,
      ]).join(", ");
      return clean([
        auth && ensureDot(auth),
        isStandaloneWork(ref.type) ? `${italic(title)}.` : `"${ensureDot(title)}"`,
        containerPart && ensureDot(containerPart),
        link && ensureDot(link),
      ]).join(" ");
    }
    case "Chicago": {
      const auth = authorsChicago(ref.authors);
      const containerPart =
        ref.type === "article"
          ? clean([italic(container || ""), vip && `${vip}${pages ? `: ${pages}` : ""}`]).join(" ")
          : clean([ref.publisher]).join(" ");
      return clean([
        auth && ensureDot(auth),
        `${year}.`,
        isStandaloneWork(ref.type) ? `${italic(title)}.` : `"${ensureDot(title)}"`,
        containerPart && ensureDot(containerPart),
        link,
      ]).join(" ");
    }
    case "IEEE": {
      const auth = authorsInitialsFirst(ref.authors);
      const containerPart = clean([
        ref.type === "article" ? italic(container || "") : ref.publisher,
        vip,
      ]).join(", ");
      return clean([
        auth && `${dropTrailingDot(auth)},`,
        isStandaloneWork(ref.type) ? `${italic(title)}.` : `"${dropTrailingDot(title)},"`,
        containerPart && `${containerPart},`,
        `${year}.`,
      ]).join(" ");
    }
  }
}

// ─────────────────────────── 인라인 인용 ───────────────────────────

function firstFamily(ref: Reference): string {
  return parseName(ref.authors[0] || "").family || ref.title?.trim() || "Anon";
}

export function formatInline(ref: Reference, style: CitationStyle, allRefs: Reference[] = []): string {
  const year = ref.year?.trim() || "n.d.";
  const people = ref.authors.map(parseName).filter((p) => p.family);
  const fam = firstFamily(ref);

  switch (style) {
    case "IEEE": {
      const list = allRefs.length ? allRefs : [ref];
      const idx = orderedForIeee(list).findIndex((r) => r.id === ref.id);
      return idx < 0 ? "[?]" : `[${idx + 1}]`; // 목록에 없으면 [1] 충돌 대신 미지수 표시.
    }
    case "MLA":
      return ref.pages ? `(${fam} ${ref.pages})` : `(${fam})`;
    case "Chicago":
      return `(${authorTag(people, fam)} ${year})`;
    case "APA":
    case "Harvard":
    default:
      return `(${authorTag(people, fam)}, ${year})`;
  }
}

// 인라인 저자 표기: 1명=Family, 2명=Family & Family2, 3+=Family et al.
function authorTag(people: Name[], fam: string): string {
  if (people.length <= 1) return fam;
  if (people.length === 2) return `${people[0].family} & ${people[1].family}`;
  return `${people[0].family} et al.`;
}

// IEEE는 참고문헌 목록 순서(등장/알파)를 번호로 쓴다 — 여기선 입력 순서 유지.
function orderedForIeee(refs: Reference[]): Reference[] {
  return refs;
}

// ─────────────────────────── 참고문헌 블록(markdown) ───────────────────────────

export function bibliographyTitle(style: CitationStyle): string {
  if (style === "MLA") return "Works Cited";
  if (style === "Chicago") return "Bibliography";
  return "References"; // APA / IEEE / Harvard
}

export function buildBibliography(refs: Reference[], style: CitationStyle): string {
  if (!refs.length) return "";
  const title = `## ${bibliographyTitle(style)}`;
  if (style === "IEEE") {
    const lines = orderedForIeee(refs).map((r, i) => `[${i + 1}] ${formatReference(r, style)}`);
    return `${title}\n\n${lines.join("\n\n")}`;
  }
  // 알파벳(첫 저자 family) 정렬.
  const sorted = [...refs].sort((a, b) => firstFamily(a).localeCompare(firstFamily(b)));
  const lines = sorted.map((r) => formatReference(r, style));
  return `${title}\n\n${lines.join("\n\n")}`;
}
