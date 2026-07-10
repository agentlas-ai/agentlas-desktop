// 에이전트/회사 메모리(markdown)의 단일 파서·직렬화기.
// library/agents 와 firm/detail 이 각자 복제하던 로직을 여기로 통합한다 — 버그(예: synced 무작위
// 부여, 상태 미직렬화로 새로고침 리셋)와 설계가 두 곳에서 갈라지지 않게 하기 위함.
//
// 핵심 규율: synced/enabled 는 본문 끝의 보이지 않는 HTML 주석 마커로 디스크에 왕복(round-trip)된다.
// 마커가 없으면 보수적 기본값(synced=false 로컬전용, enabled=true 활성)을 적용한다 — 무작위/추측 금지.

export interface MemoryItem {
  id: string;
  title: string;
  content: string;
  synced?: boolean;
  enabled?: boolean;
}

export interface ParsedMemory {
  decisions: MemoryItem[];
  gotchas: MemoryItem[];
  openQuestions: { id: string; title: string; content: string }[];
}

export type MemoryItemLike = { title: string; content: string; synced?: boolean; enabled?: boolean };

/** 메모리 항목 본문에서 상태 마커를 추출하고, 사람이 읽는 본문만 남긴다. */
export function extractMemoryFlags(raw: string): { body: string; synced: boolean; enabled: boolean } {
  const synced = /<!--\s*agentlas:synced\s*-->/.test(raw);
  const disabled = /<!--\s*agentlas:disabled\s*-->/.test(raw);
  const body = raw.replace(/<!--\s*agentlas:(synced|disabled)\s*-->/g, "").trim();
  return { body, synced, enabled: !disabled };
}

/** 재파싱마다 id 가 바뀌어 토글이 풀리는 것을 막는 결정적 슬러그. */
export function memorySlugId(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  );
}

type KnownMemorySection = "decisions" | "gotchas" | "open";

type MarkdownLine = { text: string; eol: string; raw: string };

function splitMarkdownLines(value: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match[0] === "" && pattern.lastIndex === value.length) break;
    lines.push({ text: match[1], eol: match[2], raw: match[0] });
    if (match[2] === "") break;
  }
  return lines;
}

type MarkdownFence = { marker: "`" | "~"; length: number } | null;

function advanceFence(line: string, current: MarkdownFence): MarkdownFence {
  if (current) {
    const escaped = current.marker === "`" ? "`" : "~";
    const closing = new RegExp(`^ {0,3}${escaped}{${current.length},}\\s*$`);
    return closing.test(line) ? null : current;
  }
  const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!opening) return null;
  return { marker: opening[1][0] as "`" | "~", length: opening[1].length };
}

function levelTwoHeading(line: string): string | null {
  const trimmed = line.trim();
  return /^##(?!#)(?:\s+|$)/.test(trimmed) ? trimmed : null;
}

function scanLevelTwoHeadings(lines: MarkdownLine[]): Array<{ index: number; kind: KnownMemorySection | null }> {
  const headings: Array<{ index: number; kind: KnownMemorySection | null }> = [];
  let fence: MarkdownFence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const before = fence;
    fence = advanceFence(lines[index].text, fence);
    if (before || fence) continue;
    const heading = levelTwoHeading(lines[index].text);
    if (heading) headings.push({ index, kind: knownMemoryHeading(heading) });
  }
  return headings;
}

function knownMemoryHeading(value: string): KnownMemorySection | null {
  const heading = value.trim();
  if (/^##\s+(?:decisions?|의사결정|결정\s*사항)\s*$/i.test(heading)) return "decisions";
  if (/^##\s+(?:gotchas?|주의\s*사항)\s*$/i.test(heading)) return "gotchas";
  if (/^##\s+(?:open(?:\s+questions?)?|미결(?:\s+(?:과제|항목|질문))?)\s*$/i.test(heading)) return "open";
  return null;
}

export function parseMemoryMarkdown(content: string): ParsedMemory {
  const decisions: MemoryItem[] = [];
  const gotchas: MemoryItem[] = [];
  const openQuestions: { id: string; title: string; content: string }[] = [];

  const lines = splitMarkdownLines(content);
  const headingByLine = new Map(scanLevelTwoHeadings(lines).map((heading) => [heading.index, heading.kind]));
  let currentSection: "decisions" | "gotchas" | "open" | null = null;

  let fence: MarkdownFence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    const before = fence;
    fence = advanceFence(line, fence);
    if (headingByLine.has(index)) {
      currentSection = headingByLine.get(index) ?? null;
      continue;
    }

    // Bullets inside examples are documentation, not durable agent memory.
    if (before || fence) continue;
    const trimmed = line.trim();

    if (currentSection) {
      // Parse: - **Title**: Description
      const bulletMatch =
        trimmed.match(/^-\s+\*\*(.*?)\*\*(?:(?:\s*—\s*)|(?:\s*-\s*)|(?:\s*:\s*)|(?:\s+))(.*)/) ||
        trimmed.match(/^-\s+\*\*(.*?)\*\*(.*)/);

      if (bulletMatch) {
        const title = bulletMatch[1].trim();
        const { body, synced, enabled } = extractMemoryFlags(bulletMatch[2].trim());
        const id = title.replace(/\s+/g, "-").toLowerCase();
        const item: MemoryItem = { id, title, content: body, synced, enabled };
        if (currentSection === "decisions") decisions.push(item);
        else if (currentSection === "gotchas") gotchas.push(item);
        else if (currentSection === "open") openQuestions.push(item);
      } else if (trimmed.startsWith("-")) {
        const { body, synced, enabled } = extractMemoryFlags(trimmed.substring(1).trim());
        if (body) {
          const title = body.substring(0, Math.min(25, body.length)) + "...";
          const seq =
            currentSection === "decisions"
              ? decisions.length
              : currentSection === "gotchas"
                ? gotchas.length
                : openQuestions.length;
          const id = "item-" + memorySlugId(body) + "-" + seq;
          const item: MemoryItem = { id, title, content: body, synced, enabled };
          if (currentSection === "decisions") decisions.push(item);
          else if (currentSection === "gotchas") gotchas.push(item);
          else if (currentSection === "open") openQuestions.push(item);
        }
      }
    }
  }

  return { decisions, gotchas, openQuestions };
}

const DEFAULT_MEMORY_HEADER_KO =
  "# Agentlas Agent Memory\n\n이 에이전트가 다음 호출에서도 유지해야 할 결정, 주의사항, 미결 과제를 적는다. 프로젝트별 휘발 상태는 해당 프로젝트 컨텍스트에 둔다.\n\n";
const DEFAULT_MEMORY_HEADER_EN =
  "# Agentlas Agent Memory\n\nDecisions, gotchas, and open questions this agent should keep across future calls. Project-specific transient state belongs in that project's context.\n\n";

export function serializeMemoryMarkdown(
  decisions: MemoryItemLike[],
  gotchas: MemoryItemLike[],
  openQuestions: MemoryItemLike[],
  opts?: { header?: string; locale?: "ko" | "en"; originalContent?: string }
): string {
  const line = (item: MemoryItemLike) => {
    let s = `- **${item.title}**: ${item.content}`;
    if (item.synced) s += ` <!--agentlas:synced-->`;
    if (item.enabled === false) s += ` <!--agentlas:disabled-->`;
    return s + `\n`;
  };

  const rendered = {
    decisions: decisions.map(line).join(""),
    gotchas: gotchas.map(line).join(""),
    open: openQuestions.map(line).join(""),
  };
  const original = opts?.originalContent;
  if (!original?.trim()) {
    let md = opts?.header ?? (opts?.locale === "en" ? DEFAULT_MEMORY_HEADER_EN : DEFAULT_MEMORY_HEADER_KO);
    md += `## Decisions\n\n${rendered.decisions}`;
    md += `\n## Gotchas\n\n${rendered.gotchas}`;
    md += `\n## Open\n\n${rendered.open}`;
    return md;
  }

  type KnownSection = keyof typeof rendered;

  // Replace only the bodies of the three Agentlas-managed sections. Headers,
  // comments, frontmatter, newline style, and every unknown/custom section stay
  // byte-stable. Fenced code examples are not headings. Duplicate managed
  // sections are removed as a whole so stale bullets cannot re-enter the parser.
  const lines = splitMarkdownLines(original);
  const headings = scanLevelTwoHeadings(lines);
  const newline = lines.find((entry) => entry.eol)?.eol ?? "\n";
  const renderedFor = (kind: KnownSection) => rendered[kind].trimEnd().replace(/\n/g, newline);
  let out = "";
  const seen = new Set<KnownSection>();
  let cursor = 0;
  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const heading = headings[headingIndex];
    const end = headings[headingIndex + 1]?.index ?? lines.length;
    for (let index = cursor; index < heading.index; index += 1) out += lines[index].raw;
    if (!heading.kind) {
      for (let index = heading.index; index < end; index += 1) out += lines[index].raw;
    } else if (!seen.has(heading.kind)) {
      seen.add(heading.kind);
      out += lines[heading.index].text + newline + newline;
      const body = renderedFor(heading.kind);
      if (body) out += body + newline;
    }
    cursor = end;
  }
  for (let index = cursor; index < lines.length; index += 1) out += lines[index].raw;

  const missing: Array<[KnownSection, string]> = [
    ["decisions", "## Decisions"],
    ["gotchas", "## Gotchas"],
    ["open", "## Open"],
  ];
  for (const [kind, heading] of missing) {
    if (seen.has(kind)) continue;
    if (out && !/(?:\r\n|\n|\r)$/.test(out)) out += newline;
    if (out && !out.endsWith(newline + newline)) out += newline;
    out += heading + newline + newline;
    const body = renderedFor(kind);
    if (body) out += body + newline;
  }
  return out;
}

type MemorySaveState = {
  optimistic: ParsedMemory;
  durable: ParsedMemory;
  raw: string;
  revision: number;
  pending: number;
  chain: Promise<void>;
};

export type AgentMemorySaveRequest = {
  agentId: string;
  updater: (previous: ParsedMemory) => ParsedMemory;
  write: (content: string) => Promise<void>;
  locale?: "ko" | "en";
  header?: string;
  onOptimistic?: (next: ParsedMemory) => void;
  onDurable?: (next: ParsedMemory, raw: string) => void;
  onRollback?: (durable: ParsedMemory, error: unknown) => void;
  onPendingChange?: (pending: boolean) => void;
};

/**
 * Per-agent ordered save queue for memory.md.
 *
 * React render timing is deliberately outside the source of truth: every
 * updater is applied synchronously to that agent's latest optimistic snapshot,
 * while writes are serialized against its latest durable raw markdown. A
 * terminal failure rolls back only that agent and only when no newer intent is
 * waiting behind it.
 */
export class AgentMemorySaveQueue {
  private readonly states = new Map<string, MemorySaveState>();

  hydrate(agentId: string, parsed: ParsedMemory, raw: string): ParsedMemory {
    const existing = this.states.get(agentId);
    if (existing?.pending) return existing.optimistic;
    this.states.set(agentId, {
      optimistic: parsed,
      durable: parsed,
      raw,
      revision: existing?.revision ?? 0,
      pending: 0,
      chain: existing?.chain ?? Promise.resolve(),
    });
    return parsed;
  }

  current(agentId: string, fallback: ParsedMemory, raw = ""): ParsedMemory {
    const existing = this.states.get(agentId);
    return existing?.optimistic ?? this.hydrate(agentId, fallback, raw);
  }

  hasPending(agentId: string): boolean {
    return (this.states.get(agentId)?.pending ?? 0) > 0;
  }

  enqueue(request: AgentMemorySaveRequest): { next: ParsedMemory; completion: Promise<void> } {
    const state = this.states.get(request.agentId);
    if (!state) throw new Error(`Memory save queue is not hydrated for ${request.agentId}`);
    const next = request.updater(state.optimistic);
    const revision = ++state.revision;
    state.optimistic = next;
    state.pending += 1;
    request.onOptimistic?.(next);
    request.onPendingChange?.(true);

    const completion = state.chain
      .catch(() => {})
      .then(async () => {
        const serialized = serializeMemoryMarkdown(next.decisions, next.gotchas, next.openQuestions, {
          locale: request.locale,
          header: request.header,
          originalContent: state.raw,
        });
        await request.write(serialized);
        state.raw = serialized;
        state.durable = next;
        request.onDurable?.(next, serialized);
      })
      .catch((error) => {
        if (state.revision === revision) {
          state.optimistic = state.durable;
          request.onRollback?.(state.durable, error);
        }
        throw error;
      })
      .finally(() => {
        state.pending = Math.max(0, state.pending - 1);
        request.onPendingChange?.(state.pending > 0);
      });
    state.chain = completion.catch(() => {});
    return { next, completion };
  }
}
