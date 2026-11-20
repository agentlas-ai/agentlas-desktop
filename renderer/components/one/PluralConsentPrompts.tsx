"use client";

/*
 * The consent chips waiting on THIS desktop: another of the person's agents wants to hand work to this desktop's personal agent, and the server holds it until the person answers
 * Allow / Always allow / Deny. Drawn above the composer next to the supervised approvals, one at a time ("1/3 · next"). The list is the server's answer kept in Main (pluralConsentAsks); Main says
 * when it changed (onPluralConsentChanged), so nothing here polls and nothing is stored. The chip carries the row id only; the server alone sends, so a second answer from another screen is
 * the first one (the chip then goes). The chip has no clock: an unanswered one ends on the server and is not sent.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ConsentChip, useOwnAgentName } from "@/components/PluralHandoffCards";
import { consentCopy, type ConsentChoice } from "@shared/plural-handoff-card";

interface Ask { id: string; from: string; fromName: string; brief: string; doneWhen?: string }

export function PluralConsentPrompts({ locale }: { locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [asks, setAsks] = useState<Ask[]>([]);
  const [index, setIndex] = useState(0);
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  const ownName = useOwnAgentName(asks.length > 0);

  const read = useCallback(async () => {
    const api = ipc();
    if (!api?.pluralConsentAsks) return;
    try { setAsks((await api.pluralConsentAsks()).asks); } catch { /* the list stays as it was; the next signal reads again */ }
  }, []);
  useEffect(() => {
    void read();
    return ipcEvents()?.onPluralConsentChanged?.(() => { void read(); });
  }, [read]);

  const shown = asks.length ? asks[Math.min(index, asks.length - 1)] : null;
  const copy = useMemo(() => shown ? consentCopy({
    fromName: shown.fromName || (shown.from === "phone" ? (ko ? "폰 에이전트" : "Phone agent") : ""),
    toName: ownName, brief: shown.brief, ...(shown.doneWhen ? { doneWhen: shown.doneWhen } : {}),
  }, ko) : null, [shown, ownName, ko]);
  if (!shown || !copy) return null;

  const choose = async (choice: ConsentChoice): Promise<void> => {
    const api = ipc();
    if (!api?.pluralHandoffAct || locked.has(shown.id)) return;
    setLocked((now) => new Set(now).add(shown.id));
    let settled = false;
    try { settled = (await api.pluralHandoffAct({ op: "consent", id: shown.id, answer: choice })).ok; } catch { /* not reached: the chip stays */ }
    // answered (or answered first elsewhere / ended): Main already took the row off its list and told us; a failed answer opens the chip again
    if (!settled) setLocked((now) => { const next = new Set(now); next.delete(shown.id); return next; });
    void read();
  };
  const deck = asks.length > 1 ? { index: Math.min(index, asks.length - 1), total: asks.length, onPrev: () => setIndex((i) => (i + asks.length - 1) % asks.length), onNext: () => setIndex((i) => (i + 1) % asks.length) } : undefined;
  return (
    <div data-plural-consent-prompts="true">
      <ConsentChip key={shown.id} copy={copy} locked={locked.has(shown.id)} onChoose={(choice) => { void choose(choice); }} {...(deck ? { deck } : {})} />
    </div>
  );
}
