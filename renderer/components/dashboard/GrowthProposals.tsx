// 대시보드 "에이전트 성장 제안" 모듈 (Phase 2+ 발화 UX).
//   고위험 제안 = 사람이 결정([적용][나중에][안 함]) — 원시 diff 대신 "배운 것 → 바뀌는 것 → 되돌리기" 3줄.
//   저위험 자동적용분 = 수동태 "적용됨 · 되돌리기" 표기(언제든 undo).
// 승인이 firm 상세에 묻혀 아무도 못 누르던 문제를, 사람이 늘 보는 대시보드 인박스에 띄워 해결한다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import type { AgentEvolutionProposalUi, GrowthProposalCardCopy, GrowthProposalInbox } from "@/lib/types";

const POLL_MS = 15_000;

function cardCopy(proposal: AgentEvolutionProposalUi): GrowthProposalCardCopy | null {
  const raw = (proposal.source as Record<string, unknown>)?.humanCard;
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.learned !== "string" || typeof card.change !== "string" || typeof card.reversible !== "string") {
    return null;
  }
  const learned = card.learned.replace(/\s+/g, " ").trim();
  const change = card.change.replace(/\s+/g, " ").trim();
  const reversible = card.reversible.replace(/\s+/g, " ").trim();
  if (!learned || !change || !reversible || learned.length > 120 || change.length > 160 || reversible.length > 180) return null;
  return { learned, change, reversible };
}

export function GrowthProposals() {
  const { locale, t } = useT();
  const ko = locale === "ko";
  const [inbox, setInbox] = useState<GrowthProposalInbox | null>(() => (
    readViewData<GrowthProposalInbox>("dashboard.growth-proposals")?.value ?? null
  ));
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async (force = false) => {
    const api = ipc();
    if (!api) {
      setInbox({ pending: [], autoApplied: [] });
      return;
    }
    try {
      const next = await loadViewData(
        "dashboard.growth-proposals",
        () => api.agentEvolution.listGrowth(20),
        { maxAgeMs: POLL_MS, force },
      );
      setInbox(next);
    } catch {
      setInbox((cur) => cur ?? { pending: [], autoApplied: [] });
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load(true);
    window.addEventListener("agentlas:attention-refresh", refresh);
    return () => window.removeEventListener("agentlas:attention-refresh", refresh);
  }, [load]);
  useVisibleInterval(() => void load(true), POLL_MS);

  const act = useCallback(
    async (id: string, action: "apply" | "reject" | "rollback" | "delete") => {
      const api = ipc();
      if (!api) return;
      setBusy(id);
      try {
        if (action === "apply") await api.agentEvolution.approveAndApply(id);
        else if (action === "reject") await api.agentEvolution.reject(id);
        else if (action === "rollback") await api.agentEvolution.rollback(id);
        else await api.agentEvolution.deleteGrowthSession(id);
        await load(true);
        window.dispatchEvent(new Event("agentlas:attention-refresh"));
      } catch {
        // The dashboard never renders operational failures. The resident
        // recovery plane observes them and the current inbox stays intact.
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const deleteSession = useCallback((id: string) => {
    if (!window.confirm(t("one.growth.confirm_delete_session"))) return;
    void act(id, "delete");
  }, [act, t]);

  const proposalKey = (proposal: AgentEvolutionProposalUi) => {
    const card = cardCopy(proposal);
    return card ? `${card.learned}\u0000${card.change}` : `invalid:${proposal.id}`;
  };
  const dedupe = (items: AgentEvolutionProposalUi[]) => {
    const seen = new Set<string>();
    return items.filter((proposal) => {
      const key = proposalKey(proposal);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const pending = dedupe((inbox?.pending ?? []).filter((p) => !dismissed.has(p.id) && cardCopy(p) !== null));
  const autoApplied = dedupe((inbox?.autoApplied ?? []).filter((p) => cardCopy(p) !== null));
  const count = pending.length;

  if (inbox && count === 0 && autoApplied.length === 0) {
    return (
      <div id="growth-proposals" className="dashboard-module">
        <div className="dashboard-module-head">
          <span>{ko ? "에이전트 성장 제안" : "Agent growth proposals"}</span>
        </div>
        <div className="dashboard-module-empty">
          {ko ? "지금은 반영할 제안이 없어요." : "No growth proposals right now."}
        </div>
      </div>
    );
  }

  return (
    <div id="growth-proposals" className="dashboard-module" data-alert={count > 0 ? "true" : "false"}>
      <div className="dashboard-module-head" data-alert={count > 0 ? "true" : "false"} role="status" aria-live="polite">
        <span>{ko ? "에이전트 성장 제안" : "Agent growth proposals"}</span>
        {count > 0 && <span className="dashboard-count-pill">{count}</span>}
      </div>

      {inbox === null ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : (
        <>
          {autoApplied.length > 0 && (
            <div
              role="note"
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--border, rgba(120,120,120,0.2))",
                fontSize: 12,
                lineHeight: 1.5,
                opacity: 0.72,
              }}
            >
              {pending.length > 0
                ? (ko
                    ? "위 제안은 아직 선택 전이고, 아래 내역은 이미 학습이 반영된 성장입니다. 되돌리기는 성장 자체가 아니라 변경별 안전장치예요."
                    : "The proposals above still need a choice. The items below are completed growth; undo is a per-change safety control, not the growth action itself.")
                : (ko
                    ? "새 승인이 필요한 제안은 없어요. 아래는 이미 학습이 반영된 성장 내역이며, 되돌리기는 변경별 안전장치예요."
                    : "No proposals are awaiting approval. The items below are completed growth; undo is a per-change safety control.")}
            </div>
          )}
          {pending.map((proposal) => {
            const card = cardCopy(proposal);
            return (
              <div key={proposal.id} className="dashboard-module-row" style={{ display: "grid", gap: 8 }}>
                <div className="dashboard-row-copy" style={{ display: "grid", gap: 3 }}>
                  <span style={{ opacity: 0.68, fontSize: 12 }}>
                    {ko ? "승인 전 제안" : "Proposal awaiting approval"}
                  </span>
                  <strong>{card!.learned}</strong>
                  {card?.change && <div style={{ opacity: 0.78, fontSize: 13 }}>{card.change}</div>}
                  <div style={{ opacity: 0.68, fontSize: 12 }}>
                    {ko ? "안전장치" : "Safety"} · {card!.reversible}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => void act(proposal.id, "apply")}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                  >
                    {ko ? "적용" : "Apply"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => setDismissed((cur) => new Set(cur).add(proposal.id))}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                  >
                    {ko ? "나중에" : "Later"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => void act(proposal.id, "reject")}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                  >
                    {ko ? "안 함" : "Dismiss"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => deleteSession(proposal.id)}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                    data-destructive-action="true"
                  >
                    {t("one.growth.delete_session")}
                  </button>
                </div>
              </div>
            );
          })}

          {autoApplied.map((proposal) => {
            const card = cardCopy(proposal);
            const canUndo = proposal.status === "applied" || proposal.status === "measured";
            return (
              <div key={proposal.id} className="dashboard-module-row" style={{ alignItems: "start" }}>
                <div className="dashboard-row-copy" style={{ display: "grid", gap: 3 }}>
                  <span style={{ opacity: 0.68, fontSize: 12 }}>
                    {ko ? "성장 반영 완료 · 자동 적용" : "Growth completed · applied automatically"}
                  </span>
                  <strong>{card!.learned}</strong>
                  {card?.change && <div style={{ opacity: 0.78, fontSize: 13 }}>{card.change}</div>}
                  <div style={{ opacity: 0.68, fontSize: 12 }}>
                    {ko ? "안전장치" : "Safety"} · {card!.reversible}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {canUndo && (
                    <button
                      type="button"
                      disabled={busy === proposal.id}
                      onClick={() => void act(proposal.id, "rollback")}
                      className="titlebar-nodrag"
                      data-dashboard-action="true"
                    >
                      {ko ? "이 성장 변경만 되돌리기" : "Undo only this growth change"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => deleteSession(proposal.id)}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                    data-destructive-action="true"
                  >
                    {t("one.growth.delete_session")}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
