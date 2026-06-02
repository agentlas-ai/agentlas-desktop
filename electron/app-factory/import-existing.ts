import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { recordScaffoldedApp, getAgentAppByRoot } from "../store/agent-apps";
import { recordAgentSurface } from "../store/agent-surfaces";
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceConnectorSpec,
  AgentlasSurfaceManifest,
  AgentlasSurfaceToolSpec,
  AppFactoryAppRecord,
  AppFactoryGeneratedFile,
  Chat,
  InstalledAgent,
  JsonObject,
} from "../../shared/types";

export interface ExistingLocalAppImportResult {
  imported: boolean;
  surfaceId: string;
  manifest: AgentlasSurfaceManifest;
  app: AppFactoryAppRecord;
  rootPath: string;
  summary: string;
}

export function importGeneratedLocalApp(input: {
  chat: Chat;
  agent: InstalledAgent;
  prompt: string;
  responseText: string;
  baseDir: string;
  now?: string;
}): ExistingLocalAppImportResult | null {
  if (input.chat.kind === "division") return null;
  if (!shouldImportGeneratedApp(input.prompt, input.responseText)) return null;

  const rootPath = findGeneratedAppRoot(input.responseText, input.baseDir);
  if (!rootPath) return null;

  const existing = getAgentAppByRoot(rootPath);
  if (existing) {
    return {
      imported: false,
      surfaceId: existing.surfaceId,
      manifest: existing.manifest,
      app: existing,
      rootPath,
      summary: `Registered app already exists in Library > Generated Apps: ${existing.appName}.`,
    };
  }

  const now = input.now ?? new Date().toISOString();
  const pkg = readPackageJson(rootPath);
  const appName = inferAppName(rootPath, pkg);
  const surfaceId = `surface-${slugify(appName)}-${shortHash(`${input.chat.id}:${rootPath}`)}`;
  const appId = `app-${slugify(appName)}-${shortHash(rootPath)}`;
  const localUrl = extractLocalPreviewUrl(input.responseText);
  const artifacts = collectArtifacts(rootPath);
  const manifest = buildManifest({
    appId,
    appName,
    rootPath,
    localUrl,
    pkg,
    artifacts,
    now,
  });

  materializeAgentlasMetadata({
    rootPath,
    appId,
    appName,
    manifest,
    pkg,
    localUrl,
    artifacts,
    now,
  });
  ensureGitRepository(rootPath);

  const scaffold = {
    appId,
    appName,
    rootPath,
    previewPath: path.join(rootPath, "src", "index.html"),
    setupPath: fileExists(path.join(rootPath, "SETUP.md"))
      ? path.join(rootPath, "SETUP.md")
      : fileExists(path.join(rootPath, "README.md"))
        ? path.join(rootPath, "README.md")
        : path.join(rootPath, "agentlas.app.json"),
    smokePath: path.join(rootPath, "tests", "smoke.mjs"),
    createdAt: now,
    files: listSnapshotFiles(rootPath, artifacts),
    summary: `${appName} imported from an existing runnable local app folder and registered as an Agentlas generated app.`,
  };

  recordAgentSurface({
    id: surfaceId,
    chatId: input.chat.id,
    projectId: input.chat.projectId,
    agentId: input.agent.id,
    manifest,
    state: {
      importedFrom: rootPath,
      previewUrl: localUrl ?? null,
      latestRunPath: artifacts.latestRunPath ?? null,
    },
  });

  const app = recordScaffoldedApp({
    chatId: input.chat.id,
    projectId: input.chat.projectId,
    agentId: input.agent.id,
    surfaceId,
    actionId: "import-existing-local-app",
    manifest,
    scaffold,
  });

  return {
    imported: true,
    surfaceId,
    manifest,
    app,
    rootPath,
    summary: `${appName} is now visible in Library > Generated Apps and has a matching Generated Surface.`,
  };
}

function shouldImportGeneratedApp(prompt: string, responseText: string): boolean {
  const combined = `${prompt}\n${responseText}`;
  const appIntent =
    /(앱|웹앱|내장 앱|생성 앱|app|webapp|mini-app|service-app|studio|dashboard|tool|스토리보드|storyboard|영상|video)/i.test(
      combined,
    );
  const generatedSignal =
    /(npm\s+start|localhost|127\.0\.0\.1|runs\/|movie\.mp4|package\.json|server\.mjs|완성|생성|scaffold|built|created)/i.test(
      combined,
    );
  return appIntent && generatedSignal;
}

function findGeneratedAppRoot(responseText: string, baseDir: string): string | null {
  const candidates = new Set<string>();
  for (const raw of extractAbsolutePathCandidates(responseText)) candidates.add(raw);
  for (const raw of extractRelativePathCandidates(responseText)) {
    candidates.add(path.resolve(baseDir, raw));
  }

  for (const candidate of candidates) {
    const root = findAppRoot(candidate);
    if (root) return root;
  }

  return newestRunnableChild(baseDir);
}

function extractAbsolutePathCandidates(text: string): string[] {
  const matches = text.matchAll(/\/(?:Users|Volumes|tmp|private\/tmp)\/[^\s`"'<>),;]+/g);
  return [...matches].map((match) => cleanCandidate(match[0])).filter((value): value is string => Boolean(value));
}

function extractRelativePathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/\bcd\s+([A-Za-z0-9._/-]+)/g)) {
    const cleaned = cleanCandidate(match[1]);
    if (cleaned && !cleaned.startsWith("/") && !cleaned.startsWith("http")) out.add(cleaned);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,5})\/(?:runs|public|package\.json|server\.mjs|README\.md)\b/g)) {
    const first = cleanCandidate(match[1]);
    if (first && !first.startsWith("/") && !first.includes("://")) out.add(first);
  }
  return [...out];
}

function cleanCandidate(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/^`|`$/g, "").replace(/[)\],.;:]+$/g, "");
  if (!value || value === "." || value === "..") return null;
  return value;
}

function findAppRoot(candidate: string): string | null {
  let cur = path.resolve(candidate);
  if (fileExists(cur)) cur = path.dirname(cur);
  for (let i = 0; i < 6; i += 1) {
    if (isRunnableAppRoot(cur)) return cur;
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return null;
}

function newestRunnableChild(baseDir: string): string | null {
  if (!dirExists(baseDir)) return null;
  const children = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => path.join(baseDir, entry.name))
    .filter(isRunnableAppRoot)
    .map((candidate) => ({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return children[0]?.path ?? null;
}

function isRunnableAppRoot(candidate: string): boolean {
  const pkgPath = path.join(candidate, "package.json");
  if (!fileExists(pkgPath)) return false;
  const pkg = readPackageJson(candidate);
  return Boolean(
    pkg.scripts?.start ||
      pkg.scripts?.dev ||
      fileExists(path.join(candidate, "server.mjs")) ||
      fileExists(path.join(candidate, "public", "index.html")),
  );
}

function buildManifest(input: {
  appId: string;
  appName: string;
  rootPath: string;
  localUrl: string | null;
  pkg: PackageJson;
  artifacts: AppArtifacts;
  now: string;
}): AgentlasSurfaceManifest {
  const description =
    input.pkg.description ||
    readReadmeSummary(input.rootPath) ||
    "Runnable local app generated by an Agentlas chat.";
  const routes = [
    { path: "/", label: "App", purpose: "Run or preview the generated local app.", status: "generated" },
    ...(input.artifacts.latestRunPath
      ? [{ path: "/runs", label: "Runs", purpose: "Review generated run artifacts.", status: "generated" }]
      : []),
  ];
  const artifactRows = input.artifacts.rows.length
    ? input.artifacts.rows
    : [{ label: "App root", path: input.rootPath, status: "generated" }];
  const launchRows: JsonObject[] = [
    { item: "Register generated app in Agentlas Library", status: "passed", evidence: input.rootPath },
    {
      item: "Open local preview",
      status: input.localUrl ? "ready" : "manual",
      evidence: input.localUrl ?? path.join(input.rootPath, "public", "index.html"),
    },
    {
      item: "Run smoke test",
      status: input.pkg.scripts?.smoke ? "ready" : "basic-check",
      evidence: input.pkg.scripts?.smoke ? "npm run smoke" : "tests/smoke.mjs",
    },
  ];
  const actions: AgentlasSurfaceAction[] = [
    ...(input.localUrl
      ? [
          {
            id: "open-local-app",
            label: "Open local app",
            type: "external-link",
            url: input.localUrl,
            permission: "read",
          } satisfies AgentlasSurfaceAction,
        ]
      : []),
    { id: "run-smoke", label: "Run smoke", type: "run-smoke-test", permission: "read" },
  ];

  return {
    version: "0.1",
    kind: "surface",
    title: input.appName,
    domain: inferDomain(input),
    layout: "service-app",
    app: {
      name: input.appName,
      tagline: description,
      appType: "creative-tool",
      audience: "Agentlas desktop user",
      valueProp: "A runnable local app stays attached to the chat, Workbench, and Generated Apps library.",
      routes,
      connectors: inferConnectors(input),
      tools: inferTools(input),
      deployment: {
        target: "Agentlas Desktop local app",
        repoPath: input.rootPath,
        command: input.pkg.scripts?.start ? "npm start" : input.pkg.scripts?.dev ? "npm run dev" : undefined,
        previewUrl: input.localUrl ?? undefined,
        readiness: "prototype",
      },
      business: {
        audience: "local operator",
        offer: input.appName,
        pricing: "local runtime",
        launchMetric: "app opens from Library > Generated Apps",
      },
      generatedArtifacts: artifactRows.map((row) => String(row.path ?? "")).filter(Boolean),
    },
    data: {
      brief: {
        type: "json",
        value: {
          name: input.appName,
          description,
          rootPath: input.rootPath,
          previewUrl: input.localUrl,
          packageName: input.pkg.name ?? null,
        },
      },
      routes: { type: "routes", rows: routes },
      artifacts: { type: "artifacts", rows: artifactRows },
      launch: { type: "launch-checklist", rows: launchRows },
      ...(input.artifacts.shots.length ? { shots: { type: "media", rows: input.artifacts.shots } } : {}),
    },
    widgets: [
      { type: "app-shell", data: "routes", title: "App shell" },
      ...(input.artifacts.shots.length ? [{ type: "storyboard", data: "shots", title: "Storyboard" }] : []),
      { type: "asset-board", data: "artifacts", title: "Artifacts" },
      { type: "launch-checklist", data: "launch", title: "Library readiness" },
    ],
    actions,
    evidence: [
      {
        id: "local_app_root",
        kind: "verified",
        source: "Generated local app root",
        url: `file://${input.rootPath}`,
        retrievedAt: input.now,
        confidence: 1,
      },
    ],
    claims: [
      {
        id: "local_app_imported",
        text: "The runnable local app is registered as an Agentlas generated app.",
        kind: "verified",
        evidenceIds: ["local_app_root"],
        status: "passed",
      },
    ],
    capabilities: [{ id: "local_filesystem", type: "filesystem", purpose: "Open and test local app files.", approval: "once" }],
    budget: { currency: "USD", limit: 0, spent: 0, approvalThreshold: 0, unit: "local-app" },
    provenance: [{ source: "Agentlas local app importer", url: `file://${input.rootPath}`, retrievedAt: input.now }],
  };
}

function materializeAgentlasMetadata(input: {
  rootPath: string;
  appId: string;
  appName: string;
  manifest: AgentlasSurfaceManifest;
  pkg: PackageJson;
  localUrl: string | null;
  artifacts: AppArtifacts;
  now: string;
}): void {
  const operations = {
    schemaVersion: "0.1",
    appId: input.appId,
    appName: input.appName,
    generatedAt: input.now,
    domain: input.manifest.domain,
    lifecycle: {
      status: "scaffolded",
      stage: "imported-existing-local-app",
      reversible: true,
      archivePath: null,
      restoredAt: null,
      updatedAt: input.now,
      summary: "Imported an existing runnable local app into the Agentlas generated app registry.",
    },
    trust: {
      evidence: input.manifest.evidence ?? [],
      claims: input.manifest.claims ?? [],
      capabilities: input.manifest.capabilities ?? [],
      budget: input.manifest.budget ?? null,
      jobs: input.manifest.jobs ?? [],
    },
    providerTasks: [],
    connectors: input.manifest.app?.connectors ?? [],
    collections: {
      events: [
        {
          at: input.now,
          actor: "agentlas-app-importer",
          type: "import-existing-local-app",
          summary: "Registered generated local app for Library > Generated Apps.",
        },
      ],
    },
    localRuntime: {
      command: input.pkg.scripts?.start ? "npm start" : input.pkg.scripts?.dev ? "npm run dev" : null,
      previewUrl: input.localUrl,
      smokeCommand: input.pkg.scripts?.smoke ? "npm run smoke" : "node tests/smoke.mjs",
    },
    reuse: { status: "local-app", summary: "Reusable from Agentlas Library > Generated Apps." },
  };
  const appData = {
    id: input.appId,
    generatedAt: input.now,
    manifest: input.manifest,
    routes: input.manifest.app?.routes ?? [],
    connectors: input.manifest.app?.connectors ?? [],
    tools: input.manifest.app?.tools ?? [],
    launch: input.manifest.data.launch,
    artifacts: input.artifacts.rows,
    operations,
  };

  writeJson(path.join(input.rootPath, "agentlas.app.json"), appData);
  writeJson(path.join(input.rootPath, "data", "operations.json"), operations);
  writeJson(path.join(input.rootPath, "src", "data", "app.json"), appData);
  writeJson(path.join(input.rootPath, "src", "data", "operations.json"), operations);
  writeJson(path.join(input.rootPath, "src", "runtime", "provider-tasks.json"), { tasks: [] });
  writeTextIfMissing(path.join(input.rootPath, ".gitignore"), generatedAppGitignore());
  writeText(path.join(input.rootPath, "src", "index.html"), previewHtml(input));
  writeText(path.join(input.rootPath, "tests", "smoke.mjs"), smokeScript(input.pkg));
}

function previewHtml(input: {
  appName: string;
  localUrl: string | null;
  rootPath: string;
  manifest: AgentlasSurfaceManifest;
  artifacts: AppArtifacts;
}): string {
  const escapedName = escapeHtml(input.appName);
  const escapedUrl = input.localUrl ? escapeHtml(input.localUrl) : "";
  const shots = input.artifacts.shots;
  const artifacts = input.artifacts.rows;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapedName}</title>
<style>
:root{color-scheme:light;--ink:#1f2328;--muted:#667085;--line:#e4e7ec;--paper:#fff;--panel:#f8fafc;--accent:#5245ff;--ok:#157f4f}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#eef2f6;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{min-height:220px;padding:32px clamp(18px,5vw,56px);display:grid;gap:12px;align-content:end;background:linear-gradient(135deg,#151513,#1d3028 60%,#10222a);color:white}
.eyebrow{width:max-content;max-width:100%;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.1);border-radius:999px;padding:7px 10px;font-size:12px;font-weight:900;text-transform:uppercase}
h1{margin:0;font-size:clamp(38px,6vw,72px);line-height:.92;letter-spacing:0}p{margin:0;color:#d7dde6;max-width:780px;line-height:1.5}
a{color:inherit;font-weight:800}.actions{display:flex;gap:8px;flex-wrap:wrap}.pill{display:inline-flex;align-items:center;width:max-content;max-width:100%;border-radius:999px;padding:5px 9px;background:#eef4ff;color:#2f46b8;font-size:11px;font-weight:900;text-decoration:none}.pill.ok{background:#eaf8ef;color:var(--ok)}.pill.dark{background:rgba(255,255,255,.12);color:white}
main{display:grid;gap:1px;background:var(--line)}section{background:var(--paper);padding:24px clamp(18px,4vw,42px);min-width:0}.section-head{display:flex;align-items:end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}.section-head h2{margin:0;font-size:22px}.section-head p{color:var(--muted)}
.split{display:grid;grid-template-columns:320px 6px minmax(360px,1fr) 6px 280px;min-height:min(720px,72vh);border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--line)}
.pane{background:var(--paper);min-width:0;overflow:auto;padding:14px;display:grid;align-content:start;gap:12px}.pane.center{background:var(--panel);padding:0}.resizer{cursor:ew-resize;background:var(--line);touch-action:none}.resizer:hover,.resizer.active{background:#b8c0cc}
.shot-card,.artifact{border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden;display:grid;min-width:0}.shot-card img{width:100%;height:160px;object-fit:cover;display:block;border-bottom:1px solid var(--line);background:#e5e7eb}.shot-body,.artifact{padding:11px;gap:6px}.shot-body{display:grid}.shot-body strong,.artifact strong{overflow-wrap:anywhere}.meta{font-size:12px;color:var(--muted);line-height:1.45;overflow-wrap:anywhere}
.webbar{height:40px;display:flex;align-items:center;gap:8px;padding:8px 10px;background:white;border-bottom:1px solid var(--line);min-width:0}.webbar a{color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}iframe{width:100%;height:calc(100% - 40px);border:0;background:white;display:block}.empty{border:1px dashed var(--line);border-radius:8px;padding:16px;color:var(--muted);background:var(--panel)}
code{color:var(--accent);background:#eef4ff;border-radius:5px;padding:2px 5px;overflow-wrap:anywhere}
@media(max-width:960px){.split{display:grid;grid-template-columns:1fr;min-height:auto}.resizer{display:none}.pane.center{min-height:560px}header{min-height:auto}section{padding:20px 16px}}
</style>
</head>
<body>
<header>
  <span class="eyebrow">Agentlas generated app</span>
  <h1>${escapedName}</h1>
  <p>${escapeHtml(input.manifest.app?.valueProp || input.manifest.app?.tagline || input.manifest.title)}</p>
  <div class="actions">
    ${input.localUrl ? `<a class="pill dark" href="${escapedUrl}">Open web studio</a>` : ""}
    <span class="pill dark">${escapeHtml(shots.length ? `${shots.length} storyboard shots` : "local app package")}</span>
    <span class="pill dark">folder repo ready</span>
  </div>
</header>
<main>
  <section>
    <div class="section-head">
      <div>
        <h2>Storyboard Studio inside Agentlas</h2>
        <p>왼쪽은 스토리보드, 가운데는 실제 웹 작업 공간, 오른쪽은 생성된 폴더 산출물입니다. 구분선은 드래그해서 크기를 조정할 수 있습니다.</p>
      </div>
      <span class="pill ok">resizable split</span>
    </div>
    <div class="split" data-resizable-split="imported-app">
      <aside class="pane">
        ${shots.length ? shots.map((shot, index) => importedShotCardHtml(shot, index + 1)).join("\n        ") : `<div class="empty">No storyboard shots found yet.</div>`}
      </aside>
      <div class="resizer" role="separator" aria-label="Resize storyboard pane" aria-orientation="vertical" data-resizer="left"></div>
      <section class="pane center">
        <div class="webbar">
          <span class="pill ok">web</span>
          ${input.localUrl ? `<a href="${escapedUrl}">${escapedUrl}</a>` : `<span class="meta">Start the local app, then reopen this preview.</span>`}
        </div>
        ${
          input.localUrl
            ? `<iframe src="${escapedUrl}" title="${escapedName} web studio"></iframe>`
            : `<div class="empty" style="margin:14px">No local preview URL was detected.</div>`
        }
      </section>
      <div class="resizer" role="separator" aria-label="Resize artifacts pane" aria-orientation="vertical" data-resizer="right"></div>
      <aside class="pane">
        <div class="artifact"><strong>App root</strong><span class="meta"><code>${escapeHtml(input.rootPath)}</code></span></div>
        ${artifacts.length ? artifacts.map(importedArtifactHtml).join("\n        ") : `<div class="empty">No run artifacts found.</div>`}
      </aside>
    </div>
  </section>
</main>
<script>
${importedResizableSplitScript()}
</script>
</body>
</html>
`;
}

function importedShotCardHtml(row: JsonObject, index: number): string {
  const src = importedAssetSrc(row.imagePath || row.path || row.imageUrl || row.thumbnail || row.url);
  const title = stringValue(row.caption) || stringValue(row.title) || `Shot ${index}`;
  const scene = stringValue(row.scene) || stringValue(row.description) || stringValue(row.imagePrompt);
  const camera = stringValue(row.camera);
  return `<article class="shot-card">
          ${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(title)}" loading="lazy" />` : ""}
          <div class="shot-body">
            <span class="pill ok">SHOT ${escapeHtml(String(index))}</span>
            <strong>${escapeHtml(title)}</strong>
            ${camera ? `<span class="meta">${escapeHtml(camera)}</span>` : ""}
            ${scene ? `<span class="meta">${escapeHtml(scene)}</span>` : ""}
          </div>
        </article>`;
}

function importedArtifactHtml(row: JsonObject): string {
  const label = stringValue(row.label) || stringValue(row.name) || stringValue(row.path) || "Artifact";
  const status = stringValue(row.status) || "generated";
  const rawPath = stringValue(row.path);
  return `<div class="artifact"><strong>${escapeHtml(label)}</strong><span class="meta">${escapeHtml(status)}</span>${rawPath ? `<span class="meta"><code>${escapeHtml(rawPath)}</code></span>` : ""}</div>`;
}

function importedAssetSrc(value: unknown): string | undefined {
  const raw = stringValue(value)?.trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/(?:Users|Volumes|tmp|private\/tmp)\//.test(raw) && /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(raw)) {
    return pathToFileURL(raw).href;
  }
  return undefined;
}

function importedResizableSplitScript(): string {
  return `(() => {
  const split = document.querySelector('[data-resizable-split="imported-app"]');
  if (!split) return;
  const storageKey = 'agentlas.imported-app.split.widths';
  const minLeft = 220;
  const minCenter = 320;
  const minRight = 220;
  const handleWidth = 6;
  let left = 320;
  let right = 280;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (typeof saved?.left === 'number') left = saved.left;
    if (typeof saved?.right === 'number') right = saved.right;
  } catch {}
  const clamp = () => {
    const total = split.clientWidth || 1000;
    const maxLeft = Math.max(minLeft, total - right - minCenter - handleWidth * 2);
    left = Math.max(minLeft, Math.min(maxLeft, left));
    const maxRight = Math.max(minRight, total - left - minCenter - handleWidth * 2);
    right = Math.max(minRight, Math.min(maxRight, right));
  };
  const apply = () => {
    if (window.matchMedia('(max-width: 960px)').matches) {
      split.style.gridTemplateColumns = '';
      return;
    }
    clamp();
    split.style.gridTemplateColumns = left + 'px ' + handleWidth + 'px minmax(' + minCenter + 'px, 1fr) ' + handleWidth + 'px ' + right + 'px';
  };
  apply();
  window.addEventListener('resize', apply);
  split.querySelectorAll('[data-resizer]').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      const side = handle.getAttribute('data-resizer');
      const startX = event.clientX;
      const startLeft = left;
      const startRight = right;
      handle.classList.add('active');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        if (side === 'left') left = startLeft + dx;
        else right = startRight - dx;
        apply();
      };
      const up = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { localStorage.setItem(storageKey, JSON.stringify({ left, right })); } catch {}
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      event.preventDefault();
    });
  });
})();`;
}

function smokeScript(pkg: PackageJson): string {
  if (pkg.scripts?.smoke) {
    return `import { spawnSync } from "node:child_process";
const result = spawnSync("npm", ["run", "smoke", "--silent"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
`;
  }
  return `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "package.json");
if (!fs.existsSync(pkg)) throw new Error("package.json missing");
console.log("SMOKE OK");
`;
}

function collectArtifacts(rootPath: string): AppArtifacts {
  const runsPath = path.join(rootPath, "runs");
  const runDirs = dirExists(runsPath)
    ? fs
        .readdirSync(runsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(runsPath, entry.name))
        .filter((dir) => fileExists(path.join(dir, "storyboard.json")) || fileExists(path.join(dir, "movie.mp4")))
        .map((dir) => ({ path: dir, mtimeMs: fs.statSync(dir).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    : [];
  const latestRunPath = runDirs[0]?.path ?? null;
  const rows: JsonObject[] = [];
  const shots: JsonObject[] = [];
  if (latestRunPath) {
    for (const file of fs.readdirSync(latestRunPath)) {
      if (!/^(storyboard\.json|movie\.mp4|shot-\d+\.(png|jpe?g|webp))$/i.test(file)) continue;
      rows.push({ label: file, path: path.join(latestRunPath, file), status: "generated" });
    }
    const storyboardPath = path.join(latestRunPath, "storyboard.json");
    const storyboard = readJsonObject(storyboardPath);
    const storyboardShots = Array.isArray(storyboard?.shots) ? storyboard.shots.filter(isJsonObject) : [];
    for (const shot of storyboardShots) {
      const n = typeof shot.n === "number" ? shot.n : shots.length + 1;
      shots.push({
        ...shot,
        imagePath: path.join(latestRunPath, `shot-${n}.png`),
      });
    }
  }
  return { latestRunPath, rows, shots };
}

function inferConnectors(input: { pkg: PackageJson; rootPath: string }): AgentlasSurfaceConnectorSpec[] {
  const connectors: AgentlasSurfaceConnectorSpec[] = [];
  const imageEngine = input.pkg.imageEngine;
  if (isJsonObject(imageEngine) && typeof imageEngine.provider === "string") {
    connectors.push({
      id: imageEngine.provider,
      name: titleize(imageEngine.provider),
      type: "model",
      purpose: "Image generation provider declared by the generated app.",
      auth: imageEngine.requiresApiKey === false ? "none" : "api-key",
      status: "verified",
    });
  }
  const text = `${input.pkg.description ?? ""}\n${readReadmeSummary(input.rootPath) ?? ""}`;
  if (/ffmpeg/i.test(text)) connectors.push({ id: "ffmpeg", name: "ffmpeg", type: "local-tool", auth: "none", status: "verified" });
  if (/magick|imagemagick/i.test(text)) connectors.push({ id: "imagemagick", name: "ImageMagick", type: "local-tool", auth: "none", status: "verified" });
  return connectors;
}

function inferTools(input: { pkg: PackageJson }): AgentlasSurfaceToolSpec[] {
  const tools: AgentlasSurfaceToolSpec[] = [];
  if (input.pkg.scripts?.smoke) {
    tools.push({ id: "smoke-test", name: "Smoke Test", description: "Runs the generated app's smoke check.", kind: "validator" });
  }
  if (input.pkg.scripts?.start) {
    tools.push({ id: "local-server", name: "Local Server", description: "Starts the generated local app.", kind: "runner" });
  }
  return tools;
}

function inferDomain(input: { appName: string; pkg: PackageJson }): string {
  const text = `${input.appName} ${input.pkg.description ?? ""}`;
  if (/storyboard|video|image|creative|studio|스토리보드|영상|이미지/i.test(text)) return "creative";
  if (/shop|store|commerce|order|payment|쇼핑몰|커머스|주문|결제/i.test(text)) return "ecommerce";
  return "app";
}

function listSnapshotFiles(rootPath: string, artifacts: AppArtifacts): AppFactoryGeneratedFile[] {
  const rels = [
    "README.md",
    "SETUP.md",
    "package.json",
    "agentlas.app.json",
    "data/operations.json",
    "src/index.html",
    "src/data/app.json",
    "src/data/operations.json",
    "src/runtime/provider-tasks.json",
    "tests/smoke.mjs",
    "public/index.html",
    "server.mjs",
  ];
  for (const row of artifacts.rows) {
    const rawPath = typeof row.path === "string" ? row.path : "";
    if (rawPath.startsWith(rootPath)) rels.push(path.relative(rootPath, rawPath));
  }
  const seen = new Set<string>();
  return rels
    .filter((rel) => {
      if (seen.has(rel)) return false;
      seen.add(rel);
      return fileExists(path.join(rootPath, rel));
    })
    .map((rel) => ({
      path: rel,
      kind: fileKind(rel),
      bytes: fs.statSync(path.join(rootPath, rel)).size,
    }));
}

function fileKind(rel: string): AppFactoryGeneratedFile["kind"] {
  if (/\.(md|txt)$/i.test(rel)) return "doc";
  if (/\.(json)$/i.test(rel)) return rel.includes("package") || rel.includes("agentlas.app") ? "config" : "data";
  if (/smoke|test/i.test(rel)) return "test";
  return "source";
}

function extractLocalPreviewUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/[^\s`"'<>)]*)?/i);
  return match?.[0] ?? null;
}

function inferAppName(rootPath: string, pkg: PackageJson): string {
  return readReadmeTitle(rootPath) || (pkg.name ? titleize(pkg.name) : titleize(path.basename(rootPath)));
}

function readPackageJson(rootPath: string): PackageJson {
  const raw = readJsonObject(path.join(rootPath, "package.json"));
  return raw ?? {};
}

function readReadmeTitle(rootPath: string): string | null {
  const readme = readReadme(rootPath);
  const match = readme?.match(/^#\s+(.+)$/m);
  return match?.[1]?.replace(/[^\p{L}\p{N}\s:·.-]/gu, "").trim() || null;
}

function readReadmeSummary(rootPath: string): string | null {
  const readme = readReadme(rootPath);
  if (!readme) return null;
  const line = readme
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#") && !value.startsWith("```"));
  return line ?? null;
}

function readReadme(rootPath: string): string | null {
  for (const name of ["README.md", "SETUP.md"]) {
    const file = path.join(rootPath, name);
    if (fileExists(file)) return fs.readFileSync(file, "utf8");
  }
  return null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, "utf8");
}

function writeTextIfMissing(file: string, value: string): void {
  if (fileExists(file)) return;
  writeText(file, value);
}

function ensureGitRepository(rootPath: string): void {
  try {
    if (dirExists(path.join(rootPath, ".git"))) return;
    void spawnSync("git", ["init"], {
      cwd: rootPath,
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // Git is a portability convenience for generated app folders.
  }
}

function generatedAppGitignore(): string {
  return `node_modules/
dist/
.DS_Store
*.log
.env
runs/
ops/provider-browser-workspace/
ops/provider-browser-screenshots/
`;
}

function readJsonObject(file: string): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function titleize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

interface PackageJson {
  name?: string;
  description?: string;
  scripts?: Record<string, string>;
  imageEngine?: JsonObject;
}

interface AppArtifacts {
  latestRunPath: string | null;
  rows: JsonObject[];
  shots: JsonObject[];
}
