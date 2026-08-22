import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  ComputerHistoryEntry,
  ComputerHistoryDraftPrompt,
  ComputerHistoryRecommendation,
  ComputerHistoryRecommendationKind,
  ComputerHistorySource,
  ComputerHistoryState,
} from "../../shared/computer-history";
import { redactSecrets } from "../../shared/secret-patterns";
import { getMeta, setMeta } from "../store/meta";

const ROOT = process.env.AGENTLAS_COMPUTER_HISTORY_ROOT?.trim()
  || path.join(os.homedir(), ".agentlas", "history");
const CONSENT_KEY = "one_computer_history_consent_v1";
const CLEARED_BEFORE_KEY = "one_computer_history_cleared_before_v1";
const MAX_FILES_PER_BUCKET = 80;
const MAX_BODY_CHARS = 360;
const CAPTURE_DIR = "captures";
const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CAPTURE_FILES = 160;
const PRIVATE_PATH_RE = /(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/g;
const DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;
const RECURRENCE_STOP_WORDS = new Set([
  "about", "after", "again", "agentlas", "also", "and", "from", "into", "then", "that", "the", "this", "using", "with", "work",
  "관련", "그리고", "다시", "대한", "바탕", "사용", "작업", "진행", "확인",
]);
const evidenceRefs = new Map<string, { summaryPath: string; eventPaths: string[] }>();

// One owns ~/.agentlas/history, but an existing Codex Computer History install
// already has compatible Skysight summaries. Read those local summaries in
// place so opting in does not start with an inexplicably empty history. Writes,
// captures, retention, and physical deletion remain confined to ROOT.
const COMPATIBLE_READ_ROOTS = process.env.AGENTLAS_COMPUTER_HISTORY_ROOT?.trim() ? [] : [
  path.join(os.homedir(), ".codex", "memories", "extensions", "skysight", "resources"),
  path.join(os.homedir(), "codex", "memories", "extensions", "skysight", "resources"),
];
const SKYSIGHT_EVENT_ROOT = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "2DC432GLL2.com.openai.sky.CUAService",
  "Library",
  "Caches",
  "ComputerUse",
  "Skysight",
);

function consent(): "off" | "on" {
  return getMeta(CONSENT_KEY) === "on" ? "on" : "off";
}

function safeText(value: string, limit: number): string {
  return redactSecrets(value)
    .replace(PRIVATE_PATH_RE, "<local path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function citedEventPaths(raw: string): string[] {
  const allowedRoots = [
    ROOT,
    path.join(os.homedir(), ".agentlas"),
    path.join(os.homedir(), ".codex", "memories"),
    path.join(os.homedir(), "codex", "memories"),
    SKYSIGHT_EVENT_ROOT,
  ];
  // Skysight's macOS path contains `Group Containers`, so whitespace cannot be
  // used as a path delimiter. Its citations are line-oriented and terminate at
  // events.jsonl, which gives us a bounded, root-checked extraction instead.
  const candidates = raw.split(/\r?\n/).flatMap((line) => {
    const unix = line.match(/(\/[^\r\n]*?events\.jsonl)(?=$|[\s`),;])/g) || [];
    const windows = line.match(/([A-Za-z]:\\[^\r\n]*?events\.jsonl)(?=$|[\s`),;])/g) || [];
    return [...unix, ...windows];
  });
  return [...new Set(candidates.map((value) => path.resolve(value)).filter((value) => {
    if (!allowedRoots.some((root) => isInside(root, value))) return false;
    try { return fs.statSync(value).isFile(); } catch { return false; }
  }))].slice(0, 8);
}

function filesForRoot(root: string, source: ComputerHistorySource): string[] {
  const files: string[] = [];
  const bucketDir = path.join(root, source);
  if (fs.existsSync(bucketDir)) {
    files.push(...fs.readdirSync(bucketDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "instructions.md")
      .map((entry) => path.join(bucketDir, entry.name)));
  }
  // Codex Skysight keeps both buckets flat in resources/ and encodes the
  // source in each filename.
  if (fs.existsSync(root)) {
    const suffix = new RegExp(`-${source}-(?:memory-summary|[^/]+)\\.md$`);
    files.push(...fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && suffix.test(entry.name))
      .map((entry) => path.join(root, entry.name)));
  }
  return files;
}

function filesFor(source: ComputerHistorySource): string[] {
  const roots = [...new Set([ROOT, ...COMPATIBLE_READ_ROOTS])];
  return [...new Set(roots.flatMap((root) => filesForRoot(root, source)))]
    .sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    })
    .slice(0, MAX_FILES_PER_BUCKET);
}

function captureFiles(): string[] {
  const dir = path.join(ROOT, CAPTURE_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(png|jpg)$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
}

/**
 * Raw screen evidence is deliberately a separate, consent-gated layer. The
 * summary files may live longer, but pixels are local-only and expire after
 * seven days. This hook is called only by an explicit Computer Use capture;
 * it never starts a capture by itself.
 */
export function recordComputerHistoryCapture(dataUrl: string | null | undefined, occurredAt = new Date().toISOString()): boolean {
  if (consent() !== "on" || typeof dataUrl !== "string") return false;
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return false;
  try {
    const dir = path.join(ROOT, CAPTURE_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
    const stamp = (Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt) : new Date())
      .toISOString().replace(/[:.]/g, "-");
    const extension = match[1] === "png" ? "png" : "jpg";
    const file = path.join(dir, `screen-${stamp}-${createHash("sha1").update(dataUrl).digest("hex").slice(0, 10)}.${extension}`);
    fs.writeFileSync(file, Buffer.from(match[2], "base64"), { mode: 0o600, flag: "wx" });
    pruneCaptureFiles(Date.now());
    return true;
  } catch {
    return false;
  }
}

function pruneCaptureFiles(now = Date.now()): void {
  const files = captureFiles();
  for (const file of files) {
    let mtime = now;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* prune best effort */ }
    if (now - mtime > CAPTURE_RETENTION_MS) {
      try { fs.rmSync(file, { force: true }); } catch { /* retry on next access */ }
    }
  }
  const retained = captureFiles();
  for (const file of retained.slice(MAX_CAPTURE_FILES)) {
    try { fs.rmSync(file, { force: true }); } catch { /* retry on next access */ }
  }
}

function frontmatter(raw: string): { body: string; values: Record<string, string> } {
  if (!raw.startsWith("---")) return { body: raw, values: {} };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { body: raw, values: {} };
  const values: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { body: raw.slice(end + 4), values };
}

function declaredRecommendationKind(value: string): ComputerHistoryRecommendationKind | null {
  const normalized = value.trim().toLocaleLowerCase();
  // Skysight's legacy `skill` suggestion becomes an Agentlas agent draft. A
  // procedural skill has variable inputs and judgment; it is not silently
  // relabelled as an integration plugin. New producers can declare plugin or
  // graph explicitly, preserving the evidence-based product distinction.
  if (normalized === "agent" || normalized === "skill") return "agent";
  if (["plugin", "tool", "mcp"].includes(normalized)) return "plugin";
  if (["graph", "automation", "routine"].includes(normalized)) return "graph";
  return null;
}

function explicitSuggestion(raw: string): { kind: ComputerHistoryRecommendationKind; name: string; description: string } | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const lines = raw.slice(3, end).split(/\r?\n/);
  const start = lines.findIndex((line) => /^suggestion\s*:\s*$/.test(line));
  if (start < 0) return null;
  const values: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s]/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  const name = safeText(values.name || "", 100);
  const description = safeText(values.description || "", MAX_BODY_CHARS);
  const kind = declaredRecommendationKind(values.type || "");
  return kind && name && description ? { kind, name, description } : null;
}

function parseEntry(file: string, source: ComputerHistorySource): ComputerHistoryEntry | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const parsed = frontmatter(raw);
  const body = parsed.body.trim();
  const titleMatch = body.match(/^#{1,3}\s+(.+)$/m);
  const title = safeText(parsed.values.title || titleMatch?.[1] || path.basename(file, ".md"), 120);
  const description = safeText(parsed.values.description || body.replace(/^#{1,3}\s+.+$/m, "").trim(), MAX_BODY_CHARS);
  const occurredAtValue = parsed.values.occurredAt || parsed.values.occurred_at || parsed.values.createdAt;
  const stat = (() => { try { return fs.statSync(file); } catch { return null; } })();
  const occurredAt = Number.isFinite(Date.parse(occurredAtValue || ""))
    ? new Date(occurredAtValue).toISOString()
    : new Date(stat?.mtimeMs || Date.now()).toISOString();
  const apps = (parsed.values.applications || parsed.values.apps || parsed.values.app || "")
    .replace(/^\s*\[|\]\s*$/g, "")
    .split(/[,|]/).map((app) => safeText(app, 64)).filter(Boolean).slice(0, 6);
  const id = createHash("sha256").update(`${source}:${file}:${occurredAt}`).digest("hex").slice(0, 24);
  evidenceRefs.set(id, { summaryPath: file, eventPaths: citedEventPaths(raw) });
  const suggestion = source === "6h" ? explicitSuggestion(raw) : null;
  return {
    id,
    occurredAt,
    title: title || "Computer History",
    body: description || "기록된 설명이 없습니다.",
    apps,
    source,
    recommendation: suggestion ? {
      id: createHash("sha256").update(`${file}:${suggestion.name}:${suggestion.description}`).digest("hex").slice(0, 24),
      kind: suggestion.kind,
      title: suggestion.name,
      body: suggestion.description,
      evidence: [{ entryId: id, label: title, occurredAt, source }],
      status: "draft",
    } : null,
  };
}

function recurrenceTokens(entry: ComputerHistoryEntry): Set<string> {
  return new Set(`${entry.title} ${entry.body}`
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= (/[가-힣]/.test(token) ? 2 : 3) && !RECURRENCE_STOP_WORDS.has(token))
    .slice(0, 80));
}

function sameRecurringWorkflow(left: ComputerHistoryEntry, right: ComputerHistoryEntry): boolean {
  const leftTitle = left.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const rightTitle = right.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (leftTitle && leftTitle === rightTitle) return true;
  const leftTokens = recurrenceTokens(left);
  const rightTokens = recurrenceTokens(right);
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller < 4) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared >= 4 && shared / smaller >= 0.48;
}

function buildRecommendation(entries: ComputerHistoryEntry[]): ComputerHistoryRecommendation | null {
  const sixHour = entries.filter((entry) => entry.source === "6h");
  const explicit = sixHour.find((entry) => entry.recommendation)?.recommendation;
  if (explicit) return explicit;
  const grouped: ComputerHistoryEntry[][] = [];
  for (const entry of sixHour) {
    // Summaries of the same routine are rarely byte-identical. Cluster only
    // when a title matches or the smaller redacted workflow shares a strong,
    // four-token core. This creates useful drafts without sending history to a
    // model or treating a generic product name as recurrence evidence.
    const group = grouped.find((candidate) => candidate.some((item) => sameRecurringWorkflow(item, entry)));
    if (group) group.push(entry);
    else grouped.push([entry]);
  }
  const candidate = grouped.sort((a, b) => b.length - a.length)[0];
  if (!candidate || candidate.length < 2) return null;
  const evidence = candidate.slice(0, 3).map((entry) => ({ entryId: entry.id, label: entry.title, occurredAt: entry.occurredAt, source: entry.source }));
  return {
    id: createHash("sha256").update(evidence.map((item) => item.label + item.occurredAt).join("|")).digest("hex").slice(0, 24),
    kind: "agent",
    title: candidate[0].title,
    body: "반복된 컴퓨터 기록을 근거로 에이전트 초안을 제안합니다. 자동으로 만들거나 켜지지 않습니다.",
    evidence,
    status: "draft",
  };
}

export function getComputerHistoryState(): ComputerHistoryState {
  const currentConsent = consent();
  pruneCaptureFiles();
  evidenceRefs.clear();
  if (currentConsent === "off") {
    return { schemaVersion: 1, consent: "off", entries: [], generatedAt: new Date().toISOString() };
  }
  const clearedBefore = Date.parse(getMeta(CLEARED_BEFORE_KEY) || "");
  const entries = (["6h", "10min"] as ComputerHistorySource[])
    .flatMap((source) => filesFor(source).map((file) => parseEntry(file, source)).filter(Boolean) as ComputerHistoryEntry[])
    .filter((entry) => !Number.isFinite(clearedBefore) || Date.parse(entry.occurredAt) > clearedBefore)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const recommendation = buildRecommendation(entries);
  if (recommendation) {
    const anchor = entries.find((entry) => recommendation.evidence.some((item) => item.entryId === entry.id))
      || entries.find((entry) => entry.source === "6h");
    if (anchor) anchor.recommendation = recommendation;
  }
  return { schemaVersion: 1, consent: currentConsent, entries, generatedAt: new Date().toISOString() };
}

export function prepareComputerHistoryDraftPrompt(
  recommendationId: string,
  locale: "ko" | "en",
): ComputerHistoryDraftPrompt {
  if (typeof recommendationId !== "string" || !/^[a-f0-9]{24}$/.test(recommendationId)) {
    throw new Error("Invalid Computer History recommendation");
  }
  const state = getComputerHistoryState();
  const recommendation = state.entries
    .map((entry) => entry.recommendation)
    .find((entry) => entry?.id === recommendationId);
  if (!recommendation) throw new Error("Computer History recommendation is unavailable");
  const references = recommendation.evidence.map((item) => {
    const ref = evidenceRefs.get(item.entryId);
    if (!ref) throw new Error("Computer History evidence is unavailable");
    return { item, ...ref };
  });
  const evidenceLines = references.map(({ item, summaryPath, eventPaths }, index) => {
    const events = eventPaths.length > 0 ? eventPaths.join(", ") : "(no cited events.jsonl)";
    return `${index + 1}. ${item.label}\n   6h summary: ${summaryPath}\n   cited events.jsonl: ${events}`;
  }).join("\n");
  const kindLabel = recommendation.kind === "plugin"
    ? (locale === "ko" ? "플러그인" : "plugin")
    : recommendation.kind === "graph"
      ? (locale === "ko" ? "그래프" : "graph")
      : (locale === "ko" ? "에이전트" : "agent");
  const safetyLine = recommendation.kind === "plugin"
    ? (locale === "ko" ? "자동으로 설치하거나 연결하지 말고, 필요한 Tool 목록과 권한 범위를 포함한 편집 가능한 초안만 보여줘." : "Do not install or connect anything automatically. Show an editable draft with the required Tools and authority boundary.")
    : recommendation.kind === "graph"
      ? (locale === "ko" ? "자동으로 그래프를 켜지 말고, 트리거와 실제 노드가 포함된 편집 가능한 초안만 보여줘." : "Do not enable the graph automatically. Show an editable draft with its trigger and real nodes.")
      : (locale === "ko" ? "자동으로 에이전트를 빌드하거나 조직에 추가하지 말고, 역할·말투·권한 범위가 포함된 편집 가능한 초안만 보여줘." : "Do not build or add the agent automatically. Show an editable draft with its role, voice, and authority boundary.");
  const prompt = locale === "ko"
    ? [
        `Computer History 아래 설명을 바탕으로 새 ${kindLabel} "${recommendation.title}" 초안을 만들어줘.`,
        "기록된 워크플로와 내가 한 액션을 이해할 수 있도록 다음 6시간 요약 파일과 그 안에 인용된 events.jsonl을 참고해줘:",
        evidenceLines,
        `원래 제안: "${recommendation.body}"`,
        safetyLine,
      ].join("\n")
    : [
        `Computer History: prepare a new ${kindLabel} "${recommendation.title}" draft from the description below.`,
        "Use these six-hour summaries and their cited events.jsonl files to understand the recorded workflow and my actions:",
        evidenceLines,
        `Original proposal: "${recommendation.body}"`,
        safetyLine,
      ].join("\n");
  return { recommendationId, recommendationKind: recommendation.kind, prompt, evidenceCount: references.length };
}

export function getComputerHistoryConsent(): "off" | "on" { return consent(); }

export function setComputerHistoryConsent(enabled: boolean): ComputerHistoryState {
  setMeta(CONSENT_KEY, enabled ? "on" : "off");
  // Revocation stops new captures immediately. Existing local pixels remain
  // until their seven-day expiry or the explicit clear action, so the user can
  // still inspect the already-consented record before deleting it.
  pruneCaptureFiles();
  return getComputerHistoryState();
}

export function clearComputerHistory(): ComputerHistoryState {
  for (const source of ["10min", "6h"] as ComputerHistorySource[]) {
    for (const file of filesForRoot(ROOT, source)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort; report remaining via next list */ }
    }
  }
  for (const file of captureFiles()) {
    try { fs.rmSync(file, { force: true }); } catch { /* report on next list */ }
  }
  // Compatible history roots are owned by their producer. Hide their current
  // records from One without deleting another product's data; newer summaries
  // can appear normally after this point.
  setMeta(CLEARED_BEFORE_KEY, new Date().toISOString());
  return getComputerHistoryState();
}

/** Capture pipeline hook: only writes a summary after explicit opt-in. */
export function recordComputerHistorySummary(input: {
  source?: ComputerHistorySource;
  title: string;
  body: string;
  apps?: string[];
  occurredAt?: string;
  suggestion?: { kind: ComputerHistoryRecommendationKind; name: string; description: string };
}): boolean {
  if (consent() !== "on") return false;
  const source = input.source || "10min";
  const occurredAt = input.occurredAt || new Date().toISOString();
  const dir = path.join(ROOT, source);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = occurredAt.replace(/[^0-9TZ-]/g, "").slice(0, 24) || String(Date.now());
  const file = path.join(dir, `${stamp}-${createHash("sha1").update(input.title).digest("hex").slice(0, 8)}.md`);
  const content = [
    "---",
    `title: ${safeText(input.title, 120)}`,
    `occurredAt: ${occurredAt}`,
    `apps: ${(input.apps || []).map((app) => safeText(app, 32)).join(", ")}`,
    ...(input.suggestion ? [
      "suggestion:",
      `  type: ${input.suggestion.kind}`,
      `  name: ${safeText(input.suggestion.name, 100)}`,
      `  description: ${safeText(input.suggestion.description, MAX_BODY_CHARS)}`,
    ] : []),
    "---",
    "",
    safeText(input.body, MAX_BODY_CHARS),
    "",
  ].join("\n");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}
