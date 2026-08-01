"use client";

import { useEffect, useRef, useState } from "react";
import {
  ONE_OPERATIONAL_RECOVERY_EVENT,
  type OneOperationalRecoveryDetail,
  withOneOperationalRecoveryDispatchSuppressed,
} from "@/lib/one-operational-recovery";

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
  const [pendingCount, setPendingCount] = useState(0);
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

    const syncPendingCount = () => setPendingCount(queueRef.current.length);

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

          const recent = await api.chats.listRecent(100);
          let one = recent.find((chat) => chat.originSurface === "one" && chat.kind !== "division") ?? null;
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
              locale: "ko",
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
        syncPendingCount();
        scheduleDrain(0);
      } else {
        scheduleDrain(queued.started ? 1_000 : recoveryRetryDelay(queued.attempts));
      }
    };

    const recover = (event: Event) => {
      const detail = (event as CustomEvent<OneOperationalRecoveryDetail>).detail;
      if (!detail?.scope) return;
      const normalized: OneOperationalRecoveryDetail = {
        scope: detail.scope,
        evidence: detail.evidence || "No diagnostic text was supplied; inspect the current authoritative state.",
      };
      const fingerprint = `${normalized.scope}\u0000${normalized.evidence}`;
      const now = Date.now();
      const last = recentRef.current.get(fingerprint) ?? 0;
      if (now - last < 60_000 || queuedFingerprintsRef.current.has(fingerprint)) return;
      for (const [key, seenAt] of recentRef.current) {
        if (now - seenAt > 10 * 60_000) recentRef.current.delete(key);
      }
      queuedFingerprintsRef.current.add(fingerprint);
      queueRef.current.push({
        detail: normalized,
        fingerprint,
        runId: crypto.randomUUID(),
        attempts: 0,
        started: false,
      });
      syncPendingCount();
      scheduleDrain(0);
    };
    window.addEventListener(ONE_OPERATIONAL_RECOVERY_EVENT, recover);
    return () => {
      disposed = true;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      window.removeEventListener(ONE_OPERATIONAL_RECOVERY_EVENT, recover);
    };
  }, []);

  if (pendingCount === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 22,
        zIndex: 2147483647,
        transform: "translateX(-50%)",
        maxWidth: "min(520px, calc(100vw - 32px))",
        padding: "11px 16px",
        border: "1px solid var(--paper-edge, rgba(0, 0, 0, .12))",
        borderRadius: 12,
        background: "var(--ink, #111)",
        color: "var(--paper, #fff)",
        boxShadow: "0 12px 36px rgba(0, 0, 0, .18)",
        pointerEvents: "none",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 750 }}>One이 확인하고 바로잡고 있습니다.</div>
    </div>
  );
}
