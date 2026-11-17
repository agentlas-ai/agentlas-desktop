// Reset ticket + friend invite, drawn inside the credit balance popup. Both stay hidden unless the server sent
// `usage.resetTickets` (old server / switches off). Calls run in Main through billing IPC; nothing polls.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { ticketBlockedText, inviteClaimText, usageResetsSoon } from "@/lib/usage-copy";
import type { HubUsage } from "@/lib/types";

const small = { margin: "6px 0 0", color: "var(--muted-deep)", lineHeight: 1.45, fontSize: 11.5 } as const;
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
  const [copied, setCopied] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimCode, setClaimCode] = useState("");
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const switchOn = tickets !== undefined;
  // Read once when the popup shows (a signal, not a timer). Any refusal, 404 included, hides the panel.
  useEffect(() => {
    if (!switchOn) { setInvite(null); return; }
    const api = ipc();
    if (!api?.billing?.friendInvite) return;
    let live = true;
    void api.billing.friendInvite().then((r) => { if (live) setInvite(r.ok ? { url: r.url, joined: r.joined } : null); }).catch(() => { if (live) setInvite(null); });
    return () => { live = false; };
  }, [switchOn]);

  if (!tickets) return null;
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

  return (
    <div data-testid="usage-reset-invite" style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--paper-edge)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--muted-deep)" }}>{ko ? `리셋권 ${tickets.available}장` : `Reset tickets: ${tickets.available}`}</span>
        {tickets.available > 0 && !confirmSoon && (
          <button type="button" style={{ ...btn, opacity: canPress ? 1 : 0.5 }} disabled={!canPress}
            onClick={() => { if (usageResetsSoon(usage)) setConfirmSoon(true); else void runReset(); }}>
            {ko ? "쓰기" : "Use"}
          </button>
        )}
      </div>
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

      {invite && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--muted-deep)" }}>{ko ? "친구 초대" : "Invite a friend"}</span>
            <button type="button" style={btn} onClick={() => {
              void navigator.clipboard?.writeText(invite.url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
            }}>{copied ? (ko ? "복사했어요" : "Copied") : (ko ? "복사" : "Copy")}</button>
          </div>
          <p style={{ ...small, wordBreak: "break-all", userSelect: "all" }}>{invite.url}</p>
          <p style={small}>{ko ? `가입한 친구 ${invite.joined}명` : `Friends joined: ${invite.joined}`}</p>
          {!claimOpen
            ? <button type="button" style={{ ...btn, marginTop: 6 }} onClick={() => { setClaimOpen(true); setClaimNote(null); }}>{ko ? "받은 코드 입력" : "Enter a code"}</button>
            : (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input value={claimCode} onChange={(e) => setClaimCode(e.target.value)} maxLength={8} spellCheck={false}
                  aria-label={ko ? "초대 코드" : "Invite code"} style={{ flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 11.5, borderRadius: 6, border: "1px solid var(--paper-edge)", background: "transparent", color: "var(--ink)" }} />
                <button type="button" style={btn} onClick={() => void claim()}>{ko ? "확인" : "Apply"}</button>
              </div>
            )}
          {claimNote && <p role="status" style={small}>{claimNote}</p>}
        </div>
      )}
    </div>
  );
}
