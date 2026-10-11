// Pure view logic for the Capabilities popup: filtering, search, grouping, badges and the optimistic toggle.
import type { OneCapabilityDetail, OneCapabilityItem, OneCapabilityKind, OneCapabilitySource, OneCapabilitiesAPI } from "../../shared/one-capabilities";

export type CapabilitySourceFilter = "all" | OneCapabilitySource;
export type CapabilityLocale = "ko" | "en";

/** Rows drawn at once; a source can hold thousands of items. */
export const CAPABILITY_PAGE_SIZE = 100;
export const CAPABILITY_KIND_ORDER: readonly OneCapabilityKind[] = ["skill", "plugin", "hook", "memory", "connector"];
export const CAPABILITY_SOURCE_ORDER: readonly CapabilitySourceFilter[] = ["all", "agentlas", "codex", "claude", "cursor", "grok", "gemini", "copilot"];

const KIND_LABEL: Record<OneCapabilityKind, { ko: string; en: string }> = {
  skill: { ko: "스킬", en: "Skills" },
  plugin: { ko: "플러그인", en: "Plugins" },
  hook: { ko: "훅", en: "Hooks" },
  memory: { ko: "메모리", en: "Memory" },
  connector: { ko: "커넥터", en: "Connectors" },
};
const SOURCE_LABEL: Record<CapabilitySourceFilter, { ko: string; en: string }> = {
  all: { ko: "전체", en: "All" },
  agentlas: { ko: "Agentlas", en: "Agentlas" },
  codex: { ko: "Codex", en: "Codex" },
  claude: { ko: "Claude Code", en: "Claude Code" },
  cursor: { ko: "Cursor", en: "Cursor" },
  grok: { ko: "Grok", en: "Grok" },
  gemini: { ko: "Antigravity", en: "Antigravity" },
  copilot: { ko: "Copilot", en: "Copilot" },
};
const SOURCE_NAME: Record<OneCapabilitySource, string> = { agentlas: "Agentlas", codex: "Codex", claude: "Claude Code", cursor: "Cursor", grok: "Grok", gemini: "Antigravity", copilot: "Copilot" };

export const kindLabel = (kind: OneCapabilityKind, locale: CapabilityLocale): string => KIND_LABEL[kind][locale];
export const sourceLabel = (source: CapabilitySourceFilter, locale: CapabilityLocale): string => SOURCE_LABEL[source][locale];
export const DISABLED_SWITCH_TIP = { ko: "이 런타임에서는 아직 켜고 끌 수 없어요", en: "This runtime cannot turn this on or off yet" } as const;

/** Personal sources read "개인"; the built-ins read "Agentlas". The source name rides along for the personal ones. */
export function sourceBadge(source: OneCapabilitySource, locale: CapabilityLocale): { label: string; personal: boolean } {
  if (source === "agentlas") return { label: "Agentlas", personal: false };
  return { label: `${locale === "ko" ? "개인" : "Personal"} · ${SOURCE_NAME[source]}`, personal: true };
}

export interface CapabilityFilter { kind: OneCapabilityKind; source: CapabilitySourceFilter; query: string }

const norm = (value: string): string => value.normalize("NFKC").toLocaleLowerCase();

export const capabilityTitle = (item: Pick<OneCapabilityItem, "name" | "title">): string => item.title || item.name;

export function matchesQuery(item: Pick<OneCapabilityItem, "name" | "title" | "description">, query: string): boolean {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = norm(`${item.name} ${item.title ?? ""} ${item.description}`);
  return terms.every((term) => hay.includes(term));
}

/** Items of one kind, narrowed by source and search, enabled first then by name. */
export function filterCapabilities(items: readonly OneCapabilityItem[], filter: CapabilityFilter): OneCapabilityItem[] {
  return items
    .filter((item) => item.kind === filter.kind && (filter.source === "all" || item.source === filter.source) && matchesQuery(item, filter.query))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || capabilityTitle(a).localeCompare(capabilityTitle(b)));
}

/** Left-nav counts: how many items each kind has under the current source filter (search is not applied). */
export function kindCounts(items: readonly OneCapabilityItem[], source: CapabilitySourceFilter): Record<OneCapabilityKind, number> {
  const counts: Record<OneCapabilityKind, number> = { skill: 0, plugin: 0, hook: 0, memory: 0, connector: 0 };
  for (const item of items) if (source === "all" || item.source === source) counts[item.kind] += 1;
  return counts;
}

/** Source-chip counts for one kind. */
export function sourceCounts(items: readonly OneCapabilityItem[], kind: OneCapabilityKind): Record<CapabilitySourceFilter, number> {
  const counts: Record<CapabilitySourceFilter, number> = { all: 0, agentlas: 0, codex: 0, claude: 0, cursor: 0, grok: 0, gemini: 0, copilot: 0 };
  for (const item of items) if (item.kind === kind) { counts.all += 1; counts[item.source] += 1; }
  return counts;
}

export const setItemEnabled = (items: readonly OneCapabilityItem[], id: string, enabled: boolean): OneCapabilityItem[] =>
  items.map((item) => (item.id === id ? { ...item, enabled } : item));

/**
 * Flip one switch. The row changes at once; the answer from Main replaces it, and a refusal puts it back.
 * Items that cannot be enforced yet (applies: false) are never sent.
 */
export async function toggleCapability(
  api: Pick<OneCapabilitiesAPI, "setEnabled"> | null | undefined,
  items: readonly OneCapabilityItem[],
  id: string,
  enabled: boolean,
  commit: (next: OneCapabilityItem[]) => void,
): Promise<{ ok: boolean }> {
  const current = items.find((item) => item.id === id);
  if (!api || !current || !current.applies || current.enabled === enabled) return { ok: false };
  let latest = setItemEnabled(items, id, enabled);
  commit(latest);
  try {
    const saved = await api.setEnabled({ id, enabled });
    if (!saved) throw new Error("capability_missing");
    latest = latest.map((item) => (item.id === id ? { ...item, ...saved } : item));
    commit(latest);
    return { ok: true };
  } catch {
    commit(latest.map((item) => (item.id === id ? { ...item, enabled: current.enabled } : item)));
    return { ok: false };
  }
}

export const detailIsMarkdown = (detail: Pick<OneCapabilityDetail, "path" | "kind">): boolean =>
  /\.(md|markdown|mdc)$/i.test(detail.path) || (detail.kind === "memory" && !/\.(json|toml|ya?ml)$/i.test(detail.path));

export function itemEnabledTotals(items: readonly OneCapabilityItem[]): { enabled: number; total: number } {
  return { enabled: items.filter((item) => item.enabled).length, total: items.length };
}
