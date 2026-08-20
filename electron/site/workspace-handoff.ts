// Site Studio → Build handoff.
//
// Site 결과물은 실행 가능한 앱으로 취급하지 않는다. 사용자가 직접 고른 작업공간에
// 읽기 쉬운 디자인 소스(HTML), 디자인 결정(피드백), 그리고 Build용 지시문을
// 불변 리비전으로 보관한다. 이후 Build 에이전트가 이 폴더를 시각적 source of truth로
// 삼아 실제 앱을 구현한다.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SiteConversationEntry, SiteProjectMeta, SiteWorkspaceHandoff } from "../../shared/site-studio";
import { getSiteProject, listSiteConversation, readSiteScreenHtml } from "./store";

const SAFE_DIRECTORY = /^[a-zA-Z0-9._-]+$/;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 워크스페이스 안에 새 폴더만 만들되, 기존 컴포넌트가 심볼릭 링크이거나 일반
 * 디렉터리가 아니면 중단한다. 사용자의 승인 루트 밖으로 한 번도 쓰지 않는다.
 */
function ensureChildDirectory(root: string, parts: string[]): string {
  let current = root;
  for (const part of parts) {
    if (!SAFE_DIRECTORY.test(part) || part === "." || part === "..") {
      throw new Error("안전하지 않은 디자인 폴더 이름입니다.");
    }
    const candidate = path.join(current, part);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("디자인 폴더 경로에 심볼릭 링크 또는 파일이 있어 가져올 수 없습니다.");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      fs.mkdirSync(candidate, { mode: 0o755 });
    }
    const real = fs.realpathSync.native(candidate);
    if (!isInside(real, root)) {
      throw new Error("디자인 폴더가 선택한 작업공간 밖을 가리킵니다.");
    }
    current = real;
  }
  return current;
}

function writeNewFile(directory: string, name: string, content: string): void {
  if (!SAFE_DIRECTORY.test(name)) throw new Error("안전하지 않은 디자인 파일 이름입니다.");
  const filePath = path.join(directory, name);
  // revision 폴더가 고유하더라도 wx로 고정해 기존 파일을 덮어쓰지 않는다.
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

function markdownConversation(entries: SiteConversationEntry[], ko: boolean): string {
  if (!entries.length) return ko ? "# 디자인 피드백\n\n아직 기록된 대화가 없습니다.\n" : "# Design feedback\n\nNo recorded conversation yet.\n";
  const title = ko ? "# 디자인 피드백" : "# Design feedback";
  return `${title}\n\n${entries
    .map((entry) => {
      const role = entry.role === "user" ? (ko ? "사용자" : "User") : (ko ? "디자인 마스터" : "Design master");
      const context = entry.context ? `\n> ${ko ? "선택 대상" : "Selected"}: ${entry.context}` : "";
      return `## ${role}\n${entry.text.trim()}${context}\n`;
    })
    .join("\n")}`;
}

function handoffGuide(meta: SiteProjectMeta, relativePath: string, ko: boolean): string {
  const astryxKo = meta.surface === "agent-app"
    ? `
## Agent App 구현 계약

- 선택 대상: **${meta.agentAppTarget?.name ?? "Agent App"}** (${meta.agentAppTarget?.kind ?? "agent"})
- UI는 반드시 \`@astryxdesign/core@0.1.4\` + \`@astryxdesign/theme-neutral@0.1.4\`를 실제 React 19 코드에서 사용합니다.
- 공식 템플릿 프로필: \`${meta.astryxTemplate ?? "ai-chat-landing"}\`
- \`@stylexjs/stylex@0.18.3\`, \`@heroicons/react@2.2.0\`를 고정하고 Astryx MIT 고지를 보존합니다.
- 시스템 프롬프트, 메모리, 토큰, 자격 증명은 브라우저 번들에 넣지 않습니다. 로컬 호출은 launch-scoped Agentlas capability로, 공개 배포는 같은 origin의 서버 API와 호스팅 환경변수로만 연결합니다.
`
    : "";
  const astryxEn = meta.surface === "agent-app"
    ? `
## Agent App implementation contract

- Selected target: **${meta.agentAppTarget?.name ?? "Agent App"}** (${meta.agentAppTarget?.kind ?? "agent"})
- The React 19 implementation must actually use \`@astryxdesign/core@0.1.4\` and \`@astryxdesign/theme-neutral@0.1.4\`.
- Official template profile: \`${meta.astryxTemplate ?? "ai-chat-landing"}\`
- Pin \`@stylexjs/stylex@0.18.3\` and \`@heroicons/react@2.2.0\`, and preserve the Astryx MIT notice.
- Never put system prompts, memory, tokens, or credentials in the browser bundle. Use a launch-scoped Agentlas capability locally and a same-origin server API with hosting environment secrets for public deployments.
`
    : "";
  if (ko) {
    return `# ${meta.name} — Site Studio 디자인 핸드오프

이 폴더는 Agentlas Site Studio에서 가져온 **디자인 레퍼런스 리비전**입니다. HTML은 화면의 시각적 기준이며, 이 자체를 배포하거나 그대로 복사하는 산출물이 아닙니다.

## Build에서 사용할 때

1. \`screens/\`의 HTML을 레이아웃, 타이포그래피, 간격, 반응형 동작의 시각 기준으로 읽습니다.
2. \`feedback.md\`의 사용자 결정과 선택 요소 피드백을 우선합니다.
3. 현재 작업공간의 기존 코드와 구조를 먼저 확인한 뒤, 실제로 동작하는 제품을 구현합니다.
4. 참조 HTML의 스크립트나 외부 리소스를 신뢰 경계 밖에서 실행하지 않습니다.
${astryxKo}

이 리비전의 작업공간 경로: \`${relativePath}\`
`;
  }
  return `# ${meta.name} — Site Studio design handoff

This folder is an **immutable design reference revision** from Agentlas Site Studio. The HTML is the visual source of truth; it is not an application to deploy or blindly copy.

## Use it in Build

1. Read \`screens/\` for layout, typography, spacing, and responsive visual intent.
2. Prioritize user decisions in \`feedback.md\`.
3. Inspect the current workspace before implementing a functioning product.
4. Do not execute scripts or trust external resources from the reference HTML outside the intended boundary.
${astryxEn}

Workspace-relative path: \`${relativePath}\`
`;
}

function buildPrompt(meta: SiteProjectMeta, relativePath: string, ko: boolean): string {
  const agentAppContract = meta.surface === "agent-app"
    ? ko
      ? ` 선택한 ${meta.agentAppTarget?.name ?? "에이전트"}의 입력·출력 계약에 맞추고, 실제 UI는 @astryxdesign/core@0.1.4 및 neutral theme, 공식 ${meta.astryxTemplate ?? "ai-chat-landing"} 템플릿 프로필로 구현해. 브라우저 번들에는 시스템 프롬프트/메모리/비밀값을 넣지 말고, 로컬은 launch-scoped capability, 공개 배포는 같은 origin 서버 API와 호스팅 환경변수로만 연결해.`
      : ` Match the selected ${meta.agentAppTarget?.name ?? "agent"} input/output contract and implement the real UI with @astryxdesign/core@0.1.4, the neutral theme, and the official ${meta.astryxTemplate ?? "ai-chat-landing"} template profile. Keep system prompts, memory, and secrets out of the browser bundle; use a launch-scoped capability locally and a same-origin server API with hosting environment secrets publicly.`
    : "";
  if (ko) {
    return `현재 작업공간의 ${relativePath}를 먼저 읽고, screens/ HTML을 시각적 기준으로 사용해 이 디자인을 실제로 동작하는 제품으로 바이브코딩해줘. feedback.md의 사용자 결정을 반영하고, 기존 파일과 구조를 먼저 살핀 뒤 필요한 구현만 추가해.${agentAppContract}`;
  }
  return `First read ${relativePath} in this workspace. Use the HTML in screens/ as the visual source of truth and vibe-code this design into a working product. Follow the user decisions in feedback.md, inspect the existing files and structure first, and add only the implementation that is needed.${agentAppContract}`;
}

/** 선택한 워크스페이스에 디자인 스냅샷을 보관하고 Build가 읽을 프롬프트를 만든다. */
export function handoffSiteProjectToWorkspace(input: {
  projectId: string;
  workspacePath: string;
  locale?: "ko" | "en";
}): SiteWorkspaceHandoff {
  const meta = getSiteProject(input.projectId);
  if (!meta.screens.length) throw new Error("가져올 화면이 없습니다.");

  const workspaceRoot = fs.realpathSync.native(input.workspacePath);
  const rootStat = fs.lstatSync(workspaceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("The selected workspace is not a valid directory.");

  const ko = input.locale !== "en";
  const revision = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const relativePath = path.posix.join(".agentlas", "site-designs", meta.id, "revisions", revision);
  // 원본 화면이 깨진 경우에는 사용자가 고른 워크스페이스에 반쪽짜리 리비전조차
  // 만들지 않는다. 먼저 모두 메모리로 읽어 검증한 뒤에만 파일을 쓴다.
  const screenDocuments = meta.screens.map((screen) => ({ screen, html: readSiteScreenHtml(meta.id, screen.id) }));
  const conversation = listSiteConversation(meta.id);

  const manifest = {
    schemaVersion: 1,
    source: "Agentlas Site Studio",
    projectId: meta.id,
    projectName: meta.name,
    exportedAt: new Date().toISOString(),
    revision,
    conversationEntries: conversation.length,
    surface: meta.surface,
    agentAppTarget: meta.agentAppTarget,
    astryxTemplate: meta.astryxTemplate,
    agentAppContract: meta.agentAppContract,
    agentAppVisual: meta.agentAppVisual,
    screens: meta.screens.map((screen, index) => ({
      id: screen.id,
      name: screen.name,
      variantGroup: screen.variantGroup,
      variantLabel: screen.variantLabel,
      relativePath: `screens/${String(index + 1).padStart(2, "0")}-${screen.id}.html`,
    })),
  };

  // 완성 전 리비전은 Build가 볼 수 없어야 한다. 같은 parent의 hidden staging
  // 폴더에 전부 쓴 뒤 rename으로 한 번에 공개하고, 중간 write 실패는 정리한다.
  const revisionsDir = ensureChildDirectory(workspaceRoot, [".agentlas", "site-designs", meta.id, "revisions"]);
  const stagingName = `.${revision}.tmp-${randomUUID().slice(0, 8)}`;
  const stagingDir = ensureChildDirectory(revisionsDir, [stagingName]);
  const finalDir = path.join(revisionsDir, revision);
  let committed = false;
  try {
    const screensDir = ensureChildDirectory(stagingDir, ["screens"]);
    for (let index = 0; index < screenDocuments.length; index += 1) {
      const { screen, html } = screenDocuments[index];
      writeNewFile(screensDir, `${String(index + 1).padStart(2, "0")}-${screen.id}.html`, html);
    }
    writeNewFile(stagingDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    writeNewFile(stagingDir, "feedback.md", markdownConversation(conversation, ko));
    writeNewFile(stagingDir, "README.md", handoffGuide(meta, relativePath, ko));
    if (meta.surface === "agent-app") {
      writeNewFile(
        stagingDir,
        "THIRD_PARTY_NOTICES.md",
        "# Third-party notices\n\nAstryx is Copyright (c) Meta Platforms, Inc. and affiliates and is used under the MIT License. Preserve the copyright and permission notice when distributing copies or substantial portions. Source: https://github.com/facebook/astryx\n",
      );
      /*
       * ★생성된 React 소스를 함께 넘긴다. 예전에는 README 가 "Astryx 로 구현하라"고
       * 계약만 적고 HTML 미리보기만 복사해, 이미 디스크에 존재하는 실제 React 앱
       * (~/.agentlas/site/agentapp/<appId>/astryx-app)을 사람이 다시 만들게 했다.
       * node_modules·빌드 산출물은 제외한다 — 넘길 것은 소스이지 캐시가 아니다.
       */
      const artifactRoot = meta.agentAppArtifact?.rootPath;
      const sourceRoot = artifactRoot ? path.join(artifactRoot, "astryx-app") : null;
      if (sourceRoot && fs.existsSync(sourceRoot) && fs.statSync(sourceRoot).isDirectory()) {
        const skip = new Set(["node_modules", "dist", ".vite", ".git", ".DS_Store"]);
        const destination = path.join(stagingDir, "astryx-app");
        fs.cpSync(sourceRoot, destination, {
          recursive: true,
          dereference: false,
          filter: (source) => !skip.has(path.basename(source)),
        });
      }
    }
    fs.renameSync(stagingDir, finalDir);
    committed = true;
  } finally {
    if (!committed) fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  return {
    projectId: meta.id,
    revision,
    relativePath,
    screenCount: meta.screens.length,
    buildPrompt: buildPrompt(meta, relativePath, ko),
  };
}
