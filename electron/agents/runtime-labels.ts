import fs from "node:fs";
import path from "node:path";
import type { RuntimeLabel } from "./routes";
import type { RuntimeKind } from "../../shared/types";
import { RUNTIME_CAPABILITIES } from "../../shared/runtime-capabilities";

/**
 * ★어떤 파일이 어느 런타임 소속을 말해 주는지는 shared/runtime-capabilities.ts 의
 * distinctiveContextFiles 가 정본이다 — 예전에는 이 파일이 자기 손 목록을 들고 있어
 * 서술자와 어긋날 수 있었다. 라벨 유니온("gemini")과 런타임 킨드("antigravity")의
 * 이름이 다른 곳만 여기서 잇는다. 공유 파일(AGENTS.md 를 grok·kimi 도 읽음)은
 * 서술자 규칙대로 구별력이 없어 라벨을 만들지 않는다.
 */
const LABEL_TO_KIND: Record<Exclude<RuntimeLabel, "generic">, RuntimeKind> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "antigravity",
  cursor: "cursor",
};

function labelMatchers(): { label: Exclude<RuntimeLabel, "generic">; files: readonly string[] }[] {
  return (Object.keys(LABEL_TO_KIND) as Exclude<RuntimeLabel, "generic">[]).map((label) => ({
    label,
    files: RUNTIME_CAPABILITIES[LABEL_TO_KIND[label]].distinctiveContextFiles,
  }));
}

function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Pure package inspection shared by import and Cloud packaging. */
export function detectRuntimeLabels(dir: string): RuntimeLabel[] {
  const labels: RuntimeLabel[] = [];
  for (const { label, files } of labelMatchers()) {
    const hit = files.some((entry) =>
      entry.endsWith("/")
        ? isDirectory(path.join(dir, entry.slice(0, -1)))
        : exists(path.join(dir, entry)),
    );
    if (hit) labels.push(label);
  }
  if (labels.length === 0) labels.push("generic");
  return labels;
}

/**
 * Detect runtime compatibility from an already captured package snapshot.
 * Cloud packaging uses this variant so a post-scan filesystem swap cannot
 * change manifest metadata or make us follow a newly introduced symlink.
 */
export function detectRuntimeLabelsFromPaths(paths: Iterable<string>): RuntimeLabel[] {
  const normalized = new Set(Array.from(paths, (value) => value.replaceAll("\\", "/")));
  const hasFile = (value: string): boolean => normalized.has(value);
  const hasDirectory = (value: string): boolean => {
    const prefix = `${value.replace(/\/$/, "")}/`;
    return Array.from(normalized).some((entry) => entry.startsWith(prefix));
  };

  const labels: RuntimeLabel[] = [];
  for (const { label, files } of labelMatchers()) {
    const hit = files.some((entry) =>
      entry.endsWith("/") ? hasDirectory(entry.slice(0, -1)) : hasFile(entry),
    );
    if (hit) labels.push(label);
  }
  if (labels.length === 0) labels.push("generic");
  return labels;
}
