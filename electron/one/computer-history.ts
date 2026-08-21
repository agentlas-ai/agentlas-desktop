import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type {
  ComputerHistoryEntry,
  ComputerHistoryDraftPrompt,
  ComputerHistoryRecommendation,
  ComputerHistorySource,
  ComputerHistoryState,
} from "../../shared/computer-history";
import { redactSecrets } from "../../shared/secret-patterns";
import { getMeta, setMeta } from "../store/meta";

const ROOT = process.env.AGENTLAS_COMPUTER_HISTORY_ROOT?.trim()
  || path.join(os.homedir(), ".agentlas", "history");
const CONSENT_KEY = "one_computer_history_consent_v1";
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
  ];
  const candidates = raw.match(/(?:\/(?:[^/\s"'`]+\/)*events\.jsonl|[A-Za-z]:\\(?:[^\\\s"'`]+\\)*events\.jsonl)/g) || [];
  return [...new Set(candidates.map((value) => path.resolve(value)).filter((value) => {
    if (!allowedRoots.some((root) => isInside(root, value))) return false;
    try { return fs.statSync(value).isFile(); } catch { return false; }
  }))].slice(0, 8);
}

function filesFor(source: ComputerHistorySource): string[] {
  const dir = path.join(ROOT, source);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "instructions.md")
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
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

function parseEntry(file: string, source: ComputerHistorySource): ComputerHistoryEntry | null {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const parsed = frontmatter(raw);
  const body = parsed.body.trim();
  const titleMatch = body.match(/^#{1,3}\s+(.+)$/m);
  const title = safeText(parsed.values.title || titleMatch?.[1] || path.basename(file, ".md"), 120);
  const description = safeText(body.replace(/^#{1,3}\s+.+$/m, "").trim(), MAX_BODY_CHARS);
  const occurredAtValue = parsed.values.occurredAt || parsed.values.occurred_at || parsed.values.createdAt;
  const stat = (() => { try { return fs.statSync(file); } catch { return null; } })();
  const occurredAt = Number.isFinite(Date.parse(occurredAtValue || ""))
    ? new Date(occurredAtValue).toISOString()
    : new Date(stat?.mtimeMs || Date.now()).toISOString();
  const apps = (parsed.values.apps || parsed.values.app || "")
    .split(/[,|]/).map((app) => safeText(app, 32)).filter(Boolean).slice(0, 6);
  const id = createHash("sha256").update(`${source}:${file}:${occurredAt}`).digest("hex").slice(0, 24);
  evidenceRefs.set(id, { summaryPath: file, eventPaths: citedEventPaths(raw) });
  return {
    id,
    occurredAt,
    title: title || "Computer History",
    body: description || "기록된 설명이 없습니다.",
    apps,
    source,
    recommendation: null,
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
    title: `${candidate[0].title} 작업을 위한 에이전트 초안`,
    body: "반복된 컴퓨터 기록을 근거로 에이전트·그래프 초안을 제안합니다. 자동으로 켜지지 않습니다.",
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
  const entries = (["6h", "10min"] as ComputerHistorySource[])
    .flatMap((source) => filesFor(source).map((file) => parseEntry(file, source)).filter(Boolean) as ComputerHistoryEntry[])
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const recommendation = buildRecommendation(entries);
  if (recommendation) {
    const anchor = entries.find((entry) => entry.source === "6h");
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
  const prompt = locale === "ko"
    ? [
        `Computer History 아래 설명을 바탕으로 새 "${recommendation.title}" 초안을 만들어줘.`,
        "기록된 워크플로와 내가 한 액션을 이해할 수 있도록 다음 6시간 요약 파일과 그 안에 인용된 events.jsonl을 참고해줘:",
        evidenceLines,
        `원래 제안: "${recommendation.body}"`,
        "자동으로 빌드하거나 설치하지 말고, 먼저 근거와 범위를 정리한 편집 가능한 초안만 보여줘.",
      ].join("\n")
    : [
        `Computer History: prepare a new "${recommendation.title}" draft from the description below.`,
        "Use these six-hour summaries and their cited events.jsonl files to understand the recorded workflow and my actions:",
        evidenceLines,
        `Original proposal: "${recommendation.body}"`,
        "Do not build or install anything automatically. Show an editable draft with its evidence and scope first.",
      ].join("\n");
  return { recommendationId, prompt, evidenceCount: references.length };
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
    for (const file of filesFor(source)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort; report remaining via next list */ }
    }
  }
  for (const file of captureFiles()) {
    try { fs.rmSync(file, { force: true }); } catch { /* report on next list */ }
  }
  return getComputerHistoryState();
}

/** Capture pipeline hook: only writes a summary after explicit opt-in. */
export function recordComputerHistorySummary(input: {
  source?: ComputerHistorySource;
  title: string;
  body: string;
  apps?: string[];
  occurredAt?: string;
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
    "---",
    "",
    safeText(input.body, MAX_BODY_CHARS),
    "",
  ].join("\n");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return true;
}
