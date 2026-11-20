"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { KeptRequestView } from "@shared/kept-requests";

/*
 * Requests the app keeps for an outside cause (a usage limit, a sign-in, no connection) and continues by itself, listed where a person looks
 * for scheduled work, each with its own cancel. Nothing is drawn while there are none. The list is read from Main (the claim rows of
 * invocation/host-recovery.ts); an older Main without the method draws nothing either, so no screen shows a list it cannot cancel.
 */
const CAUSE_WORDS: Record<string, { ko: string; en: string }> = {
  provider_limit: { ko: "사용 한도", en: "Usage limit" },
  provider_auth: { ko: "로그인 필요", en: "Sign-in needed" },
  network: { ko: "연결 문제", en: "Connection problem" },
  provider_outage: { ko: "모델 서비스 문제", en: "Model service problem" },
  internal: { ko: "앱 안쪽 문제", en: "App-side problem" },
};

export function KeptRequestsList({ locale, chatId }: { locale: "ko" | "en"; chatId?: string }) {
  const ko = locale === "ko";
  const copy = (a: string, b: string) => (ko ? a : b);
  const [items, setItems] = useState<KeptRequestView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    const read = ipc()?.automations?.keptRequests;
    if (!read) return;
    try {
      const rows = await read();
      if (alive.current) setItems(chatId ? rows.filter((row) => row.chatId === chatId) : rows);
    } catch { /* the list stays as it was; the next visit reads again */ }
  }, [chatId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = () => { if (document.visibilityState !== "hidden") void load(); };
    document.addEventListener("visibilitychange", refresh);
    // A request is kept at the moment a turn fails: a chat or run change is the signal to read again (no polling).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity !== "chat" && change.entity !== "task") return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; refresh(); }, 1_500);
    });
    return () => { alive.current = false; if (timer) clearTimeout(timer); off?.(); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  if (items.length === 0 && !note) return null;
  const cancel = async (id: string) => {
    const act = ipc()?.automations?.cancelKeptRequest;
    if (!act || busy) return;
    setBusy(id); setNote(null);
    try {
      const result = await act(id);
      setNote(result.ok ? copy("취소했어요. 이 요청은 다시 실행되지 않아요.", "Cancelled. This request will not run again.")
        : copy("이미 끝났거나 취소된 요청이에요.", "That request had already finished or been cancelled."));
    } catch { setNote(copy("취소 결과를 확인하지 못했어요. 목록을 다시 확인해 주세요.", "The cancel could not be confirmed. Check the list again.")); }
    finally { if (alive.current) setBusy(null); await load(); }
  };
  const pauseGoal = async (chat: string, goalId: string) => {
    const act = ipc()?.chats?.pauseGoal;
    if (!act || busy) return;
    setBusy(goalId); setNote(null);
    try { await act(chat, goalId); setNote(copy("목표를 일시정지했어요. 이 요청도 다시 실행되지 않아요.", "Goal paused. This request will not run again.")); }
    catch { setNote(copy("일시정지하지 못했어요. 목표 화면에서 다시 시도해 주세요.", "Could not pause. Try again from the goal bar.")); }
    finally { if (alive.current) setBusy(null); await load(); }
  };
  return (
    <section data-kept-requests="true" aria-label={copy("대기 중인 요청", "Waiting requests")} style={{ margin: "12px 0", padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
      <strong style={{ fontSize: 13 }}>{copy("대기 중인 요청", "Waiting requests")}</strong>
      <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--muted-deep)" }}>
        {copy("막혀서 보내지 못한 요청을 앱이 보관했다가 이어 갑니다. 여기서 취소할 수 있어요.", "Requests that could not be sent are kept and continued by the app. You can cancel one here.")}
      </p>
      {note ? <p role="status" style={{ margin: "0 0 8px", fontSize: 12 }}>{note}</p> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {items.map((item) => {
          const cause = CAUSE_WORDS[item.cause] ?? { ko: "일시적인 문제", en: "A temporary problem" };
          const next = item.nextCheckAt ? new Date(item.nextCheckAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US") : null;
          return (
            <li key={item.id} data-kept-request={item.id} style={{ display: "grid", gap: 2 }}>
              <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{item.promptPreview ?? item.chatTitle ?? copy("(내용 없음)", "(no text)")}</span>
              <small style={{ color: "var(--muted-deep)" }}>
                {ko ? cause.ko : cause.en} · {next ? copy(`${next}에 다시 확인`, `checks again ${next}`) : copy("상황이 바뀌면 이어집니다", "continues when something changes")}
                {item.asksAgainBeforeEffects ? ` · ${copy("삭제·전송은 이어 갈 때 다시 물어봐요", "a delete or send is asked about again")}` : ""}
              </small>
              <span style={{ display: "inline-flex", gap: 6 }}>
                {/* A request of a Goal is paused with the Goal (one action, one record: pausing closes this request too); a one-off request has Cancel only. */}
                {item.goalId ? <button type="button" disabled={busy !== null} onClick={() => void pauseGoal(item.chatId, item.goalId!)}>{copy("목표 일시정지", "Pause goal")}</button> : null}
                <button type="button" disabled={busy !== null} onClick={() => void cancel(item.id)}>{copy("취소", "Cancel")}</button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
