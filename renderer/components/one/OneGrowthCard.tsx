"use client";

// One 홈 성장 제안 카드 (Phase 2+ 발화 UX).
// "에이전트가 배운 걸 반영할까요?" — 사람이 늘 보는 홈 슬롯에 고위험 제안 1건을 띄운다.
// 원시 diff가 아니라 "배운 것 → 바뀌는 것 → 되돌리기" 3줄. 승인이 firm 상세에 묻혀
// 아무도 못 누르던 문제를 One 홈에서도 해결한다. 저위험 자동적용분은 여기 안 띄운다.
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { tFor } from "@/lib/i18n";
import type { AgentEvolutionProposalUi, GrowthProposalCardCopy } from "@/lib/types";

function cardCopy(proposal: AgentEvolutionProposalUi): GrowthProposalCardCopy | null {
  const raw = (proposal.source as Record<string, unknown>)?.humanCard;
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.learned !== "string" || typeof card.change !== "string" || typeof card.reversible !== "string") {
    return null;
  }
  return { learned: card.learned, change: card.change, reversible: card.reversible };
}

export function OneGrowthCard({ locale }: { locale: "ko" | "en" }) {
  const [top, setTop] = useState<AgentEvolutionProposalUi | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const inbox = await api.agentEvolution.listGrowth(10);
      const next = inbox.pending.find((p) => !dismissed.has(p.id)) ?? null;
      setTop(next);
    } catch {
      setTop(null);
    }
  }, [dismissed]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!top) return null;
  const card = cardCopy(top);

  const apply = async () => {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    try {
      await api.agentEvolution.approveAndApply(top.id);
      setDismissed((cur) => new Set(cur).add(top.id));
      setTop(null);
      window.dispatchEvent(new Event("agentlas:attention-refresh"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={tFor(locale, "one.growth.title")}
      data-one-growth-card="true"
      style={{
        border: "1px solid var(--border, rgba(120,120,120,0.25))",
        borderRadius: 14,
        padding: 16,
        display: "grid",
        gap: 8,
        background: "var(--surface-soft, rgba(120,120,140,0.06))",
      }}
    >
      <strong>{tFor(locale, "one.growth.title")}</strong>
      {card ? (
        <div style={{ display: "grid", gap: 4 }}>
          <span>{card.learned}</span>
          <span style={{ opacity: 0.85 }}>{card.change}</span>
          <span style={{ opacity: 0.7, fontSize: 12 }}>{card.reversible}</span>
        </div>
      ) : (
        <span>{top.summary}</span>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="button" disabled={busy} onClick={() => void apply()}>
          {tFor(locale, "one.growth.apply")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDismissed((cur) => new Set(cur).add(top.id));
            setTop(null);
          }}
        >
          {tFor(locale, "one.growth.later")}
        </button>
      </div>
    </section>
  );
}
