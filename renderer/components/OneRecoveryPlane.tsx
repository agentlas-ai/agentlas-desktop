"use client";

import { useEffect, useRef, useState } from "react";
import {
  ONE_OPERATIONAL_RECOVERY_EVENT,
  type OneOperationalRecoveryDetail,
  withOneOperationalRecoveryDispatchSuppressed,
} from "@/lib/one-operational-recovery";
import { useT } from "@/lib/i18n";
import styles from "./OneRecoveryPlane.module.css";

function recoveryPrompt(detail: OneOperationalRecoveryDetail): string {
  return [
    "Private operational evidence. Never quote it or expose codes, paths, provider text, stack details, or internal terminology to the user.",
    `Operation surface: ${detail.scope}`,
    detail.evidence,
    "Judge the complete current situation. Perform safe reversible recovery within current authority, verify the original requested outcome, and store only the concise useful result. If a change needs authority beyond read-only inspection, request it through One's normal decision flow. Ask one short question only when identity, irreversible action, or new authority is required.",
  ].join("\n");
}

type QueuedRecovery = {
  detail: OneOperationalRecoveryDetail;
  fingerprint: string;
  runId: string;
  attempts: number;
  started: boolean;
};

const RECOVERY_RETRY_BASE_MS = 1_000;
const RECOVERY_RETRY_MAX_MS = 60_000;
/**
 * PRD §4.6 — 재시도에 상한이 없어서, 계속 실패하는 항목 하나가 1분마다 **영원히** 유료
 * 모델 실행을 다시 시작했다. 게다가 큐는 선두가 끝나야 뒤가 도는 구조라 그 하나가 나머지
 * 복구를 통째로 막았다. 시도 상한을 두고, 상한에 닿으면 선두를 비켜 준 뒤 사용자에게 말한다.
 */
const RECOVERY_MAX_ATTEMPTS = 3;
/** PRD §5.28 — 큐에 길이 상한이 없었다. 오래된 것부터 버린다(가장 최근 실패가 더 유용하다). */
const RECOVERY_QUEUE_MAX = 12;

function recoveryRetryDelay(attempts: number): number {
  return Math.min(
    RECOVERY_RETRY_BASE_MS * (2 ** Math.min(Math.max(0, attempts - 1), 16)),
    RECOVERY_RETRY_MAX_MS,
  );
}

/**
 * App-root recovery controller. It stays mounted on every Desktop route, so an
 * operational failure cannot disappear merely because /one is not open.
 * Recovery runs are system-authored One turns and never transfer session
 * ownership to a worker.
 */
export function OneRecoveryPlane() {
  const { locale } = useT();
  const [notice, setNotice] = useState<{
    scope: string;
    chatId?: string;
    message?: string;
  } | null>(null);
  const activeRef = useRef(false);
  const queueRef = useRef<QueuedRecovery[]>([]);
  const queuedFingerprintsRef = useRef<Set<string>>(new Set());
  const recentRef = useRef<Map<string, number>>(new Map());
  const retryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const scheduleDrain = (delayMs: number) => {
      if (disposed || retryTimerRef.current !== null) return;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        void drain();
      }, delayMs);
    };

    const drain = async () => {
      if (disposed || activeRef.current) return;
      const queued = queueRef.current[0];
      if (!queued) return;
      const api = window.agentlas;
      if (!api) {
        queued.attempts += 1;
        scheduleDrain(recoveryRetryDelay(queued.attempts));
        return;
      }

      activeRef.current = true;
      let completed = false;
      try {
        await withOneOperationalRecoveryDispatchSuppressed(async () => {
          if (queued.started) {
            const receipt = await api.invoke.receipt(queued.runId);
            if (receipt?.status === "completed") {
              completed = true;
              return;
            }
            if (
              receipt?.status === "failed"
              || receipt?.status === "cancelled"
              || receipt?.status === "interrupted"
            ) {
              queued.detail = {
                ...queued.detail,
                evidence: [queued.detail.evidence, receipt.errorMessage]
                  .filter(Boolean)
                  .join(" ")
                  .slice(0, 4_000),
              };
              queued.runId = crypto.randomUUID();
              queued.started = false;
              queued.attempts += 1;
              return;
            }
            return;
          }

          // PRD §4.6 — 복구는 실패가 일어난 방에서 이어진다. 그 방을 모를 때만 최근 One 대화로 간다.
          let one = queued.detail.chatId
            ? await api.chats.get(queued.detail.chatId).catch(() => null)
            : null;
          if (one && (one.originSurface !== "one" || one.kind === "division")) one = null;
          // One 것만 골라 받는다. 예전에는 전체 최근 100개를 받아 그중에서 찾았는데,
          // Work 를 많이 쓰면 그 100칸이 Work 대화로 차서 **멀쩡한 One 대화가 있는데도**
          // 못 찾고 아래에서 새 대화를 만들었다 — 복구할 때마다 One 대화가 하나씩 늘어난다.
          const recent = one ? [] : await api.chats.listRecentOne(100);
          one = one ?? recent.find((chat) => chat.kind !== "division") ?? null;
          if (!one) {
            one = await api.chats.create({
              title: "One",
              taskMode: "conversation",
              originSurface: "one",
            });
          }
          try {
            await api.invoke.run({
              runId: queued.runId,
              chatId: one.id,
              userPrompt: recoveryPrompt(queued.detail),
              promptOrigin: "system",
              taskIntent: "conversation",
              oneMode: true,
              locale,
              permissions: "read",
            });
            queued.started = true;
          } catch (cause) {
            // A lost renderer/Main reply may arrive after Main durably accepted
            // this exact runId. Query that receipt before retrying so recovery is
            // idempotent and cannot duplicate model work or cost.
            const receipt = await api.invoke.receipt(queued.runId).catch(() => null);
            if (receipt?.status === "completed") completed = true;
            else if (receipt) queued.started = true;
            else throw cause;
          }
        });
      } catch {
        queued.attempts += 1;
      } finally {
        activeRef.current = false;
      }

      if (disposed) return;
      if (completed) {
        queueRef.current.shift();
        queuedFingerprintsRef.current.delete(queued.fingerprint);
        recentRef.current.set(queued.fingerprint, Date.now());
        // An operation-specific message describes the original failed action,
        // not the background recovery attempt. Keep it visible until dismissed.
        setNotice((current) => (current?.message ? current : null));
        scheduleDrain(0);
      } else if (queued.attempts >= RECOVERY_MAX_ATTEMPTS) {
        // 상한에 닿았다. 이 항목은 큐에서 내려 **뒤에 밀린 복구가 돌게 하고**, 조용히 사라지는
        // 대신 사용자에게 한 줄로 남긴다. 냉각 기록을 남겨 같은 실패가 즉시 되돌아오지 않게 한다.
        queueRef.current.shift();
        queuedFingerprintsRef.current.delete(queued.fingerprint);
        recentRef.current.set(queued.fingerprint, Date.now());
        setNotice((current) => (current?.message ? current : {
          scope: queued.detail.scope,
          ...(queued.detail.chatId ? { chatId: queued.detail.chatId } : {}),
          ...(queued.detail.userMessage ? { message: queued.detail.userMessage } : {}),
        }));
        scheduleDrain(0);
      } else {
        scheduleDrain(queued.started ? 1_000 : recoveryRetryDelay(queued.attempts));
      }
    };

    const recover = (event: Event) => {
      const detail = (event as CustomEvent<OneOperationalRecoveryDetail>).detail;
      const scope = detail?.scope?.trim();
      const evidence = detail?.evidence?.trim();
      // Missing evidence is not a failure class and code may not invent one.
      if (!scope || !evidence) return;
      /*
       * ★ 실패한 방을 여기서 잃어버리면 안 된다. 아래 드레인은 `detail.chatId` 를 보고
       * "실패가 일어난 방에서 이어간다"(PRD §4.6)를 실행하는데, 정규화가 그 칸을 빼고
       * 새 객체를 만드는 바람에 **그 경로가 한 번도 타지지 않았다.** 대신 항상 "가장 최근
       * One 대화" — 즉 사용자가 지금 쓰고 있는 방 — 로 복구가 들어가, 사용자의 실행과
       * 같은 방에서 동시에 돌았다.
       */
      // 형식 판정은 발신부(`requestOneOperationalRecovery`)가 이미 했고, 여기서 다시
      // 정규식을 들이면 "복구 평면은 증거를 스스로 분류하지 않는다"는 계약을 깬다.
      // 잘못된 id 는 아래 `api.chats.get(...).catch(() => null)` + originSurface 검사에서
      // 조용히 걸러진다(닫히는 쪽으로 실패).
      const chatId = typeof detail?.chatId === "string" && detail.chatId.trim()
        ? detail.chatId.trim().slice(0, 128)
        : undefined;
      const userMessage = typeof detail?.userMessage === "string" && detail.userMessage.trim()
        ? detail.userMessage.trim().slice(0, 500)
        : undefined;
      const normalized: OneOperationalRecoveryDetail = {
        scope,
        evidence,
        ...(chatId ? { chatId } : {}),
        ...(userMessage ? { userMessage } : {}),
      };
      // This text is authored by the product call site and contains no private
      // operational evidence. Show it for the exact affected chat immediately,
      // even when the matching background recovery is already queued/cooling down.
      if (userMessage) {
        setNotice({
          scope,
          ...(chatId ? { chatId } : {}),
          message: userMessage,
        });
      }
      const fingerprint = `${normalized.scope}\u0000${normalized.evidence}`;
      const now = Date.now();
      const last = recentRef.current.get(fingerprint) ?? 0;
      if (now - last < 60_000 || queuedFingerprintsRef.current.has(fingerprint)) return;
      for (const [key, seenAt] of recentRef.current) {
        if (now - seenAt > 10 * 60_000) recentRef.current.delete(key);
      }
      while (queueRef.current.length >= RECOVERY_QUEUE_MAX) {
        const dropped = queueRef.current.shift();
        if (dropped) queuedFingerprintsRef.current.delete(dropped.fingerprint);
      }
      queuedFingerprintsRef.current.add(fingerprint);
      queueRef.current.push({
        detail: normalized,
        fingerprint,
        runId: crypto.randomUUID(),
        attempts: 0,
        started: false,
      });
      scheduleDrain(0);
    };
    window.addEventListener(ONE_OPERATIONAL_RECOVERY_EVENT, recover);
    // PRD §5.28 — 언어를 바꾸면 이 효과가 다시 만들어진다. 예전에는 새 효과가 이벤트를
    // 받을 때까지 아무것도 안 해서, 대기 중이던 복구가 그대로 멈춰 있었다.
    if (queueRef.current.length > 0) scheduleDrain(0);
    return () => {
      disposed = true;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      window.removeEventListener(ONE_OPERATIONAL_RECOVERY_EVENT, recover);
    };
  }, [locale]);

  // 복구가 성공하는 동안은 조용하다 — One 이 스스로 결과를 쓴다. 그러나 상한까지 실패하면
  // 조용함은 거짓말이 된다(PRD §4.6). 내부 코드·경로는 노출하지 않고 사실만 한 줄로 남긴다.
  if (!notice) return null;
  return (
    <div
      role="status"
      className={styles.recoveryNotice}
      data-one-recovery-chat-id={notice.chatId}
    >
      <span>
        {notice.message ?? (locale === "ko"
          ? "일부 작업을 자동으로 되돌리지 못했습니다. 다시 시도해 주세요."
          : "One could not finish an automatic repair. Please try that action again.")}
      </span>
      <button type="button" onClick={() => setNotice(null)}>
        {locale === "ko" ? "닫기" : "Dismiss"}
      </button>
    </div>
  );
}
