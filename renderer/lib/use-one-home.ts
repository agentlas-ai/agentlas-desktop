"use client";

/**
 * The home screens' one reader and one door (F-D15 / F-D16). Reads `oneHome.status()` when a screen opens, when the window is focused again,
 * when the phone list changes (the pairing signal) and once after each of the owner's own commands. There is no timer.
 * A bridge without `oneHome` (an older preload, a browser preview) gives `null` and the screens draw nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OneHomeStatus } from "@shared/types";
import { ipc, ipcEvents } from "@/lib/ipc";
import { isReauthCode } from "@/lib/one-home-copy";
import { lineOf, type ActionLine } from "@/lib/one-home-view";

export function useOneHome(): { status: OneHomeStatus | null | undefined; reload: () => Promise<void> } {
  const [status, setStatus] = useState<OneHomeStatus | null | undefined>(undefined);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const api = ipc()?.oneHome;
    if (!api?.status) { if (alive.current) setStatus(null); return; }
    try { const next = await api.status(); if (alive.current) setStatus(next ?? null); } catch { if (alive.current) setStatus(null); }
  }, []);
  useEffect(() => {
    alive.current = true;
    // Opening the screen: one read of the server's pointer, then the status.
    void (async () => { try { await ipc()?.oneHome?.refresh?.({ reason: "screen" }); } catch { /* the status says what could be read */ } await reload(); })();
    const onFocus = () => { void reload(); };
    window.addEventListener("focus", onFocus);
    const off = ipcEvents()?.onMobileBridgeChanged?.(() => { void reload(); });
    return () => { alive.current = false; window.removeEventListener("focus", onFocus); off?.(); };
  }, [reload]);
  return { status, reload };
}

type Answer = { ok: boolean; code?: string; detail?: string; count?: number; actionId?: string };
export interface HomeActions {
  busy: string | null;
  /** The last "no", as the closed code (and the one detail / count the answer carried). Cleared by the next press. */
  line: ActionLine | null;
  /** A press that needs a fresh sign-in: the held action's id, until `signInAgain` finishes it. */
  reauth: { actionId: string } | null;
  /** The five reauth words (`reauth_cancelled` ...) after [Sign in again]. */
  reauthCode: string | null;
  press: (name: string, fn: () => Promise<Answer | null | undefined>) => Promise<Answer | null>;
  signInAgain: (actionId: string) => Promise<void>;
  clear: () => void;
}

/** One door for the owner's presses: keeps the closed code of a refusal, holds a `reauth_required` action and reads the status once afterwards. */
export function useHomeActions(reload: () => Promise<void>, pendingReauthId?: string | null): HomeActions {
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<ActionLine | null>(null);
  const [reauth, setReauth] = useState<{ actionId: string } | null>(null);
  const [reauthCode, setReauthCode] = useState<string | null>(null);
  const running = useRef(false);
  const press = useCallback(async (name: string, fn: () => Promise<Answer | null | undefined>): Promise<Answer | null> => {
    if (running.current) return null;
    running.current = true; setBusy(name); setLine(null); setReauthCode(null);
    let out: Answer | null = null;
    try { out = (await fn()) ?? null; } catch { out = { ok: false, code: "unknown" }; }
    if (out && !out.ok && isReauthCode(out.code) && out.actionId) { setReauth({ actionId: out.actionId }); setLine(null); setReauthCode("reauth_required"); }
    else setLine(lineOf(out));
    running.current = false; setBusy(null);
    await reload();
    return out;
  }, [reload]);
  const signInAgain = useCallback(async (actionId: string) => {
    if (running.current) return;
    running.current = true; setBusy("reauth"); setLine(null);
    let out: Answer | null = null;
    try { out = (await ipc()?.oneHome?.reauth?.({ actionId })) ?? null; } catch { out = { ok: false, code: "reauth_failed" }; }
    running.current = false; setBusy(null);
    // ok: the held press was run again with the new sign-in (a0db10bcd); the status shows what came of it.
    if (out?.ok) { setReauth(null); setReauthCode(null); } else { setReauthCode(out?.code ?? "reauth_failed"); if (out?.code === "action_expired" || out?.code === "no_such_action") setReauth(null); }
    await reload();
  }, [reload]);
  const clear = useCallback(() => { setLine(null); setReauthCode(null); }, []);
  const held = reauth ?? (pendingReauthId ? { actionId: pendingReauthId } : null);
  return { busy, line, reauth: held, reauthCode: held || reauthCode ? (reauthCode ?? "reauth_required") : null, press, signInAgain, clear };
}

/** The personal agent's own name from its profile (a profile still on the built-in default gets a generic word, never a fixed name). */
export function useAgentName(ko: boolean): string {
  const [name, setName] = useState("");
  useEffect(() => {
    let live = true;
    void Promise.resolve(ipc()?.oneProfile?.get?.()).then((p) => { if (live && p && typeof p.displayName === "string") setName(p.displayName.trim()); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return !name || name === "One" ? (ko ? "개인 에이전트" : "your agent") : name;
}
