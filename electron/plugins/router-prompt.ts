// 설치된 플러그인의 라우터를 실행의 시스템 프롬프트에 잇는다.
//
// ★이 파일이 마지막 칸이다. 규격(docs/PLUGIN-SPEC.md §4.1)이 지적한 구멍이 정확히
// 여기였다 — 스킬 번들은 ~/.agentlas/plugins/<slug>/skills/ 에 착지하는데 그것을 읽는
// 코드가 0이었다. 파일이 있는 것과 모델이 그것을 아는 것은 다르다.
//
// 예산 규칙(플러그인이 늘어나도 무너지지 않게):
//  · 항상 들어가는 것은 **목록 한 줄씩**이다 — 멘션, 라우터 description, 라우터 경로.
//    플러그인이 20개여도 이 부분은 수 KB 다.
//  · 라우터 **전문**은 그 플러그인이 이번 턴에 `@slug` 로 불렸을 때만 인라인한다.
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
    "## Plugins available in this run",
    "",
    "A plugin is a capability package: a router skill that decides which of its workflow skills applies, plus the reference documents those skills cite. It is not an agent and has no memory of its own.",
    "",
    "How to use one:",
    `- Open the router file listed below, follow its routing rules, then open the workflow skill it names.`,
    `- Inside a skill, \`$name\` means another skill (\`<plugin>/skills/<name>/SKILL.md\`) or a shared reference (\`<plugin>/references/<name>.md\`); \`@name\` means a host tool.`,
    "- If a skill needs a tool you do not have, say so and stop. Never describe work you could not carry out.",
    "",
  ];

  for (const p of listed) {
    lines.push(`### ${p.mention} — ${p.name}`);
    if (p.routerDescription) lines.push(p.routerDescription);
    lines.push(`Router: ${p.routerPath}`);
    if (p.workflows.length) lines.push(`Skills: ${p.workflows.join(", ")}`);
    lines.push("");
  }

  // 명시 호출된 플러그인은 라우터를 읽는 왕복 없이 바로 따를 수 있도록 전문을 싣는다.
  for (const p of listed) {
    if (!mentioned(prompt, p)) continue;
    lines.push(`### ${p.mention} router (invoked in this turn)`, "", p.routerBody.trim(), "");
  }

  return lines.join("\n");
}
