import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeKind } from "../../shared/types";

/*
 * 모델을 지정하지 않고 CLI 런타임을 돌리면 그 CLI 가 **자기 설정 파일**의 기본 모델을 쓴다.
 * 화면이 그 값을 모르면 사용자는 "무슨 모델인지 알 수 없는" 행을 고르게 된다(오너 2026-09-13).
 * 여기서는 CLI 가 실제로 읽는 파일만 본다 — 짐작해서 채우지 않는다.
 *   claude-code: ~/.claude/settings.json  { "model": "opus" }
 *   codex:       ~/.codex/config.toml     model = "gpt-6-astra"
 * 나머지 CLI 는 기기 설정에 모델 칸이 없거나 확인된 형식이 없어 미설정으로 둔다.
 */
export function cliConfiguredDefaultModel(kind: RuntimeKind, home = os.homedir()): string | undefined {
  try {
    if (kind === "claude-code") {
      const raw = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
      const parsed = JSON.parse(raw) as { model?: unknown };
      return normalize(parsed.model);
    }
    if (kind === "codex") {
      const raw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      // 최상위 `model = "..."` 만 본다. 테이블([profiles.x]) 아래의 model 은 기본값이 아니다.
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) break;
        const match = /^model\s*=\s*"([^"]+)"/.exec(trimmed);
        if (match) return normalize(match[1]);
      }
    }
  } catch {
    // 파일이 없거나 깨졌으면 모른다 — 감지를 막을 이유는 아니다.
  }
  return undefined;
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : undefined;
}
