"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { IconAlertTriangle, IconCheck, IconRefresh } from "@/components/Icon";
import type { CredentialRecoveryFailure, CredentialRecoveryResult } from "../../shared/credential-recovery";

type RetryResult = CredentialRecoveryResult;
type CredentialRecoveryApi = {
  credentialRecovery: { retry: (retryToken: string) => Promise<RetryResult> };
};

/** Deliberate one-token retry. Kept outside the component for handler-level tests. */
export async function runCredentialRecoveryRetry(input: {
  api: CredentialRecoveryApi;
  failure: CredentialRecoveryFailure;
  inFlight: Set<string>;
  onRecovered?: (failure: CredentialRecoveryFailure, result: RetryResult) => void | Promise<void>;
  refresh: () => Promise<void>;
  onRefreshError?: () => void | Promise<void>;
}): Promise<RetryResult | null> {
  const { api, failure, inFlight, onRecovered, refresh, onRefreshError } = input;
  if (inFlight.has(failure.retryToken)) return null;
  inFlight.add(failure.retryToken);
  let result: RetryResult;
  try {
    result = await api.credentialRecovery.retry(failure.retryToken);
  } catch {
    result = { status: "unavailable" };
  }
  try {
    if (result.status === "restored" || result.status === "missing") await onRecovered?.(failure, result);
  } catch {
    // A caller refresh failure must not turn an observed retry result into a false success.
  } finally {
    try {
      await refresh();
    } catch {
      // A failed metadata refresh is distinct from the observed retry result.
      try { await onRefreshError?.(); } catch { /* UI reporting must not leak a handler rejection. */ }
    } finally {
      inFlight.delete(failure.retryToken);
    }
  }
  return result;
}

export function CredentialRecoveryPanel({
  onRecovered,
  onRefreshError,
  refreshKey = 0,
  locale,
}: {
  onRecovered?: (failure: CredentialRecoveryFailure, result: RetryResult) => void | Promise<void>;
  onRefreshError?: () => void | Promise<void>;
  refreshKey?: number;
  locale: "ko" | "en";
}) {
  const ko = locale === "ko";
  const [failures, setFailures] = useState<CredentialRecoveryFailure[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [lastResult, setLastResult] = useState<{ token: string; status: RetryResult["status"] } | null>(null);
  const inFlight = useRef(new Set<string>());
  const text = (en: string, korean: string) => (ko ? korean : en);

  const reload = useCallback(async (clearResult = false) => {
    if (clearResult) setLastResult(null);
    const api = ipc();
    if (!api) {
      setLoadError(true);
      return false;
    }
    try {
      const next = await api.credentialRecovery.list();
      setFailures(next);
      setLoadError(false);
      return true;
    } catch {
      // This reads only Main-owned failure metadata. It never starts storage work.
      setLoadError(true);
      return false;
    }
  }, []);

  useEffect(() => {
    void reload(true);
  }, [reload, refreshKey]);

  const retry = useCallback(async (failure: CredentialRecoveryFailure) => {
    if (inFlight.current.has(failure.retryToken)) return;
    const api = ipc();
    if (!api) {
      setLoadError(true);
      return;
    }
    setPending((current) => new Set(current).add(failure.retryToken));
    try {
      const result = await runCredentialRecoveryRetry({
        api,
        failure,
        inFlight: inFlight.current,
        onRecovered,
        refresh: async () => {
          if (!(await reload(false))) throw new Error("credential_recovery_metadata_refresh_failed");
        },
        onRefreshError: async () => {
          setLoadError(true);
          await onRefreshError?.();
        },
      });
      if (result) setLastResult({ token: failure.retryToken, status: result.status });
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(failure.retryToken);
        return next;
      });
    }
  }, [onRecovered, onRefreshError, reload]);

  if (!loadError && failures.length === 0 && !lastResult) return null;

  const labelFor = (failure: CredentialRecoveryFailure) => {
    const name = failure.name ? ` · ${failure.name}` : "";
    switch (failure.kind) {
      case "api": return `${text("Saved API key", "저장된 API 키")}${name}`;
      case "api-metadata": return `${text("Saved API-key metadata", "저장된 API 키 메타데이터")}${name}`;
      case "env": return `${text("Saved connection key", "저장된 연결 키")}${name}`;
      case "secret": return `${text("Saved secret", "저장된 시크릿")}${name}`;
    }
  };
  const unavailableFor = (failure: CredentialRecoveryFailure) => {
    if (failure.status === "retrying") return text("Retrying this saved item…", "이 저장 항목에 다시 접근하는 중…");
    switch (failure.errorCode) {
      case "credential_attempt_incomplete":
        return text("The previous storage attempt did not complete.", "이전 저장소 접근 시도가 완료되지 않았습니다.");
      case "credential_recovery_busy":
        return text("Another recovery request for this saved item is in progress.", "이 저장 항목에는 다른 복원 요청이 진행 중입니다.");
      case "credential_recovery_state_invalid":
        return text("This recovery item could not be read. Retry this exact saved item again.", "이 복원 항목을 읽을 수 없습니다. 이 저장 항목만 다시 시도하세요.");
      default:
        return text("Saved storage is unavailable. It has not been treated as missing.", "저장소에 접근할 수 없습니다. 키가 없다고 처리하지 않았습니다.");
    }
  };
  const hasListGap = failures.some((failure) => failure.operation === "list");
  const resultText = lastResult && ({
    restored: text("Storage access was restored for the selected item.", "선택한 항목의 저장소 접근이 복원되었습니다."),
    missing: text("No saved value was found for the selected item.", "선택한 항목에 저장된 값이 없습니다."),
    unavailable: text("Storage access is still unavailable for the selected item.", "선택한 항목의 저장소에 아직 접근할 수 없습니다."),
    "invalid-token": text("This recovery item is no longer valid. Reloaded metadata may show its current state.", "이 복원 항목은 더 이상 유효하지 않습니다. 새로 읽은 메타데이터에서 현재 상태를 확인하세요."),
  } as const)[lastResult.status];

  return (
    <section aria-label={text("Saved credential access", "저장된 자격 증명 접근")} className="glass-strong" style={{ margin: "12px 0", padding: "12px 14px", borderRadius: "var(--radius-md)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <IconAlertTriangle size={16} style={{ color: "var(--peach-ink)", flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong style={{ fontSize: 13 }}>{text("Saved connection access needs attention", "저장된 연결 정보 접근을 확인하세요")}</strong>
            <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--muted-deep)" }}>{text("Retry only the item you choose. No retry runs automatically.", "선택한 항목만 다시 시도합니다. 자동 재시도는 하지 않습니다.")}</p>
          </div>
        </div>
        <button type="button" onClick={() => void reload(true)} style={secondaryButtonStyle} aria-label={text("Reload saved credential status", "저장된 연결 상태 새로고침")}>
          <IconRefresh size={13} /> {text("Reload", "새로고침")}
        </button>
      </div>
      {loadError && <p role="status" style={{ margin: "10px 0 0", fontSize: 12, color: "var(--peach-ink)" }}>{text("Saved credential metadata could not be reloaded. Reload only reads status; it does not retry storage access.", "저장된 연결 메타데이터를 다시 읽지 못했습니다. 새로고침은 상태만 읽으며 저장소 접근을 재시도하지 않습니다.")}</p>}
      {hasListGap && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--muted-deep)" }}>{text("Some manually added connection keys may not appear until storage listing is available again.", "저장소 목록을 다시 읽을 수 있을 때까지 일부 직접 추가한 연결 키가 보이지 않을 수 있습니다.")}</p>}
      {resultText && <p role="status" style={{ margin: "10px 0 0", fontSize: 12, color: lastResult?.status === "restored" ? "var(--green-deep)" : "var(--muted-deep)" }}>{resultText}</p>}
      {failures.length > 0 && <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "grid", gap: 8 }}>
        {failures.map((failure) => {
          const busy = failure.status === "retrying" || pending.has(failure.retryToken);
          return <li key={failure.retryToken} style={{ borderTop: "1px solid var(--paper-edge)", paddingTop: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 12.5, flex: "1 1 180px", wordBreak: "break-word" }}>{labelFor(failure)}</strong>
              <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>{failure.operation === "list" ? text("saved item list", "저장된 항목 목록") : text("saved item", "저장 항목")}</span>
              <button type="button" disabled={busy} onClick={() => void retry(failure)} style={{ ...secondaryButtonStyle, opacity: busy ? 0.6 : 1 }}>
                {busy ? <IconRefresh size={13} /> : <IconCheck size={13} />}{busy ? text("Retrying…", "재시도 중…") : text("Retry access", "접근 다시 시도")}
              </button>
            </div>
            <p style={{ margin: "4px 0 0", color: "var(--muted-deep)", fontSize: 12 }}>{unavailableFor(failure)}</p>
          </li>;
        })}
      </ul>}
    </section>
  );
}

const secondaryButtonStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--paper-edge)", borderRadius: 999,
  background: "var(--paper)", color: "var(--ink-soft)", padding: "5px 9px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
};
