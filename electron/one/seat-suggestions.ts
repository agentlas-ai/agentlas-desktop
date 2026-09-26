import fs from "node:fs";
import path from "node:path";
import { getAgentById } from "../mcp/registry";
import type { OneSeatSuggestion } from "../../shared/one-org";

/*
 * 좌석 에이전트의 새 세션 추천 작업 (오너 2026-09-26).
 *
 * 추천은 **그 에이전트 패키지가 스스로 선언한 프롬프트**에서만 온다. 제품이 이름·설명을
 * 보고 지어내지 않는다 — 없으면 빈 목록이고, 화면은 블록을 그리지 않는다.
 *
 * 읽는 자리(플러그인 명세 surface.defaultPrompts 와 같은 뜻: "입력창에 그대로 채우는 문장"):
 *   agentlas.json          surface.defaultPrompts · defaultPrompts · publicProfile.defaultPrompts
 *   .codex-plugin/plugin.json / plugin.json   surface.defaultPrompts · interface.defaultPrompt(s)
 * 항목은 문자열이거나 { prompt, title?, titleKo?, titleEn?, description?, descriptionKo?, descriptionEn? }.
 */
const MAX_SUGGESTIONS = 3;
const MAX_MANIFEST_BYTES = 512_000;
const MAX_PROMPT = 2_000;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 200;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL.test(trimmed)) return "";
  return trimmed;
}

/** 문자열 프롬프트의 제목 — 첫 줄의 첫 문장, 길면 자른다. */
function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0] ?? prompt;
  const sentence = firstLine.split(/(?<=[.!?。])\s/u)[0] ?? firstLine;
  return sentence.length > 60 ? `${sentence.slice(0, 59).trimEnd()}…` : sentence;
}

function normalize(entry: unknown, index: number): OneSeatSuggestion | null {
  if (typeof entry === "string") {
    const prompt = text(entry, MAX_PROMPT);
    if (!prompt) return null;
    const title = titleFromPrompt(prompt);
    return { id: `prompt-${index}`, prompt, title: { ko: title, en: title }, description: null };
  }
  const item = record(entry);
  if (!item) return null;
  const prompt = text(item.prompt, MAX_PROMPT);
  if (!prompt) return null;
  const baseTitle = text(item.title, MAX_TITLE) || titleFromPrompt(prompt);
  const baseDescription = text(item.description, MAX_DESCRIPTION);
  const descriptionKo = text(item.descriptionKo, MAX_DESCRIPTION) || baseDescription;
  const descriptionEn = text(item.descriptionEn, MAX_DESCRIPTION) || baseDescription;
  return {
    id: `prompt-${index}`,
    prompt,
    title: {
      ko: text(item.titleKo, MAX_TITLE) || baseTitle,
      en: text(item.titleEn, MAX_TITLE) || baseTitle,
    },
    description: descriptionKo || descriptionEn ? { ko: descriptionKo || descriptionEn, en: descriptionEn || descriptionKo } : null,
  };
}

function declaredLists(root: string): unknown[][] {
  const agentlas = readJson(path.join(root, "agentlas.json"));
  const plugin = readJson(path.join(root, ".codex-plugin", "plugin.json")) ?? readJson(path.join(root, "plugin.json"));
  const lists = [
    record(agentlas?.surface)?.defaultPrompts,
    agentlas?.defaultPrompts,
    record(agentlas?.publicProfile)?.defaultPrompts,
    record(plugin?.surface)?.defaultPrompts,
    record(plugin?.interface)?.defaultPrompts,
    record(plugin?.interface)?.defaultPrompt,
  ];
  return lists.filter((list): list is unknown[] => Array.isArray(list));
}

export function readOneSeatSuggestions(installedAgentId: string): OneSeatSuggestion[] {
  if (typeof installedAgentId !== "string" || !installedAgentId.trim()) return [];
  const agent = getAgentById(installedAgentId.trim());
  const root = agent?.localPath;
  if (!root) return [];
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: OneSeatSuggestion[] = [];
  let index = 0;
  for (const list of declaredLists(root)) {
    for (const entry of list) {
      const suggestion = normalize(entry, index++);
      if (!suggestion || seen.has(suggestion.prompt)) continue;
      seen.add(suggestion.prompt);
      out.push(suggestion);
      if (out.length >= MAX_SUGGESTIONS) return out;
    }
  }
  return out;
}
