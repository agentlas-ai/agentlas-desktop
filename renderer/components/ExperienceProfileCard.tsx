"use client";

// 경험 프로필 카드 — 에이전트가 실제로 무엇을 배웠고, 무엇이 장착되어 있으며,
// 왜 일부 경험이 적립되지 않았는지를 한 카드에서 설명하는 표면.
// 데이터는 전부 로컬 IPC(요약/후보/적립 진단)와 Hub 장착 상태에서 온다.

import { useEffect, useMemo, useState } from "react";

import { ipc } from "@/lib/ipc";
import type {
  AgentOntologyHubProjection,
  ExperienceCandidateRecord,
  ExperienceIntakeDiagnostics,
  ExperienceOntologySummary,
  InstalledAgent,
} from "@shared/types";

type Locale = "ko" | "en";

const REASON_LABELS: Record<string, [string, string]> = {
  "local-path-or-url": ["개인 경로·URL이 들어 있어 원문을 저장하지 않았습니다.", "Contained a private path or URL, so the source was not saved."],
  email: ["이메일 주소가 감지되어 저장하지 않았습니다.", "An email address was detected, so it was not saved."],
  "phone-or-long-number": ["전화번호·긴 식별 번호가 감지되었습니다.", "A phone number or long identifier was detected."],
  "account-identifier": ["계정·고객 식별자가 감지되었습니다.", "An account or customer identifier was detected."],
  "opaque-identifier": ["다른 곳에서 쓸 수 없는 고유 식별자가 감지되었습니다.", "A non-portable opaque identifier was detected."],
  "secret-value": ["키·토큰 같은 비밀값이 감지되어 차단했습니다.", "A secret such as a key or token was detected and blocked."],
  "sensitive-memory": ["기밀로 분류된 기록이라 적립하지 않았습니다.", "The record is confidential, so it was not accrued."],
  "unsupported-sensitivity": ["민감도 분류가 확인되지 않아 보류했습니다.", "Held because the sensitivity label could not be confirmed."],
  "preference-requires-taste-evidence": ["취향 기록은 사람 A/B 근거가 있어야 칩이 됩니다.", "Preference records need human A/B evidence to become chips."],
  "preference-captured-as-private-taste-draft": ["취향 후보로 따로 보관했습니다. 사람 근거가 필요합니다.", "Kept separately as a taste draft; human evidence is required."],
  "non-operational-memory-kind": ["재사용 가능한 실행 경험이 아니라서 건너뛰었습니다.", "Skipped because it is not reusable operational experience."],
  "task-taxonomy-unavailable": ["어떤 작업 유형인지 아직 분류하지 못했습니다.", "The task type could not be classified yet."],
  "exact-base-unavailable": ["에이전트의 정확한 기준 버전을 확인하지 못했습니다.", "The agent's exact base version could not be confirmed."],
  "environment-taxonomy-unavailable": ["실행 환경 정보를 확인하지 못했습니다.", "The execution environment could not be confirmed."],
  "raw-prompt-or-transcript": ["프롬프트·대화 원문이라 저장하지 않았습니다.", "It was a raw prompt or transcript, so it was not saved."],
  "redacted-admit": ["민감한 부분만 지운 뒤 안전하게 적립했습니다.", "Accrued safely after redacting the sensitive spans."],
  "invalid-local-receipt": ["손상된 적립 기록이라 집계에서 제외했습니다.", "Excluded a damaged accrual record from the tally."],
};

function reasonLabel(code: string, locale: Locale): string {
  const pair = REASON_LABELS[code];
  return pair ? pair[locale === "ko" ? 0 : 1] : code;
}

function candidateStatusLabel(candidate: ExperienceCandidateRecord, locale: Locale): { text: string; tone: "green" | "amber" | "muted" } {
  const ko = locale === "ko";
  if (candidate.status === "promoted") {
    return candidate.publicSafe
      ? { text: ko ? "공개 가능" : "Public-ready", tone: "green" }
      : { text: ko ? "검증됨" : "Reviewed", tone: "green" };
  }
  if (candidate.status === "rejected") return { text: ko ? "제외됨" : "Rejected", tone: "muted" };
  return { text: ko ? "후보" : "Candidate", tone: "amber" };
}

export function ExperienceProfileCard({
  agent,
  summary,
  hub,
  locale,
}: {
  agent: InstalledAgent | null;
  summary: ExperienceOntologySummary | null;
  hub: AgentOntologyHubProjection | null;
  locale: Locale;
}) {
  const ko = locale === "ko";
  const [candidates, setCandidates] = useState<ExperienceCandidateRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<ExperienceIntakeDiagnostics | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api || !agent?.id) {
      setCandidates([]);
      setDiagnostics(null);
      return;
    }
    let cancelled = false;
    setLoadFailed(false);
    void (async () => {
      try {
        const packs = await api.experience.listPacks({ agentId: agent.id });
        const perPack = await Promise.all(
          packs.slice(0, 8).map((pack) => api.experience.listCandidates(pack.id).catch(() => [])),
        );
        if (!cancelled) {
          setCandidates(perPack.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
      try {
        const next = await api.experience.intakeDiagnostics(agent.id);
        if (!cancelled && next && typeof next === "object") setDiagnostics(next);
      } catch {
        // Diagnostics stay optional; the funnel section explains their absence.
      }
    })();
    return () => { cancelled = true; };
  }, [agent?.id]);

  const equippedChips = useMemo(() => {
    type EquippedChip = { id: string; name: string; kind: "operational" | "taste" };
    const projection = hub?.projection;
    if (!projection) return [] as EquippedChip[];
    const byId = new Map<string, { name: string; kind: "operational" | "taste" }>();
    for (const chip of projection.operationalChips) byId.set(chip.chipId, { name: chip.displayName, kind: "operational" });
    for (const chip of projection.tasteChips) byId.set(chip.chipId, { name: chip.displayName, kind: "taste" });
    const equipped: EquippedChip[] = [];
    for (const entry of projection.loadout.entries) {
      const chip = byId.get(entry.chipId);
      if (chip) equipped.push({ id: `${entry.chipId}:${entry.releaseId}`, name: chip.name, kind: chip.kind });
    }
    return equipped;
  }, [hub]);

  const publicReadyCount = candidates.filter((candidate) => candidate.status === "promoted" && candidate.publicSafe).length;
  const recent = candidates.slice(0, 5);
  const blockedReasons = (diagnostics?.reasons ?? []).filter((reason) => reason.status !== "candidate-created").slice(0, 6);
  const redactedReason = (diagnostics?.reasons ?? []).find((reason) => reason.code === "redacted-admit");

  // 미바인딩 조직 노드: 적립할 실제 에이전트가 없다.
  if (!agent) {
    return (
      <section data-testid="experience-profile-card" data-profile-state="unbound" style={cardStyle}>
        <strong style={{ fontSize: 13 }}>{ko ? "경험 적립 불가" : "Experience cannot accrue"}</strong>
        <p style={{ margin: "6px 0 0", color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.55 }}>
          {ko
            ? "이 항목은 조직도 자리일 뿐 실제 에이전트가 연결되어 있지 않습니다. 실제 에이전트를 연결해야 작업 경험이 쌓입니다."
            : "This is only an org-chart slot with no real agent connected. Connect a real agent so work experience can accrue."}
        </p>
      </section>
    );
  }

  const funnel = [
    [ko ? "후보" : "Candidates", summary?.candidateCount ?? candidates.length],
    [ko ? "검증" : "Reviewed", summary?.promotedCount ?? 0],
    [ko ? "공개 가능" : "Public-ready", publicReadyCount],
    [ko ? "장착" : "Equipped", equippedChips.length],
  ] as const;

  return (
    <section data-testid="experience-profile-card" data-profile-state="agent" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>{ko ? "경험 프로필" : "Experience profile"}</strong>
        <span style={{ color: "var(--muted-deep)", fontSize: 10.5 }}>
          {ko ? "실제 작업에서 배운 것만 집계합니다" : "Counts only what was learned from real work"}
        </span>
      </div>

      {/* 퍼널 */}
      <div data-testid="experience-profile-funnel" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
        {funnel.map(([label, value], index) => (
          <div key={label} style={{ position: "relative", padding: "9px 10px", border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper-2)", minWidth: 0 }}>
            <div style={{ color: "var(--muted-deep)", fontSize: 10 }}>{label}</div>
            <strong style={{ fontSize: 18, color: index === 3 ? "var(--accent)" : "var(--ink)" }}>{value}</strong>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10, marginTop: 10 }}>
        {/* 최근 경험 — 실제 제목 */}
        <div data-testid="experience-profile-recent" style={sectionStyle}>
          <strong style={{ fontSize: 11.5 }}>{ko ? "최근 경험" : "Recent experience"}</strong>
          {recent.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 7 }}>
              {recent.map((candidate) => {
                const status = candidateStatusLabel(candidate, locale);
                return (
                  <div key={candidate.id} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span
                      style={{
                        flexShrink: 0,
                        padding: "2px 6px",
                        borderRadius: 999,
                        fontSize: 9,
                        fontWeight: 750,
                        color: status.tone === "green" ? "var(--green-deep)" : status.tone === "amber" ? "var(--amber-deep)" : "var(--muted-deep)",
                        background: status.tone === "green" ? "var(--green-soft)" : status.tone === "amber" ? "var(--amber-soft)" : "var(--fill-1)",
                      }}
                    >
                      {status.text}
                    </span>
                    <span title={candidate.summary} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)", fontSize: 11.5 }}>
                      {candidate.summary}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ margin: "7px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.55 }}>
              {loadFailed
                ? (ko ? "최근 경험을 불러오지 못했습니다." : "Recent experience could not be loaded.")
                : (ko
                  ? "아직 적립된 경험이 없습니다. 이 에이전트로 실제 작업을 완료하면 배운 해결법이 자동으로 후보에 올라옵니다."
                  : "No experience yet. Complete real work with this agent and learned solutions will appear as candidates automatically.")}
            </p>
          )}
        </div>

        {/* 장착 칩 */}
        <div data-testid="experience-profile-equipped" style={sectionStyle}>
          <strong style={{ fontSize: 11.5 }}>{ko ? "장착된 경험 칩" : "Equipped experience chips"}</strong>
          {equippedChips.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
              {equippedChips.map((chip) => (
                <span key={chip.id} style={{ padding: "3px 8px", borderRadius: 999, border: "1px solid var(--paper-edge)", background: chip.kind === "taste" ? "var(--amber-soft)" : "var(--green-soft)", color: chip.kind === "taste" ? "var(--amber-deep)" : "var(--green-deep)", fontSize: 10.5, fontWeight: 700 }}>
                  {chip.name}
                </span>
              ))}
            </div>
          ) : (
            <p style={{ margin: "7px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.55 }}>
              {ko ? "지금 장착된 칩이 없습니다. 아래 Hub 카드에서 칩을 장착할 수 있습니다." : "No chips are equipped. You can equip chips from the Hub card below."}
            </p>
          )}
        </div>
      </div>

      {/* 적립 안 된 이유 */}
      <details data-testid="experience-profile-diagnostics" style={{ marginTop: 10, border: "1px solid var(--paper-edge)", borderRadius: 9, background: "var(--paper-2)", overflow: "hidden" }}>
        <summary style={{ listStyle: "none", cursor: "pointer", minHeight: 40, padding: "8px 10px", display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
          <strong>{ko ? "적립 안 된 이유" : "Why some experience did not accrue"}</strong>
          {diagnostics && (
            <span style={{ color: "var(--muted-deep)", fontSize: 10 }}>
              {ko
                ? `적립 ${diagnostics.totals.candidateCreated} · 차단 ${diagnostics.totals.blocked} · 건너뜀 ${diagnostics.totals.skipped}`
                : `accrued ${diagnostics.totals.candidateCreated} · blocked ${diagnostics.totals.blocked} · skipped ${diagnostics.totals.skipped}`}
            </span>
          )}
          <span aria-hidden="true" style={{ marginLeft: "auto", width: 6, height: 6, borderRight: "1.5px solid currentColor", borderBottom: "1.5px solid currentColor", transform: "rotate(45deg)", color: "var(--muted-deep)" }} />
        </summary>
        <div style={{ padding: "0 10px 10px", borderTop: "1px solid var(--paper-edge)" }}>
          {diagnostics ? (
            <>
              {redactedReason && (
                <p style={{ margin: "8px 0 0", color: "var(--green-deep)", fontSize: 10.5, lineHeight: 1.5 }}>
                  {ko
                    ? `민감한 부분을 지우고 적립한 경험 ${diagnostics.redactedAdmits.receipts}건 (지운 구간 ${diagnostics.redactedAdmits.redactedSpans}곳)`
                    : `${diagnostics.redactedAdmits.receipts} experiences accrued after redaction (${diagnostics.redactedAdmits.redactedSpans} spans removed)`}
                </p>
              )}
              {blockedReasons.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
                  {blockedReasons.map((reason) => (
                    <div key={`${reason.status}:${reason.code}`} style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                      <strong style={{ flexShrink: 0, minWidth: 20, textAlign: "right", color: "var(--ink)", fontSize: 11 }}>{reason.count}</strong>
                      <span title={reason.code} style={{ color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.5 }}>{reasonLabel(reason.code, locale)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", fontSize: 10.5 }}>
                  {ko ? "차단되거나 건너뛴 경험이 없습니다." : "Nothing was blocked or skipped."}
                </p>
              )}
              <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", fontSize: 10, lineHeight: 1.5 }}>
                {ko
                  ? "개인정보가 감지된 원문은 이 Mac 밖으로 나가지 않으며, 원문 대신 사유 코드만 집계합니다."
                  : "Source text with personal data never leaves this Mac; only reason codes are tallied, never the source."}
              </p>
            </>
          ) : (
            <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", fontSize: 10.5 }}>
              {ko ? "적립 진단 기록이 아직 없습니다." : "No accrual diagnostics recorded yet."}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 14,
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
};

const sectionStyle: React.CSSProperties = {
  padding: 10,
  border: "1px solid var(--paper-edge)",
  borderRadius: 9,
  background: "var(--paper-2)",
  minWidth: 0,
};
