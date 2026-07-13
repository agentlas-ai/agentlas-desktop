import type { Locale } from "@/lib/i18n";
import type { AgentLearningEvent, AgentLearningEventType } from "@/components/AgentLearningHistory";

type MemoryEntryLike = {
  id: string;
  kind: string;
  content: string;
  confidence: "high" | "medium" | "low";
  createdAt: string;
};

export function formatLearningTime(iso: string, locale: Locale): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return locale === "ko" ? "방금 전" : "just now";
  if (diffMin < 60) return locale === "ko" ? `${diffMin}분 전` : `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return locale === "ko" ? `${diffHour}시간 전` : `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return locale === "ko" ? `${diffDay}일 전` : `${diffDay}d ago`;
  return new Date(ts).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
}

export function memoryKindToEventType(kind: string): AgentLearningEventType {
  const normalized = (kind || "").toLowerCase();
  if (normalized === "decision") return "resolve";
  if (["gotcha", "risk", "conflict"].includes(normalized)) return "evolution";
  if (normalized === "procedure") return "skill";
  return "sync";
}

export function memoryLearningTitle(kind: string, locale: Locale): string {
  const titles: Record<string, [string, string]> = {
    fact: ["확인한 내용을 기억했어요", "Remembered a verified fact"],
    decision: ["새 기준을 기억했어요", "Remembered a new decision"],
    preference: ["사용자 선호를 기억했어요", "Remembered a user preference"],
    risk: ["문제 해결 방법을 배웠어요", "Learned how to solve a problem"],
    gotcha: ["주의할 점을 배웠어요", "Learned an important caution"],
    procedure: ["새 작업 방법을 배웠어요", "Learned a new way to work"],
    hypothesis: ["다음에 확인할 내용을 기록했어요", "Recorded something to verify"],
    evidence: ["참고할 사례를 배웠어요", "Learned from a useful example"],
    deprecation: ["더 이상 쓰지 않을 방법을 기록했어요", "Recorded a retired approach"],
    conflict: ["서로 다른 정보를 발견했어요", "Found conflicting information"],
  };
  const [ko, en] = titles[kind.toLowerCase()] ?? ["새로운 내용을 배웠어요", "Learned something new"];
  return locale === "ko" ? ko : en;
}

function genericMemorySummary(kind: string, locale: Locale): string {
  const summaries: Record<string, [string, string]> = {
    fact: ["작업에서 확인한 내용을 다음에도 참고할 수 있게 기억했습니다.", "Saved a verified detail for future work."],
    decision: ["다음 작업에도 같은 기준을 적용할 수 있게 기억했습니다.", "Saved a decision to apply consistently in future work."],
    preference: ["다음 작업에서 사용자가 선호하는 방식을 반영하도록 기억했습니다.", "Saved the user's preferred way of working for future tasks."],
    risk: ["작업 중 생긴 문제와 해결 방법을 다음에도 활용하도록 기억했습니다.", "Saved a problem and its solution for future work."],
    gotcha: ["같은 실수를 반복하지 않도록 주의할 점을 기억했습니다.", "Saved a caution to avoid repeating the same mistake."],
    procedure: ["다음 작업에 다시 쓸 수 있는 방법을 기억했습니다.", "Saved a reusable method for future work."],
    hypothesis: ["다음 작업에서 확인해야 할 내용을 기록했습니다.", "Recorded something that needs verification in future work."],
    evidence: ["작업 결과에서 다시 참고할 만한 사례를 기억했습니다.", "Saved a useful example from the work result."],
    deprecation: ["문제가 생기지 않도록 더 이상 쓰지 않을 방법을 기록했습니다.", "Recorded an approach that should no longer be used."],
    conflict: ["서로 맞지 않는 정보를 발견해 다음 작업에서 다시 확인하도록 기록했습니다.", "Recorded conflicting information that needs another check."],
  };
  const [ko, en] = summaries[kind.toLowerCase()] ?? ["다음 작업에 도움이 될 내용을 기억했습니다.", "Saved a useful takeaway for future work."];
  return locale === "ko" ? ko : en;
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function looksTechnical(content: string): boolean {
  if (content.length > 220) return true;
  const markers = [
    /https?:\/\//i,
    /wss?:\/\//i,
    /\b(?:connectOverCDP|playwright|websocket|localhost|curl|json|stack|trace|status\d{3}|raw CDP)\b/i,
    /\b[A-Z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\b/,
    /\b(?:error|failed|failure|null|undefined)\b/i,
    /(?:^|\s)[\w.-]+\/[\w./-]+/,
    /[{}\[\]`]|=>|::|\.\w+\(/,
  ];
  return markers.filter((pattern) => pattern.test(content)).length >= 2;
}

export function simpleMemorySummary(kind: string, content: string, locale: Locale): string {
  const normalized = normalizeContent(content);
  if (!normalized || looksTechnical(normalized)) return genericMemorySummary(kind, locale);
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}…`;
}

export function buildMemoryLearningEvent(entry: MemoryEntryLike, locale: Locale): AgentLearningEvent {
  const normalized = normalizeContent(entry.content);
  const desc = simpleMemorySummary(entry.kind, normalized, locale);
  return {
    id: `db-${entry.id}`,
    timestamp: formatLearningTime(entry.createdAt, locale),
    title: memoryLearningTitle(entry.kind, locale),
    desc,
    detail: normalized !== desc ? entry.content.trim() : undefined,
    type: memoryKindToEventType(entry.kind),
    kind: entry.kind,
    confidence: entry.confidence,
  };
}
