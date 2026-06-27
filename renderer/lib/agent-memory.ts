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

export function parseMemoryMarkdown(content: string): ParsedMemory {
  const decisions: MemoryItem[] = [];
  const gotchas: MemoryItem[] = [];
  const openQuestions: { id: string; title: string; content: string }[] = [];

  const lines = content.split("\n");
  let currentSection: "decisions" | "gotchas" | "open" | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Decisions") || trimmed.startsWith("## 의사결정") || trimmed.toLowerCase().includes("decisions")) {
      currentSection = "decisions";
      continue;
    } else if (trimmed.startsWith("## Gotchas") || trimmed.startsWith("## 주의사항") || trimmed.toLowerCase().includes("gotchas")) {
      currentSection = "gotchas";
      continue;
    } else if (trimmed.startsWith("## Open") || trimmed.startsWith("## 미결") || trimmed.toLowerCase().includes("open")) {
      currentSection = "open";
      continue;
    } else if (trimmed.startsWith("##")) {
      currentSection = null;
      continue;
    }

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

const DEFAULT_MEMORY_HEADER =
  "# Agentlas Agent Memory\n\n이 에이전트가 다음 호출에서도 유지해야 할 결정, 주의사항, 미결 과제를 적는다. 프로젝트별 휘발 상태는 해당 프로젝트 컨텍스트에 둔다.\n\n";

export function serializeMemoryMarkdown(
  decisions: MemoryItemLike[],
  gotchas: MemoryItemLike[],
  openQuestions: MemoryItemLike[],
  opts?: { header?: string }
): string {
  const line = (item: MemoryItemLike) => {
    let s = `- **${item.title}**: ${item.content}`;
    if (item.synced) s += ` <!--agentlas:synced-->`;
    if (item.enabled === false) s += ` <!--agentlas:disabled-->`;
    return s + `\n`;
  };

  let md = opts?.header ?? DEFAULT_MEMORY_HEADER;
  md += `## Decisions\n\n`;
  decisions.forEach((item) => { md += line(item); });
  md += `\n## Gotchas\n\n`;
  gotchas.forEach((item) => { md += line(item); });
  md += `\n## Open\n\n`;
  openQuestions.forEach((item) => { md += line(item); });
  return md;
}
