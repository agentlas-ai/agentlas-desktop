"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Chat } from "@shared/types";
import { ipc, ipcEvents } from "@/lib/ipc";
import { createTrailingDebounce } from "@/lib/store-change-policy";
import { taskTitleForDisplay } from "@/lib/task-title";
import { useT } from "@/lib/i18n";
import { WorkChatSurface } from "@/components/TaskCockpit";
import { openPricing } from "@/components/UpgradeCta";
import { IconPlus, IconRefresh, IconSparkles } from "@/components/Icon";
import { ComposerMenuExtensions, type ComposerMenuExtension } from "@/lib/composer-menu-extensions";
import type { FinanceAnalystResult } from "@shared/finance-analysts";
import { financeAnalystDescription, financeAnalystName } from "./FinanceAnalysts";
import styles from "./FinanceWorkChat.module.css";

interface FinanceWorkProject { ownerScope: string; projectId: string }
export interface FinanceWorkChatProps {
  ownerScope: string | null;
  provisionProject: () => Promise<FinanceWorkProject>;
  /** The owner's Analysts, offered in the Work composer's + menu (a generic composer extension, not a Finance composer). */
  listAnalysts?: () => Promise<FinanceAnalystResult>;
  /** Puts a starter prompt in the conversation's composer (the same draft hand-off the dashboard buttons use). */
  onStarter?: (text: string) => void;
}

/** The one sentence a Finance conversation shows when the turn ended because the credit balance is empty. */
export function creditsOutSentence(ko: boolean): string {
  return ko ? "크레딧이 모두 소진되었습니다. 충전하거나 다른 모델을 선택해 계속하세요." : "You are out of credits. Top up, or choose another model, to keep going.";
}

/** Finance's own starter prompts for an empty conversation, in both languages. */
export function financeStarterPrompts(ko: boolean): readonly string[] {
  return ko
    ? ["오늘 시장 흐름을 알려줘", "내 보유 종목을 점검해줘", "AAPL과 MSFT를 비교해줘", "관심 종목을 모니터링해줘"]
    : ["How are the markets doing today?", "Review my holdings", "Compare AAPL and MSFT", "Monitor my watchlist for me"];
}

/** The text an Analyst pick puts in the message: its exact id and revision, which finance.analyst.read takes. */
export function financeAnalystMentionText(item: { id: string; name: string; revision: string }): string {
  return `[Analyst: ${item.name} · id ${item.id} · revision ${item.revision}]`;
}

/** Only real Work chats returned for the owning project enter the selector. */
export function financeProjectChats(chats: readonly Chat[], projectId: string): Chat[] {
  return chats.filter(chat => chat.projectId === projectId && chat.kind === "user" && !chat.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

type PointerStorage = Pick<Storage, "getItem" | "setItem">;
export function financeWorkChatPointerKey(ownerScope: string, projectId: string): string {
  return `agentlas.finance.active-work-chat.v1:${JSON.stringify([ownerScope, projectId])}`;
}
export function financeReadWorkChatPointer(ownerScope: string, projectId: string, chats: readonly Chat[], storage?: PointerStorage): string | null {
  try {
    const saved = (storage ?? window.localStorage).getItem(financeWorkChatPointerKey(ownerScope, projectId));
    return saved && financeProjectChats(chats, projectId).some(chat => chat.id === saved) ? saved : null;
  } catch { return null; }
}
export function financeRememberWorkChat(ownerScope: string, projectId: string, chatId: string, storage?: PointerStorage): void {
  try { (storage ?? window.localStorage).setItem(financeWorkChatPointerKey(ownerScope, projectId), chatId); } catch { /* An unavailable UI preference never blocks native Work. */ }
}

const openingChats = new Map<string, Promise<Chat>>();
/** Strict-mode/remount callers share only an in-flight native creation, never a transcript. */
export function financeInitialWorkChat(ownerScope: string, projectId: string, bridge: NonNullable<ReturnType<typeof ipc>>): Promise<Chat> {
  const key = financeWorkChatPointerKey(ownerScope, projectId), pending = openingChats.get(key);
  if (pending) return pending;
  const opening = (async () => {
    const target = await bridge.tasks.createProject({ projectId });
    const chat = await bridge.chats.get(target.chatId);
    if (!chat || !financeProjectChats([chat], projectId).length) throw new Error("finance_work_chat_mismatch");
    // Preserve the host-created id even if its first viewer navigates away before the await returns.
    financeRememberWorkChat(ownerScope, projectId, chat.id);
    return chat;
  })();
  openingChats.set(key, opening);
  void opening.finally(() => { if (openingChats.get(key) === opening) openingChats.delete(key); }).catch(() => undefined);
  return opening;
}

/** A project/session selector around the unchanged Work harness, not a second conversation store. */
export function FinanceWorkChat({ ownerScope, provisionProject, listAnalysts, onStarter }: FinanceWorkChatProps) {
  const [project, setProject] = useState<FinanceWorkProject | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const epoch = useRef(0), owner = useRef(ownerScope), creatingRef = useRef(false), refreshSequence = useRef(0);
  const provision = useRef(provisionProject); provision.current = provisionProject;
  owner.current = ownerScope;
  // Language is shared with Work and the outer Finance surface.
  const { locale } = useT();
  const ko = locale === "ko";
  const language = useRef(ko), activeChat = useRef(activeChatId);
  language.current = ko; activeChat.current = activeChatId;
  const l = (k: string, e: string) => ko ? k : e;
  const menuExtensions = useMemo<readonly ComposerMenuExtension[]>(() => listAnalysts ? [{
    id: "finance-analyst", label: "Analyst", icon: <IconSparkles size={14} />, emptyLabel: ko ? "저장한 Analyst가 없습니다." : "No saved Analysts.",
    load: async () => (await listAnalysts()).items.map(item => ({ id: item.id, label: financeAnalystName(item, ko), description: financeAnalystDescription(item, ko), insert: financeAnalystMentionText(item) })),
  }] : [], [listAnalysts, ko]);

  useEffect(() => {
    const generation = ++epoch.current, capturedOwner = ownerScope; refreshSequence.current += 1;
    const current = () => epoch.current === generation && owner.current === capturedOwner;
    setProject(null); setChats([]); setActiveChatId(""); setLoading(true); setCreating(false); setError(""); creatingRef.current = false;
    void (async () => {
      const bridge = ipc();
      if (!capturedOwner || !bridge?.chats?.listByProject || !bridge.tasks?.createProject || !bridge.chats.get) throw new Error("finance_work_bridge_unavailable");
      const bound = await provision.current();
      if (!current()) return;
      if (bound.ownerScope !== capturedOwner || !bound.projectId) throw new Error("finance_work_owner_mismatch");
      const rows = financeProjectChats(await bridge.chats.listByProject(bound.projectId), bound.projectId);
      if (!current()) return;
      const preferred = financeReadWorkChatPointer(capturedOwner, bound.projectId, rows);
      let first = rows.find(chat => chat.id === preferred);
      if (!first) {
        let saved: string | null = null;
        try { saved = window.localStorage.getItem(financeWorkChatPointerKey(capturedOwner, bound.projectId)); } catch { /* Optional UI preference. */ }
        const remembered = saved ? await bridge.chats.get(saved) : null;
        if (!current()) return;
        if (remembered && financeProjectChats([remembered], bound.projectId).length) first = remembered;
      }
      first ??= rows[0];
      if (!first) {
        const created = await financeInitialWorkChat(capturedOwner, bound.projectId, bridge);
        if (!current()) return;
        first = created;
      }
      if (!rows.some(chat => chat.id === first!.id)) rows.push(first);
      financeRememberWorkChat(capturedOwner, bound.projectId, first.id);
      activeChat.current = first.id;
      setProject(bound); setChats(rows); setActiveChatId(first.id);
    })().catch(() => {
      if (current()) setError(language.current ? "Finance 대화를 열지 못했습니다. 계정과 Work 연결을 확인한 뒤 다시 시도하세요." : "Could not open Finance conversations. Check the account and Work connection, then retry.");
    }).finally(() => { if (current()) setLoading(false); });
    return () => { epoch.current += 1; refreshSequence.current += 1; };
  }, [ownerScope, attempt]);

  const newConversation = useCallback(async () => {
    if (!project || project.ownerScope !== owner.current || creatingRef.current) return;
    const generation = epoch.current, capturedOwner = project.ownerScope;
    const current = () => epoch.current === generation && owner.current === capturedOwner;
    const bridge = ipc();
    if (!bridge?.tasks?.createProject || !bridge.chats?.get || !bridge.chats.listByProject) {
      setError(ko ? "Work 연결이 없어 새 대화를 만들지 못했습니다. 현재 대화는 유지됩니다." : "Work is unavailable. A new conversation was not created; this conversation is unchanged."); return;
    }
    refreshSequence.current += 1;
    creatingRef.current = true; setCreating(true); setError("");
    try {
      const target = await bridge.tasks.createProject({ projectId: project.projectId });
      if (!current()) return;
      const created = await bridge.chats.get(target.chatId);
      if (!current()) return;
      if (!created || created.projectId !== project.projectId || created.kind !== "user" || created.archivedAt) throw new Error("finance_work_chat_mismatch");
      setChats(previous => financeProjectChats([created, ...previous.filter(chat => chat.id !== created.id)], project.projectId));
      financeRememberWorkChat(capturedOwner, project.projectId, created.id);
      activeChat.current = created.id; refreshSequence.current += 1;
      setActiveChatId(created.id);
    } catch {
      if (current()) setError(ko ? "새 대화를 만들지 못했습니다. 현재 대화는 유지됩니다." : "Could not create a conversation. This conversation is unchanged.");
    } finally {
      if (current()) { creatingRef.current = false; setCreating(false); }
    }
  }, [project, ko]);

  const refresh = useCallback(async () => {
    if (!project || project.ownerScope !== owner.current || creatingRef.current) return;
    const generation = epoch.current, capturedOwner = project.ownerScope, sequence = ++refreshSequence.current;
    const current = () => generation === epoch.current && owner.current === capturedOwner && sequence === refreshSequence.current;
    try {
      const bridge = ipc();
      if (!bridge?.chats?.listByProject) throw new Error("finance_work_bridge_unavailable");
      const rows = financeProjectChats(await bridge.chats.listByProject(project.projectId), project.projectId);
      if (!current()) return;
      const missing = activeChat.current;
      if (missing && !rows.some(chat => chat.id === missing)) {
        const active = await bridge.chats.get(missing);
        if (!current()) return;
        if (active && financeProjectChats([active], project.projectId).length) rows.push(active);
      }
      const selected = rows.some(chat => chat.id === activeChat.current) ? activeChat.current : rows[0]?.id ?? "";
      if (selected) financeRememberWorkChat(capturedOwner, project.projectId, selected);
      activeChat.current = selected;
      setChats(rows); setActiveChatId(selected); setError("");
    } catch {
      if (current()) setError(ko ? "대화 목록을 불러오지 못했습니다. 현재 대화는 유지됩니다." : "Could not load the conversation list. This conversation is unchanged.");
    }
  }, [project, ko]);

  useEffect(() => {
    if (!project || project.ownerScope !== ownerScope) return;
    const events = ipcEvents();
    if (!events?.onStoreChanged) return;
    const update = createTrailingDebounce({ waitMs: 100, maxWaitMs: 500, run: () => { void refresh(); } });
    const unsubscribe = events.onStoreChanged(change => {
      if (change.entity === "chat" || change.entity === "task" && (change.projectId === undefined || change.projectId === project.projectId)) update.call();
    });
    return () => { unsubscribe(); update.cancel(); refreshSequence.current += 1; };
  }, [project, ownerScope, refresh]);

  const validProject = project?.ownerScope === ownerScope;
  // The Work turn that ended on an empty credit balance carries the machine marker data-terminal-error="insufficient_credits". The newest turn's marker puts one plain sentence and its two actions above the conversation (the stylesheet shows the same sentence in place of the Work failure rows).
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [creditsOut, setCreditsOut] = useState(false);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) { setCreditsOut(false); return; }
    let frame = 0;
    const read = () => {
      frame = 0;
      // Walk back over the newest turn's assistant parts (the Work failure rows, then the host's own closing text); the owner's message ends the turn.
      const anchors = Array.from(surface.querySelectorAll(".agentlas-chat-message-anchor"));
      let out = false;
      for (let index = anchors.length - 1; index >= 0; index -= 1) {
        const anchor = anchors[index];
        if (!anchor.querySelector(".agentlas-chat-answer")) break;
        if (anchor.querySelector('[data-terminal-error="insufficient_credits"]')) { out = true; break; }
      }
      setCreditsOut(out);
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(read); });
    observer.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-terminal-error"] });
    read();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [validProject, activeChatId, loading]);
  const chooseAnotherModel = () => surfaceRef.current?.querySelector<HTMLElement>("[data-one-composer-trigger=model]")?.click();
  const selectConversation = (chatId: string) => {
    if (!project || project.ownerScope !== owner.current || !chats.some(chat => chat.id === chatId)) return;
    refreshSequence.current += 1; financeRememberWorkChat(project.ownerScope, project.projectId, chatId); activeChat.current = chatId; setActiveChatId(chatId);
  };
  return <section className={styles.root} data-credits-out={creditsOut ? "true" : undefined} aria-label={l("Finance 대화", "Finance conversations")}>
    <header className={styles.toolbar}>
      <label className={styles.selector}><span className={styles.srOnly}>{l("대화 선택", "Choose conversation")}</span><select value={validProject ? activeChatId : ""} disabled={loading || creating || !validProject || !chats.length} onChange={event => selectConversation(event.target.value)}>
        {!chats.length && <option value="">{l("대화", "Conversation")}</option>}
        {validProject && chats.map(chat => <option key={chat.id} value={chat.id}>{taskTitleForDisplay(chat.title, ko)}</option>)}
      </select></label>
      <button type="button" className={styles.icon} onClick={() => void refresh()} disabled={loading || creating || !validProject} aria-label={l("대화 목록 새로고침", "Refresh conversations")} title={l("대화 목록 새로고침", "Refresh conversations")}><IconRefresh size={17}/></button>
      <button type="button" className={styles.newChat} onClick={() => void newConversation()} disabled={loading || creating || !validProject}><IconPlus size={17}/><span>{creating ? l("만드는 중…", "Creating…") : l("새 대화", "New conversation")}</span></button>
    </header>
    {error && <div className={styles.error} role="alert"><span>{error}</span>{!validProject && <button type="button" onClick={() => setAttempt(value => value + 1)}>{l("다시 시도", "Retry")}</button>}</div>}
    {creditsOut && <div className={styles.credits} role="status"><span>{creditsOutSentence(ko)}</span><button type="button" className={styles.creditsPrimary} onClick={() => openPricing("ai-credits")}>{l("크레딧 충전", "Top up credits")}</button><button type="button" onClick={chooseAnotherModel}>{l("다른 모델 선택", "Choose another model")}</button></div>}
    {loading ? <p className={styles.status} role="status">{l("Finance 대화를 여는 중…", "Opening Finance conversations…")}</p> : validProject && activeChatId ? <div ref={surfaceRef} className={styles.surface} style={{ "--finance-empty-title": JSON.stringify(l("시장, 자산, 보유 종목에 대해 물어보세요", "Ask about markets, assets or your holdings")), "--finance-credits-out": JSON.stringify(creditsOutSentence(ko)) } as CSSProperties}><ComposerMenuExtensions.Provider value={menuExtensions}><WorkChatSurface key={`${ownerScope}:${activeChatId}`} chatId={activeChatId} embedded onNewSession={newConversation}/></ComposerMenuExtensions.Provider>{onStarter && <div className={styles.starters} role="group" aria-label={l("시작 질문", "Starter questions")}>{financeStarterPrompts(ko).map(text => <button key={text} type="button" onClick={() => onStarter(text)}>{text}</button>)}</div>}</div> : !error && <p className={styles.status}>{l("새 대화로 시작하세요.", "Start a new conversation.")}</p>}
  </section>;
}
