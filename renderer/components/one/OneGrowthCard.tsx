"use client";

// One 홈 성장 제안 카드 (Phase 2+ 발화 UX).
// "에이전트가 배운 걸 반영할까요?" — 사람이 늘 보는 홈 슬롯에 고위험 제안 1건을 띄운다.
// 원시 diff가 아니라 "배운 핵심 → 다음 변경" 두 줄. 승인이 firm 상세에 묻혀
// 아무도 못 누르던 문제를 One 홈에서도 해결한다. 저위험 자동적용분은 여기 안 띄운다.
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { tFor } from "@/lib/i18n";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import type { AgentEvolutionProposalUi, GrowthProposalCardCopy } from "@/lib/types";

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

export function OneGrowthCard({ locale }: { locale: "ko" | "en" }) {
  const [top, setTop] = useState<AgentEvolutionProposalUi | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const inbox = await api.agentEvolution.listGrowth(10);
      const next = inbox.pending.find((p) => !dismissed.has(p.id) && cardCopy(p) !== null) ?? null;
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
  if (!card) return null;

  const apply = async () => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-growth", new Error("Desktop bridge unavailable"));
      return;
    }
    setBusy(true);
    try {
      await api.agentEvolution.approveAndApply(top.id);
      setDismissed((cur) => new Set(cur).add(top.id));
      setTop(null);
      window.dispatchEvent(new Event("agentlas:attention-refresh"));
    } catch (cause) {
      requestOneOperationalRecovery("one-growth", cause);
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
      <div style={{ display: "grid", gap: 4 }}>
        <span>{card.learned}</span>
        <span style={{ opacity: 0.85 }}>{card.change}</span>
      </div>
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
