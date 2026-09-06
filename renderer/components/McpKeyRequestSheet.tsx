"use client";

// 실행 전 API 키 요청 바텀시트 — 에이전트가 작업 중 PayPal/Klaviyo 같은 툴에
// 키가 필요하다고 판단하면 메인이 mcp-key-request 이벤트를 보내 이 시트가 뜬다.
//  - 입력값은 기존 env.set(키체인 vault)으로만 저장한다. mcp:supplyRunKeys IPC는
//    "provided"/"declined" 완료 신호만 나른다 — 비밀 값은 절대 싣지 않는다.
//  - [없이 진행]/시간초과면 메인이 해당 툴 없이 대안 지시 블록과 함께 계속 실행한다.
// 스타일은 BrowserActionApprovalSheet를 따른다(경량 고정 바텀시트).
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import type { McpRunKeyRequest } from "@/lib/types";
import { OneBottomSheet } from "@/components/one/OneBottomSheet";

export function McpKeyRequestSheet({
  request,
  onResolved,
  presentation = "work",
  localeOverride,
}: {
  request: McpRunKeyRequest;
  /** 시트를 닫아야 할 때 호출 — 저장/거절/만료 공통. */
  onResolved: (outcome: "provided" | "declined" | "expired") => void;
  presentation?: "work" | "one";
  localeOverride?: "ko" | "en";
}) {
  const { locale: appLocale } = useT();
  const locale = localeOverride ?? appLocale;
  const ko = locale === "ko";
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const allKeys = useMemo(
    () => request.tools.flatMap((tool) => tool.envKeys.map((envKey) => envKey.key)),
    [request],
  );
  const filledCount = allKeys.filter((key) => (values[key] ?? "").trim().length > 0).length;

  useEffect(() => {
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const expire = window.setTimeout(
      () => onResolved("expired"),
      Math.max(0, request.expiresAt - Date.now()),
    );
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(expire);
    };
    // onResolved is stable enough for this modal's lifetime; re-arm per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId, request.expiresAt]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const api = ipc();
      // 값은 vault로만 — 채운 키만 저장하고, 화면/로그 어디에도 값을 남기지 않는다.
      for (const key of allKeys) {
        const value = (values[key] ?? "").trim();
        if (value) await api?.env.set(key, value);
      }
      await api?.mcpTools.supplyRunKeys(request.runId, "provided");
    } finally {
      setValues({});
      setBusy(false);
      onResolved("provided");
    }
  };

  const decline = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc()?.mcpTools.supplyRunKeys(request.runId, "declined");
    } finally {
      setValues({});
      setBusy(false);
      onResolved("declined");
    }
  };

  const secondsLeft = Math.max(0, Math.ceil((request.expiresAt - now) / 1_000));

  const content = (
    <>
      <div className={`mkr ${presentation === "one" ? "mkr-one" : ""}`} data-testid="mcp-key-request-sheet">
        <div className="mkr-top">
          <span className="mkr-tag">{ko ? "API 키 필요" : "API keys needed"}</span>
          <span className="mkr-timer">
            {ko ? `${secondsLeft}초 안에 선택` : `Choose within ${secondsLeft}s`}
          </span>
        </div>
        <div className="mkr-summary">
          {ko
            ? "이 작업에 필요한 도구가 API 키를 요구합니다. 키를 저장하면 이번 실행부터 바로 사용됩니다."
            : "A tool needed for this task requires API keys. Saved keys are used starting with this run."}
        </div>
        <div className="mkr-note">
          {ko
            ? "키가 없거나 건너뛰면 남은 도구로 대안을 찾아 계속 진행합니다. 값은 키체인에만 저장됩니다."
            : "If you skip, the agent continues with an alternative from the available tools. Values are stored only in your keychain."}
        </div>
        <div className="mkr-tools">
          {request.tools.map((tool) => (
            <div className="mkr-tool" key={tool.id}>
              <div className="mkr-tool-head">
                <span className="mkr-tool-name">{tool.name}</span>
                {tool.setupUrl && (
                  <a
                    className="mkr-setup"
                    href={tool.setupUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {ko ? "키 발급 →" : "Get a key →"}
                  </a>
                )}
              </div>
              {tool.envKeys.map((envKey) => (
                <label className="mkr-field" key={envKey.key}>
                  <span className="mkr-key">
                    {ko
                      ? envKey.label || envKey.labelEn || envKey.key
                      : envKey.labelEn || envKey.key}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={envKey.key}
                    value={values[envKey.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [envKey.key]: e.target.value }))
                    }
                  />
                  {(ko ? envKey.hint : envKey.hintEn) || envKey.hintEn ? (
                    <span className="mkr-hint">{(ko ? envKey.hint : envKey.hintEn) || envKey.hintEn}</span>
                  ) : null}
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="mkr-actions">
          <button className="skip" onClick={() => void decline()} disabled={busy} data-testid="mcp-key-skip">
            {ko ? "없이 진행" : "Continue without"}
          </button>
          <button
            className="save"
            onClick={() => void save()}
            disabled={busy || filledCount === 0}
            data-testid="mcp-key-save"
          >
            {ko ? "저장하고 계속" : "Save and continue"}
          </button>
        </div>
      </div>
      <style jsx>{`
        .mkr-wrap {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          justify-content: center;
          padding: 0 16px 20px;
          z-index: 90;
          pointer-events: none;
        }
        .mkr {
          pointer-events: auto;
          width: var(--popup-3-width);
          max-height: min(70vh, 560px);
          overflow-y: auto;
          background: var(--rd-bg);
          color: var(--rd-ink);
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.12));
          border-radius: 16px;
          padding: 16px 18px;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
          animation: mkr-in 0.16s ease-out;
        }
        @keyframes mkr-in {
          from {
            transform: translateY(14px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .mkr {
            animation: none;
          }
        }
        .mkr-top {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .mkr-tag {
          font-size: 11.5px;
          font-weight: 800;
          padding: 2px 9px;
          border-radius: 999px;
          background: var(--rd-accent);
          color: var(--white);
        }
        .mkr-timer {
          font-size: 12px;
          opacity: 0.6;
        }
        .mkr-summary {
          font-size: 14px;
          line-height: 1.5;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .mkr-note {
          font-size: 12px;
          opacity: 0.6;
          margin-bottom: 10px;
        }
        .mkr-tool {
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.1));
          border-radius: 12px;
          padding: 10px 12px;
          margin-bottom: 8px;
        }
        .mkr-tool-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .mkr-tool-name {
          font-size: 13px;
          font-weight: 700;
        }
        .mkr-setup {
          font-size: 12px;
          color: var(--rd-accent);
          text-decoration: none;
        }
        .mkr-field {
          display: flex;
          flex-direction: column;
          gap: 3px;
          margin-bottom: 8px;
        }
        .mkr-key {
          font-size: 12px;
          font-weight: 600;
          opacity: 0.85;
        }
        .mkr-field input {
          border-radius: 8px;
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.14));
          background: rgba(255, 255, 255, 0.04);
          color: var(--rd-ink);
          padding: 8px 10px;
          font-size: 13px;
          font-family: ui-monospace, Menlo, monospace;
        }
        .mkr-hint {
          font-size: 11.5px;
          opacity: 0.55;
        }
        .mkr-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 12px;
        }
        .mkr-actions button {
          border-radius: 9px;
          padding: 8px 15px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          border: 1px solid var(--rd-hair, rgba(255, 255, 255, 0.14));
          background: none;
          color: var(--rd-ink);
        }
        .mkr-actions button:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .mkr-actions .skip {
          margin-right: auto;
        }
        .mkr-actions .save {
          background: var(--rd-accent);
          color: var(--white);
          border-color: transparent;
        }
        .mkr-one {
          width: auto;
          max-height: min(58vh, 520px);
          margin: 0;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: var(--one-sheet-ink);
          box-shadow: none;
          animation: none;
        }
        .mkr-one .mkr-tag,
        .mkr-one .mkr-summary {
          display: none;
        }
        .mkr-one .mkr-top {
          justify-content: flex-end;
        }
        .mkr-one .mkr-note,
        .mkr-one .mkr-timer,
        .mkr-one .mkr-hint {
          color: var(--one-sheet-muted);
          opacity: 1;
        }
        .mkr-one .mkr-tool {
          border-color: var(--one-sheet-control-border);
          border-radius: var(--one-sheet-card-radius);
          background: var(--one-sheet-card-surface);
        }
        .mkr-one .mkr-setup {
          color: var(--one-sheet-accent);
        }
        .mkr-one .mkr-field input {
          min-height: var(--one-sheet-control-height);
          border-color: var(--one-sheet-control-border);
          border-radius: var(--one-sheet-control-radius);
          background: var(--one-sheet-control-surface);
          color: var(--one-sheet-ink);
        }
        .mkr-one .mkr-field input:focus {
          outline: none;
          border-color: var(--one-sheet-accent);
          box-shadow: var(--one-sheet-focus);
        }
        .mkr-one .mkr-actions button {
          min-height: var(--one-sheet-control-height);
          border-color: var(--one-sheet-control-border);
          border-radius: var(--one-sheet-control-radius);
          color: var(--one-sheet-ink);
        }
        .mkr-one .mkr-actions button:focus-visible {
          outline: none;
          box-shadow: var(--one-sheet-focus);
        }
        .mkr-one .mkr-actions .save {
          border-color: var(--one-sheet-primary);
          background: var(--one-sheet-primary);
          color: var(--white);
        }
      `}</style>
    </>
  );

  if (presentation === "one") {
    return (
      <OneBottomSheet
        open
        onClose={() => void decline()}
        closeLabel={ko ? "키 없이 계속" : "Continue without keys"}
        ariaLabelledBy="one-mcp-key-request-title"
        dialogRole="alertdialog"
        closeOnBackdrop={false}
        closeOnEscape={false}
        closeDisabled={busy}
        eyebrow={ko ? "API 키 필요" : "API keys required"}
        title={ko ? "도구 연결이 필요해요" : "Connect the required tool"}
        titleId="one-mcp-key-request-title"
        description={ko
          ? "필요한 키를 저장하면 이번 실행부터 사용합니다. 값은 키체인에만 저장됩니다."
          : "Save the required keys to use them in this run. Values stay in your keychain."}
      >
        {content}
      </OneBottomSheet>
    );
  }

  return <div className="mkr-wrap" role="alertdialog" aria-live="assertive">{content}</div>;
}
