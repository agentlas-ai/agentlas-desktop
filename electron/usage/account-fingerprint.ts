import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 여러 데스크탑이 같은 구독 계정을 쓰는지 판별하기 위한 secret-free 계정 지문.
 * 계정 UUID/이메일 같은 안정 identity를 sha256으로 접어 앞 16 hex만 노출한다.
 * 지문에서 원문 identity나 자격증명은 복원할 수 없고, identity를 모르면
 * undefined를 반환한다 — 모바일은 지문이 같을 때만 사용량 카드를 병합한다.
 */
export function usageAccountFingerprint(
  provider: string,
  identity: string | null | undefined,
): string | undefined {
  const normalized = identity?.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHash("sha256").update(`${provider}:${normalized}`).digest("hex").slice(0, 16);
}

/** Claude Code CLI가 ~/.claude.json에 기록하는 oauthAccount identity를 사용한다. */
export async function claudeUsageAccountFingerprint(): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(os.homedir(), ".claude.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown };
    };
    const account = parsed.oauthAccount;
    const identity =
      typeof account?.accountUuid === "string" && account.accountUuid
        ? account.accountUuid
        : typeof account?.emailAddress === "string"
          ? account.emailAddress
          : undefined;
    return usageAccountFingerprint("claude-code", identity);
  } catch {
    return undefined;
  }
}
