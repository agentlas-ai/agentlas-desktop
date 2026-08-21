// 내장 플러그인 패키지를 사용자 경로로 물질화한다.
//
// 규격(docs/PLUGIN-SPEC.md §1.2, §1.4):
//  · 데스크탑과 터미널이 **같은 경로**를 본다 — ~/.agentlas/plugins/<slug>/
//  · `.state/` 는 사용자 데이터다. 설치·갱신·제거 어느 때도 건드리지 않는다.
//  · 사용자가 지워도 다음 부팅에 복구된다.
//
// ★조용한 실패 금지. 한 패키지가 못 놓이면 그 사실을 남긴다 — 플러그인이 없는 이유를
// "원래 없었다"로 오해하면 다음 사람이 배선부터 다시 판다.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app } from "electron";

/** 배포본이 놓인 곳. build:electron 이 저장소 plugins/ 를 dist/plugins/ 로 복사한다. */
function bundledPluginsRoot(): string {
  return path.join(app.getAppPath(), "dist", "plugins");
}

function installedPluginsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

/** 점으로 시작하는 최상위 항목은 호스트 소유다(.state/, .install.json). */
function isHostOwned(name: string): boolean {
  return name.startsWith(".");
}

function copyTree(from: string, to: string): number {
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyTree(src, dest);
    else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

/** 배포본과 설치본이 같은 버전인가 — 같으면 다시 쓰지 않는다(멱등). */
function installedVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "plugin.json"), "utf8");
    return String(JSON.parse(raw).version ?? "") || null;
  } catch {
    return null;
  }
}

export interface MaterializeReceipt {
  slug: string;
  action: "installed" | "updated" | "unchanged" | "failed";
  files?: number;
  reason?: string;
}

export function materializeBuiltinPlugins(): MaterializeReceipt[] {
  const receipts: MaterializeReceipt[] = [];
  const source = bundledPluginsRoot();
  let slugs: string[];
  try {
    slugs = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isHostOwned(e.name))
      .map((e) => e.name);
  } catch (err) {
    console.error("[plugins] bundled packages unreadable:", source, err);
    return [{ slug: "*", action: "failed", reason: `bundled root unreadable: ${source}` }];
  }

  for (const slug of slugs) {
    const from = path.join(source, slug);
    const to = path.join(installedPluginsRoot(), slug);
    try {
      const bundled = installedVersion(from);
      const present = installedVersion(to);
      if (bundled && present && bundled === present) {
        receipts.push({ slug, action: "unchanged" });
        continue;
      }
      // 배포본에 있는 항목만 덮는다. .state/ 는 이 순회에 들어오지 않으므로 살아남는다.
      const files = copyTree(from, to);
      receipts.push({ slug, action: present ? "updated" : "installed", files });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] ${slug} materialize failed:`, reason);
      receipts.push({ slug, action: "failed", reason });
    }
  }
  const summary = receipts.map((r) => `${r.slug}:${r.action}`).join(" ");
  console.log(`[plugins] builtin packages — ${summary || "(none bundled)"}`);
  return receipts;
}
