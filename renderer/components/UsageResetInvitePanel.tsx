// Reset ticket + friend invite, drawn inside the credit balance popup. Both stay hidden unless the server sent
// `usage.resetTickets` (old server / switches off). Calls run in Main through billing IPC; nothing polls.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { ticketBlockedText, inviteClaimText, usageResetsSoon, ticketHeadLine, ticketHelpLine, ticketExpiryLine, ticketUsedLine, inviteRewardLine, inviteJoinedLine, inviteClaimHintLine } from "@/lib/usage-copy";
import type { HubUsage } from "@/lib/types";

const small = { margin: "6px 0 0", color: "var(--muted-deep)", lineHeight: 1.45, fontSize: 11.5 } as const;
const title = { color: "var(--ink)", fontWeight: 600, fontSize: 12 } as const;
const btn = { padding: "3px 9px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "transparent", color: "var(--ink)", fontSize: 11.5, cursor: "pointer" } as const;

export function UsageResetInvitePanel({ usage, ko, onUsage }: { usage: HubUsage; ko: boolean; onUsage: (next: HubUsage) => void }) {
  const tickets = usage.resetTickets;
  const [confirmSoon, setConfirmSoon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // One key per attempt: a retry after a lost answer reuses it, so a ticket cannot be spent twice.
  const keyRef = useRef<string | null>(null);

  const runReset = useCallback(async () => {
    const api = ipc();
    if (!api?.billing?.resetUsage || busy) return;
    keyRef.current ??= `reset-${crypto.randomUUID()}`;
    setBusy(true); setNote(null); setConfirmSoon(false);
    try {
      const result = await api.billing.resetUsage({ idempotencyKey: keyRef.current });
      if (result.ok) { keyRef.current = null; onUsage(result.usage); setNote(ko ? "리셋했어요" : "Reset done"); }
      else {
        // A network error keeps the key (retry is safe); every answer from the server ends the attempt.
        if (result.code !== "network") keyRef.current = null;
        setNote(ticketBlockedText(result.code, ko));
      }
    } catch { setNote(ticketBlockedText("network", ko)); }
    finally { setBusy(false); }
  }, [busy, ko, onUsage]);

  const [invite, setInvite] = useState<{ url: string; joined: number } | null>(null);
  // The invite section arrives a moment after the popup opens. Until then a hidden copy of it holds its height, so the "Use" row above it does not jump
  // under the person's pointer (the first press of the owner's reset landed where the button had been and only closed the popup).
  const [inviteLoading, setInviteLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimCode, setClaimCode] = useState("");
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const switchOn = tickets !== undefined;
  // Read once when the popup shows (a signal, not a timer). Any refusal, 404 included, hides the panel.
  useEffect(() => {
    if (!switchOn) { setInvite(null); setInviteLoading(false); return; }
    const api = ipc();
    if (!api?.billing?.friendInvite) { setInviteLoading(false); return; }
    let live = true;
    setInviteLoading(true);
    void api.billing.friendInvite()
      .then((r) => { if (live) setInvite(r.ok ? { url: r.url, joined: r.joined } : null); })
      .catch(() => { if (live) setInvite(null); })
      .finally(() => { if (live) setInviteLoading(false); });
    return () => { live = false; };
  }, [switchOn]);

  if (!tickets) return null;
  const shownInvite = invite ?? { url: "https://agentlas.cloud/invite/XXXXXXXX", joined: 0 };
  const canPress = tickets.available > 0 && tickets.canUse && !busy;
  const blockedText = tickets.available > 0 && !tickets.canUse && tickets.blocked ? ticketBlockedText(tickets.blocked, ko) : null;

  const claim = async () => {
    const api = ipc();
    if (!api?.billing?.claimFriendInvite || !claimCode.trim()) return;
    try {
      const r = await api.billing.claimFriendInvite({ inviteCode: claimCode });
      if (r.ok) { setClaimNote(r.ticketIssued ? (ko ? "리셋권을 받았어요" : "You got a reset ticket") : (ko ? "입력했어요" : "Entered")); setClaimOpen(false); setClaimCode(""); }
      else setClaimNote(inviteClaimText(r.code, ko));
    } catch { setClaimNote(inviteClaimText("network", ko)); }
  };

  const expiry = tickets.available > 0 ? ticketExpiryLine(tickets.nextExpiresAt, ko) : null;
  const usedLine = ticketUsedLine(tickets.usedThisWindow, ko);
  return (
    <div data-testid="usage-reset-invite" style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--paper-edge)" }}>
      {/* Reset tickets: what one is, what it does, how to get one. A bare "Reset tickets: 0" explained nothing and gave no way forward. */}
      <section aria-label={ko ? "리셋권" : "Reset tickets"} data-testid="usage-tickets">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={title}>{ticketHeadLine(tickets.available, ko)}</span>
          {tickets.available > 0 && !confirmSoon && (
            <button type="button" style={{ ...btn, opacity: canPress ? 1 : 0.5 }} disabled={!canPress}
              onClick={() => { if (usageResetsSoon(usage)) setConfirmSoon(true); else void runReset(); }}>
              {ko ? "쓰기" : "Use"}
            </button>
          )}
        </div>
        <p style={small}>{ticketHelpLine(tickets.available, ko)}</p>
        {expiry && <p style={small}>{expiry}</p>}
        {usedLine && <p style={small}>{usedLine}</p>}
        {confirmSoon && (
          <div role="alertdialog" aria-label={ko ? "곧 초기화돼요" : "Resets soon"}>
            <p style={small}>{ko ? "곧 초기화돼요. 그래도 쓸까요?" : "Resets soon. Use anyway?"}</p>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button type="button" style={btn} onClick={() => void runReset()}>{ko ? "그래도 쓰기" : "Use anyway"}</button>
              <button type="button" style={btn} onClick={() => setConfirmSoon(false)}>{ko ? "취소" : "Cancel"}</button>
            </div>
          </div>
        )}
        {(note ?? blockedText) && <p role="status" style={small}>{note ?? blockedText}</p>}
      </section>

      {(invite || inviteLoading) && (
        <section aria-label={ko ? "친구 초대" : "Invite a friend"} data-testid="usage-invite"
          style={{ marginTop: 14, ...(invite ? null : { visibility: "hidden" as const }) }} aria-hidden={invite ? undefined : true} data-invite-placeholder={invite ? undefined : "true"}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={title}>{ko ? "친구 초대" : "Invite a friend"}</span>
            <button type="button" style={btn} onClick={() => {
              void navigator.clipboard?.writeText(shownInvite.url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
            }}>{copied ? (ko ? "복사했어요" : "Copied") : (ko ? "링크 복사" : "Copy link")}</button>
          </div>
          <p style={small}>{inviteRewardLine(ko)}</p>
          <p style={{ ...small, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "all" }} title={shownInvite.url}>{shownInvite.url}</p>
          <p style={small}>{inviteJoinedLine(shownInvite.joined, ko)}</p>
          {!claimOpen
            ? <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => { setClaimOpen(true); setClaimNote(null); }}>{ko ? "친구 코드 입력" : "Enter a friend's code"}</button>
            : (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input value={claimCode} onChange={(e) => setClaimCode(e.target.value)} maxLength={8} spellCheck={false}
                  aria-label={ko ? "친구 코드" : "Friend's code"} style={{ flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 11.5, borderRadius: 6, border: "1px solid var(--paper-edge)", background: "transparent", color: "var(--ink)" }} />
                <button type="button" style={btn} onClick={() => void claim()}>{ko ? "확인" : "Apply"}</button>
              </div>
            )}
          <p style={small}>{inviteClaimHintLine(ko)}</p>
          {claimNote && <p role="status" style={small}>{claimNote}</p>}
        </section>
      )}
    </div>
  );
}
