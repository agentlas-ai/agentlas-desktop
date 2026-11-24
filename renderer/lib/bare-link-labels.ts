// 개인 에이전트 답의 주소 링크를 "사이트 이름" 글로 보이는 규칙. 정본은 폰의
// mobile/app/lib/features/chat/agentlas_markdown.dart 의 bareLinkLabelsFor / relabelAddressLinks — 같은 규칙, 같은 입력, 같은 기대.
//  - 보이는 글 = 호스트 이름(앞의 www. 제거). 가는 곳(href)과 title(전체 주소)은 바뀌지 않는다.
//  - 글이 주소 자체이거나 비어 있는 링크도 호스트로. 글이 다른 주소인 척하는 링크는 실제 가는 곳의 호스트로.
//  - 한 답에 같은 호스트의 서로 다른 주소가 둘 이상이면 `호스트/경로 마지막 조각`(24자 넘으면 말줄임).
// 이 파일은 화면 글만 정한다(읽기·저장·IPC 없음).

/** 렌더러(Markdown.tsx inline())의 맨 주소 규칙과 같은 글자 규칙 — 끝의 문장부호는 주소에서 뺀다. */
const ADDRESS_OR_LINK = /(?<!!)\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/giu;

export function isAddressLinkLabel(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || /^(?:https?:\/\/|www\.)/iu.test(trimmed);
}

function cleanHref(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function parseHttp(href: string): URL | null {
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url : null;
  } catch {
    return null;
  }
}

export function siteNameOf(href: string): string | null {
  const url = parseHttp(href);
  if (!url) return null;
  return url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
}

function lastPathPart(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length) return "";
  let part = parts[parts.length - 1];
  try { part = decodeURIComponent(part); } catch { /* 깨진 퍼센트 부호는 있는 그대로 둔다. */ }
  const chars = Array.from(part);
  return chars.length <= 24 ? part : `${chars.slice(0, 23).join("")}…`;
}

/** 코드 펜스·인라인 코드 안의 주소는 링크가 아니다 — 같은 길이의 공백으로 덮는다. */
function withoutCode(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fence: string | null = null;
  const out = lines.map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) fence = null;
      return "";
    }
    if (open) { fence = open[1]; return ""; }
    return line.replace(/`[^`]+`/g, (m) => " ".repeat(m.length));
  });
  return out.join("\n");
}

/**
 * 한 답 안의 "주소로 보이는 링크"의 가는 곳 -> 보일 글.
 * `holdTrailing` : 글이 아직 도착하는 중이면, 끝에 붙어 있는(뒤에 글자가 아직 안 온) 맨 주소는 덜 온 상태일 수 있어
 * 보일 글을 정하지 않고 값 = 주소 자체로 둔다(= 그대로 보임). 호스트가 글자마다 바뀌어 튀지 않게.
 */
export function bareLinkLabelsFor(text: string, options: { holdTrailing?: boolean } = {}): Map<string, string> {
  const scanned = withoutCode(text);
  if (!scanned.includes("http") && !scanned.includes("www.")) return new Map();
  const bySite = new Map<string, Set<string>>();
  const held = new Set<string>();
  // 끝에 붙은 문장부호("…go.")는 아직 주소의 일부일 수 있다 — 그것만 남은 자리도 "끝에 붙어 있다"로 본다.
  const end = scanned.trimEnd().replace(/[.,;:!?)\]]+$/u, "").length;
  for (const match of scanned.matchAll(ADDRESS_OR_LINK)) {
    const bare = match[3] !== undefined;
    const label = bare ? match[3] : match[1];
    const href = cleanHref(bare ? match[3] : match[2]);
    if (!isAddressLinkLabel(label)) continue;
    const site = siteNameOf(href);
    if (!site) continue;
    if (bare && options.holdTrailing && (match.index ?? 0) + match[0].length >= end) { held.add(href); continue; }
    if (!bySite.has(site)) bySite.set(site, new Set());
    bySite.get(site)!.add(href);
  }
  const labels = new Map<string, string>();
  for (const [site, hrefs] of bySite) {
    for (const href of hrefs) {
      const url = parseHttp(href)!;
      const part = hrefs.size > 1 ? lastPathPart(url) : "";
      labels.set(href, part ? `${site}/${part}` : site);
    }
  }
  for (const href of held) if (!labels.has(href)) labels.set(href, href);
  return labels;
}

/** 링크 하나의 보일 글. 주소로 보이는 글이 아니면, 또는 가는 곳이 http(s)가 아니면 원래 글 그대로. */
export function shownLinkLabel(label: string, href: string, labels: ReadonlyMap<string, string> | null | undefined): string {
  if (!labels || !isAddressLinkLabel(label)) return label;
  const clean = cleanHref(href);
  const site = siteNameOf(clean);
  if (!site) return label;
  const shown = labels.get(clean) ?? site;
  return shown === clean ? label : shown;
}

/** 같은 내용이면 이전 지도를 그대로 돌려준다 — memo 된 조각이 글자 하나마다 깨지지 않게. */
export function stableLabels(previous: ReadonlyMap<string, string> | null, next: Map<string, string>): ReadonlyMap<string, string> {
  if (previous && previous.size === next.size) {
    let same = true;
    for (const [key, value] of next) if (previous.get(key) !== value) { same = false; break; }
    if (same) return previous;
  }
  return next;
}
