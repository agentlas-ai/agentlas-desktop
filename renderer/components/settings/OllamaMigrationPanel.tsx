"use client";

import { useCallback, useEffect, useState } from "react";
import type { OllamaMigrationEntry, OllamaMigrationSnapshot } from "@shared/local-model-migration";
import {
  localModelMigrationApi,
  reconcileOneOllamaSelection,
} from "@/lib/ollama-migration";

export function OllamaMigrationPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const [snapshot, setSnapshot] = useState<OllamaMigrationSnapshot | null>(null);
  const [oneEntry, setOneEntry] = useState<OllamaMigrationEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async (mutate = false) => {
    const api = localModelMigrationApi();
    if (!api) return;
    setBusy(true);
    try {
      const result = mutate ? await api.reconcile() : await api.snapshot();
      setOneEntry(await reconcileOneOllamaSelection());
      setSnapshot(result);
      setNotice(null);
    } catch (error) {
      setNotice(`${ko ? "이전 상태를 확인하지 못했습니다" : "Could not check migration state"}: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }, [ko]);

  useEffect(() => { void refresh(false); }, [refresh]);

  if (!snapshot && !notice) return null;
  const entries = [...new Map([...(snapshot?.entries ?? []), ...(oneEntry ? [oneEntry] : [])]
    .map(entry => [entry.referenceHash, entry])).values()];
  const count = (state: OllamaMigrationEntry["state"]) => entries.filter(entry => entry.state === state).length;
  const unresolved = count("migration-needed") + count("paused-migration-needed") + count("conflict");
  return (
    <section aria-labelledby="ollama-migration-title" style={{ marginTop: 20, padding: 14, border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)" }}>
      <h3 id="ollama-migration-title" style={{ margin: 0, fontSize: 13 }}>{ko ? "기존 Ollama 설정 이전" : "Migrate existing Ollama settings"}</h3>
      <p style={{ margin: "7px 0 10px", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.55 }}>
        {unresolved > 0
          ? (ko ? `이전이 필요한 설정 ${unresolved}개가 남았습니다. 모델 이름이 아니라 실제 파일이 일치할 때만 Agentlas 로컬 모델로 바뀝니다.` : `${unresolved} settings still need migration. Agentlas switches only when the actual model file matches.`)
          : (ko ? "확인 가능한 기존 설정은 모두 처리되었습니다." : "All discoverable legacy settings have been handled.")}
      </p>
      {snapshot ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7, fontSize: 11.5 }}>
          <span>{ko ? "이전됨" : "Migrated"} {count("mapped")}</span>
          <span>· {ko ? "확인 필요" : "Needs attention"} {count("migration-needed")}</span>
          <span>· {ko ? "일시 중지된 자동화" : "Paused automations"} {count("paused-migration-needed")}</span>
          <span>· {ko ? "변경 충돌" : "Changed during migration"} {count("conflict")}</span>
          <span>· {ko ? "보존된 실행 기록" : "Preserved history"} {count("history-preserved")}</span>
        </div>
      ) : null}
      {snapshot?.entries.length || oneEntry ? (
        <details style={{ marginTop: 10, fontSize: 11.5 }}>
          <summary>{ko ? "요청 모델과 실제 연결 보기" : "View requested and actual bindings"}</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 7 }}>
            {entries.map((entry) => (
              <div key={entry.migrationId} style={{ overflowWrap: "anywhere" }}>
                <strong>{entry.authority}</strong> · {entry.requested.model ?? (ko ? "모델 미지정" : "no model")}
                {entry.state === "mapped" ? ` → ${entry.actual.model}` : ` · ${ko ? "같은 Ollama 설정 유지" : "Ollama binding preserved"}`}
                {entry.automationPaused ? ` · ${ko ? "자동화 일시 중지" : "automation paused"}` : ""}
                <div style={{ marginTop: 2, color: "var(--muted-deep)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5 }}>
                  {entry.state === "mapped"
                    ? `${entry.actual.source} · ${entry.actual.repository}@${entry.actual.revision} · ${entry.actual.fileSha256}`
                    : entry.reasonCodes.join(", ")}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <button type="button" disabled={busy} onClick={() => void refresh(true)} style={{ marginTop: 10, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "7px 10px", fontSize: 11.5, fontWeight: 650 }}>
        {busy ? (ko ? "확인 중…" : "Checking…") : (ko ? "설치 파일 다시 확인" : "Check installed files again")}
      </button>
      {notice ? <p role="status" style={{ margin: "8px 0 0", fontSize: 11.5 }}>{notice}</p> : null}
    </section>
  );
}
