// 대시보드 "에이전트 성장 제안" 모듈 (Phase 2+ 발화 UX).
//   고위험 제안 = 사람이 결정([적용][나중에][안 함]) — 원시 diff 대신 "배운 것 → 바뀌는 것 → 되돌리기" 3줄.
//   저위험 자동적용분 = 수동태 "적용됨 · 되돌리기" 표기(언제든 undo).
// 승인이 firm 상세에 묻혀 아무도 못 누르던 문제를, 사람이 늘 보는 대시보드 인박스에 띄워 해결한다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
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
  if (!learned || !change || learned.length > 120 || change.length > 160) return null;
  return { learned, change, reversible: card.reversible };
}

export function GrowthProposals() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [inbox, setInbox] = useState<GrowthProposalInbox | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setInbox({ pending: [], autoApplied: [] });
      return;
    }
    try {
      const next = await api.agentEvolution.listGrowth(20);
      setInbox(next);
    } catch {
      setInbox((cur) => cur ?? { pending: [], autoApplied: [] });
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("agentlas:attention-refresh", refresh);
    return () => window.removeEventListener("agentlas:attention-refresh", refresh);
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  const act = useCallback(
    async (id: string, action: "apply" | "reject" | "rollback") => {
      const api = ipc();
      if (!api) return;
      setBusy(id);
      try {
        if (action === "apply") await api.agentEvolution.approveAndApply(id);
        else if (action === "reject") await api.agentEvolution.reject(id);
        else await api.agentEvolution.rollback(id);
        await load();
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
          {pending.map((proposal) => {
            const card = cardCopy(proposal);
            return (
              <div key={proposal.id} className="dashboard-module-row" style={{ display: "grid", gap: 8 }}>
                <div className="dashboard-row-copy" style={{ display: "grid", gap: 3 }}>
                  <strong>{card!.learned}</strong>
                  {card?.change && <div style={{ opacity: 0.78, fontSize: 13 }}>{card.change}</div>}
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
                  <strong>{card!.learned}</strong>
                  {card?.change && <div style={{ opacity: 0.78, fontSize: 13 }}>{card.change}</div>}
                </div>
                {canUndo && (
                  <button
                    type="button"
                    disabled={busy === proposal.id}
                    onClick={() => void act(proposal.id, "rollback")}
                    className="titlebar-nodrag"
                    data-dashboard-action="true"
                  >
                    {ko ? "되돌리기" : "Undo"}
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
