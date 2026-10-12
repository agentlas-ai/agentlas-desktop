// 설치된 플러그인의 라우터를 실행의 시스템 프롬프트에 잇는다.
//
// ★이 파일이 마지막 칸이다. 규격(docs/PLUGIN-SPEC.md §4.1)이 지적한 구멍이 정확히
// 여기였다 — 스킬 번들은 ~/.agentlas/plugins/<slug>/skills/ 에 착지하는데 그것을 읽는
// 코드가 0이었다. 파일이 있는 것과 모델이 그것을 아는 것은 다르다.
//
// 예산 규칙(플러그인이 늘어나도 무너지지 않게):
//  · 항상 들어가는 것은 **목록 한 줄씩**이다 — 멘션, 라우터 description, 라우터 경로.
//    플러그인이 20개여도 이 부분은 수 KB 다.
//  · 라우터 **전문**은 어떤 경우에도 인라인하지 않는다(2026-10-13) — 불린 플러그인은 한 줄 포인터만.
//  · implicit:"never" 인 플러그인은 목록에도 넣지 않는다 — 불린 적 없으면 존재를 말하지
//    않는다는 뜻이 그 값이다.
//
// 모델이 스킬을 여는 방법은 "파일을 읽는 것"이다. 그래서 경로 규칙을 명시한다 —
// 도구가 없어 못 읽는 표면에서는 라우터가 스스로 그렇게 말하도록 규격이 요구한다(§3.1).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface InstalledPlugin {
  slug: string;
  name: string;
  mention: string;
  implicit: "never" | "router" | "always";
  routerPath: string;
  routerDescription: string;
  routerBody: string;
  skillsDir: string;
  referencesDir: string;
  workflows: string[];
}

function pluginsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

function frontmatterDescription(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return "";
  const line = /^description:\s*(.*)$/m.exec(m[1]);
  return line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
}

function standardRouterPath(slug: string): string {
  return path.join(pluginsRoot(), slug, "skills", "index", "SKILL.md");
}

/** First sentence of a router description, capped, so a long routing essay is not repeated on every request. */
export function shortPluginSummary(description: string, maxChars = 120): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentence = /^.*?[.!?。](?=\s|$)/.exec(flat)?.[0] ?? flat;
  if (sentence.length <= maxChars) return sentence;
  const cut = sentence.slice(0, maxChars);
  const at = cut.lastIndexOf(" ");
  return `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\s]+$/, "")}…`;
}

function readPlugin(dir: string): InstalledPlugin | null {
  try {
    const manifestRaw = fs.readFileSync(path.join(dir, "plugin.json"), "utf8").replace(/^﻿/, "");
    const m = JSON.parse(manifestRaw) as Record<string, any>;
    const skills = m.provides?.skills;
    if (!skills) return null; // 도구만 내는 플러그인은 라우터가 없다
    const slug = String(m.slug ?? "");
    if (!slug) return null;
    const routerRel = String(skills.router ?? "skills/index/SKILL.md");
    const routerPath = path.join(dir, routerRel);
    const routerBody = fs.readFileSync(routerPath, "utf8");
    const implicitRaw = String(m.invocation?.implicit ?? "router");
    const implicit = implicitRaw === "never" || implicitRaw === "always" ? implicitRaw : "router";
    return {
      slug,
      name: String(m.name ?? slug),
      mention: String(m.invocation?.mention ?? `@${slug}`),
      implicit,
      routerPath,
      routerDescription: frontmatterDescription(routerBody),
      routerBody,
      skillsDir: path.join(dir, "skills"),
      referencesDir: path.join(dir, "references"),
      workflows: Array.isArray(skills.workflows) ? skills.workflows.map(String) : [],
    };
  } catch {
    return null;
  }
}

let cache: { at: number; plugins: InstalledPlugin[] } | null = null;
const CACHE_MS = 5_000;

function listInstalledPlugins(): InstalledPlugin[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.plugins;
  let names: string[];
  try {
    names = fs
      .readdirSync(pluginsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    names = [];
  }
  const plugins = names
    .map((name) => readPlugin(path.join(pluginsRoot(), name)))
    .filter((p): p is InstalledPlugin => p !== null)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  cache = { at: now, plugins };
  return plugins;
}

/** 테스트·진단용 — 캐시를 비운다. */
export function resetPluginRouterCache(): void {
  cache = null;
}

function mentioned(userPrompt: string, plugin: InstalledPlugin): boolean {
  const needle = plugin.mention.toLowerCase();
  return userPrompt.toLowerCase().includes(needle);
}

/**
 * 이번 실행의 플러그인 안내. 설치된 것이 없으면 `""` — 없는 것을 있다고 말하지 않는다.
 *
 * @param userPrompt 이번 턴의 사용자 입력. 미제공이면 멘션 판정을 할 수 없으므로 목록만 낸다.
 */
export function pluginRouterPrompt(userPrompt?: string): string {
  const plugins = listInstalledPlugins();
  const prompt = userPrompt ?? "";
  const listed = plugins.filter((p) => p.implicit !== "never" || mentioned(prompt, p));
  if (!listed.length) return "";

  const lines: string[] = [
    "## Plugins",
    `Capability packages, not agents. Open a plugin's router file (\`${standardRouterPath("<slug>")}\` unless listed) and follow it. In a skill, \`$name\` is another skill or reference of that plugin; \`@name\` is a host tool.`,
    "Missing tool: use this runtime's own abilities first, then agentlas_resolve_plugins. A named installed plugin attaches next turn; an uninstalled Hub plugin needs owner approval.",
  ];

  if (listed.some((plugin) => plugin.slug === "plugin-make")) {
    lines.push("Repeatable procedure no plugin covers: offer @plugin-make once; do not start it.");
  }

  // One entry per plugin (progressive disclosure): the model opens the router file for routing
  // detail and the workflow list, so the always-on text carries only what picks the plugin.
  for (const p of listed) {
    const summary = shortPluginSummary(p.routerDescription, 90);
    // The conventional router path is stated once in the header; only a non-standard path is spelled out.
    const standard = p.routerPath === standardRouterPath(p.slug);
    lines.push(`- ${p.mention}: ${summary || p.name}${standard ? "" : ` Router: ${p.routerPath}`}`);
  }

  // 라우터 전문은 싣지 않는다(예산 규칙: 프롬프트에 스킬 본문을 인라인하지 않는다). 명시 호출된
  // 플러그인은 먼저 열어야 할 한 줄 포인터만 받는다.
  const invoked = listed.filter((p) => mentioned(prompt, p));
  for (const p of invoked) lines.push(`Invoked this turn: ${p.mention} — read ${p.routerPath} first.`);

  return lines.join("\n");
}

function routedPointer(p: InstalledPlugin, reason?: string): string {
  return `- ${p.mention}: read ${p.routerPath}${reason ? ` (${reason.slice(0, 120)})` : ""}`;
}

/**
 * 이번 턴의 라우팅 판정(auto-select)이 고른 스킬 플러그인의 라우터 포인터(본문은 싣지 않는다).
 *
 * 턴 컨텍스트(턴 단위)에 실리므로 다른 대화·다음 턴으로 새지 않는다. 이미 멘션된 플러그인은
 * 시스템 프롬프트의 "Invoked this turn" 줄이 있으므로 뺀다.
 */
export function selectedPluginRouterPrompt(selected: ReadonlyArray<{ slug: string; reason?: string }>, userPrompt = ""): string {
  if (!selected.length) return "";
  const bySlug = new Map(listInstalledPlugins().map((plugin) => [plugin.slug, plugin]));
  const blocks: string[] = [];
  for (const choice of selected) {
    const plugin = bySlug.get(choice.slug);
    if (!plugin || mentioned(userPrompt, plugin)) continue;
    blocks.push(routedPointer(plugin, choice.reason));
  }
  if (!blocks.length) return "";
  return ["Routed plugins for this turn (open the router, follow it):", ...blocks].join("\n");
}
