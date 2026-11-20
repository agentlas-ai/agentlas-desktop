// Dashboard "Work in progress" (F-D2): the most recent group chats, Work sessions and one-to-one agent chats as cards, newest on the left.
// A chat that waits for the owner carries a red dot and the kind in words; pressing the card opens THAT chat (the old blue dot on the
// product switcher did "go to the first waiting chat"; this is its replacement, one card per chat).
// What is read, when (rule: a signal, not a timer on unchanged state):
//   home.tree()      at open, on a chat / task / project change (one read per 400 ms burst), and a 60 s net while the window is visible
//   home.lines(ids)  with each tree read, for the (at most four) cards on screen only
//   projects.list()  with each tree read, through the shared view cache (names only; a failed read leaves the names out)
//   active chats     pushed whole by Main (onActiveChats) + one read at open
//   waiting / done   from lib/attention.ts (it already holds them; no read here)
"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { openAttentionEntry, useWaitingByChat, type ChatWaiting } from "@/lib/attention";
import { openPendingConfirmation, pendingConfirmationHref } from "@/lib/open-pending-confirmation";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import { AgentAvatar } from "@/components/AgentAvatar";
import { IconCheck, IconShield } from "@/components/Icon";
import type { HomeLine, HomeTreeRow, HomeTreeSnapshot } from "@shared/home-tree";
import type { Project } from "@/lib/types";
import { COPY, pick } from "./dashboard-copy";
import s from "./Dashboard.module.css";

const SAFETY_READ_MS = 60_000;
const SLOTS = 4;
const FIRST_READ_LIMIT_MS = 10_000;

/** `home` is a renderer-only namespace of this build's preload (shared/home-tree.ts); it is not part of the typed bridge object. */
interface HomeApi { tree: () => Promise<HomeTreeSnapshot>; lines: (ids: string[]) => Promise<HomeLine[]> }
const homeApi = (): HomeApi | null => (ipc() as unknown as { home?: HomeApi } | null)?.home ?? null;

function relTime(iso: string, ko: boolean): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return pick(ko, COPY.now);
  if (m < 60) return `${m}${ko ? "분" : "m"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${ko ? "시간" : "h"}`;
  return `${Math.round(h / 24)}${ko ? "일" : "d"}`;
}

/** The cards to draw: the newest four, but a chat that waits for the owner is never pushed out by newer quiet ones. */
export function pickCards(rows: readonly HomeTreeRow[], waiting: ReadonlyMap<string, ChatWaiting>, slots = SLOTS): HomeTreeRow[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const chosen = new Set<string>();
  for (const row of sorted) if (waiting.has(row.id) && chosen.size < slots) chosen.add(row.id);
  for (const row of sorted) if (chosen.size < slots) chosen.add(row.id);
  return sorted.filter((row) => chosen.has(row.id));
}

const DEFAULT_TITLES = new Set(["", "new chat", "새 대화", "새 채팅"]);
function cardTitle(row: HomeTreeRow, line: HomeLine | undefined, ko: boolean): string {
  if (row.kind === "solo") return row.agentNames[0] || row.title || pick(ko, COPY.agentChat);
  if (row.kind === "group") {
    const title = row.title.trim();
    return DEFAULT_TITLES.has(title.toLowerCase()) ? row.agentNames.join(", ") || pick(ko, COPY.groupChat) : title;
  }
  const base = row.title.trim() || pick(ko, COPY.newChat);
  return line?.runnerLabel ? `${line.runnerLabel} · ${base}` : base;
}

function TerminalGlyph() {
  return <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2.2" stroke="currentColor" strokeWidth="1.3" /><path d="M4.6 6.2l2.2 1.8-2.2 1.8M8.6 10h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function QuestionGlyph() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" /><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="11.3" r=".8" fill="currentColor" /></svg>;
}

function Card({ row, line, waiting, working, project, ko }: { row: HomeTreeRow; line: HomeLine | undefined; waiting: ChatWaiting | undefined; working: boolean; project: string; ko: boolean }) {
  const needs = Boolean(waiting && (waiting.approvals > 0 || waiting.questions > 0));
  const finished = Boolean(waiting && waiting.done > 0 && !needs);
  const title = cardTitle(row, line, ko);
  const kindLabel = row.kind === "group" ? pick(ko, COPY.groupChat) : row.kind === "solo" ? pick(ko, COPY.agentChat) : pick(ko, COPY.session);
  const joined = (head: string) => (project ? `${head} · ${project}` : head);
  let sub: ReactNode;
  if (waiting && waiting.approvals > 0) sub = <><IconShield size={13} /><span>{pick(ko, COPY.approvalNeeded)}</span></>;
  else if (waiting && waiting.questions > 0) sub = <><QuestionGlyph /><span>{pick(ko, COPY.question)}</span></>;
  else if (working) sub = <><i className={s.statusDot} data-tone="ok" /><span>{joined(pick(ko, COPY.working))}</span></>;
  else if (finished) sub = <><IconCheck size={13} /><span>{joined(pick(ko, COPY.done))}</span></>;
  // A quiet recent chat (nothing running, nothing waiting for the owner, no unseen result - e.g. a paused goal) says so: under "Work in progress" a bare kind label read as running.
  else sub = <span>{`${pick(ko, COPY.idle)} · ${project || kindLabel}`}</span>;
  const faces = line?.faces ?? [];
  const visual = row.kind === "work"
    ? <span className={s.tile}><TerminalGlyph /></span>
    : row.kind === "group"
      ? <span className={s.faces}>{(faces.length > 0 ? faces.map((f) => ({ id: f.agentId, name: f.name })) : row.agentNames.length > 0 ? row.agentNames.slice(0, 3).map((name) => ({ id: undefined, name })) : [{ id: undefined, name: title }]).slice(0, 3)
        .map((f, index) => <AgentAvatar key={`${f.id ?? f.name}:${index}`} name={f.name} agentId={f.id} size={28} />)}</span>
      : <AgentAvatar name={row.agentNames[0] || title} agentId={faces[0]?.agentId} size={32} />;
  const open = useCallback(async () => {
    if (waiting && waiting.questions > 0 && !waiting.personalAgentHref) { await openPendingConfirmation({ chatId: row.id }); return; }
    if (waiting && (needs || finished) && waiting.personalAgentHref) { await openAttentionEntry({ chatId: row.id, href: waiting.personalAgentHref, orphan: false, personalAgent: true }); return; }
    navigate(await pendingConfirmationHref({ chatId: row.id }));
  }, [finished, needs, row.id, waiting]);
  return (
    <button type="button" className={`${s.card} ${s.wip}`} data-wip-chat-id={row.id} data-waiting={needs ? "true" : "false"} onClick={() => void open()}
      aria-label={`${title}. ${needs ? (waiting && waiting.approvals > 0 ? pick(ko, COPY.approvalNeeded) : pick(ko, COPY.question)) : working ? pick(ko, COPY.working) : finished ? pick(ko, COPY.done) : `${pick(ko, COPY.idle)}, ${kindLabel}`}`}>
      {needs && <i className={s.alertDot} data-testid="wip-alert-dot" aria-hidden="true" />}
      {visual}
      {/* A card is not a label button: its text block is a block box, like the other card-shaped buttons of the app. */}
      <div className={s.wipText}>
        <b className={s.wipTitle}>{title}</b>
        <span className={s.wipSub} data-need={needs ? "true" : "false"}>{sub}</span>
      </div>
      <time className={s.wipTime} dateTime={row.updatedAt}>{relTime(row.updatedAt, ko)}</time>
    </button>
  );
}

export function WorkInProgress() {
  const { locale } = useT();
  const ko = locale === "ko";
  const waitingByChat = useWaitingByChat();
  const [rows, setRows] = useState<HomeTreeRow[] | null>(() => readViewData<HomeTreeRow[]>("dashboard.wip.rows")?.value ?? null);
  const [lines, setLines] = useState<Map<string, HomeLine>>(new Map());
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [active, setActive] = useState<Set<string>>(() => new Set(readViewData<string[]>("dashboard.active-chats")?.value ?? []));
  const [failed, setFailed] = useState(false);
  const readSeq = useRef(0);
  const waitingRef = useRef(waitingByChat);
  waitingRef.current = waitingByChat;

  const read = useCallback(async () => {
    const api = ipc();
    const home = homeApi();
    if (!api || !home) { setFailed(true); setRows((current) => current ?? []); return; }
    const seq = ++readSeq.current;
    try {
      const [tree, projectList] = await Promise.all([
        home.tree(),
        loadViewData<Project[]>("dashboard.projects", () => api.projects.list(), { maxAgeMs: 15_000 }).catch(() => [] as Project[]),
      ]);
      if (seq !== readSeq.current) return;
      writeViewData("dashboard.wip.rows", tree.rows.slice(0, 50));
      setRows(tree.rows);
      setProjects(new Map(projectList.map((project) => [project.id, project.name])));
      setFailed(false);
      const shown = pickCards(tree.rows, waitingRef.current).map((row) => row.id);
      if (shown.length > 0) {
        try {
          const got = await home.lines(shown);
          if (seq === readSeq.current) setLines(new Map(got.map((line) => [line.id, line])));
        } catch { /* the cards still draw from the tree row; a face or runner name is not worth a failure line */ }
      }
    } catch {
      // A failed read keeps the cards it has and says so; it never turns into "nothing is running".
      if (seq === readSeq.current) { setFailed(true); setRows((current) => current ?? []); }
    }
  }, []);
  useVisibleInterval(() => read(), SAFETY_READ_MS, { initial: read });
  useEffect(() => {
    const api = ipc();
    void api?.invoke.activeChats().then((ids) => { writeViewData("dashboard.active-chats", ids); setActive(new Set(ids)); }).catch(() => undefined);
    // The running set arrives whole with every change; no read is needed for it.
    const offActive = ipcEvents()?.onActiveChats?.((chatIds) => { writeViewData("dashboard.active-chats", chatIds); setActive(new Set(chatIds)); });
    // New chat, rename, finished, project change: one tree read per burst.
    let burst: ReturnType<typeof setTimeout> | null = null;
    const offStore = subscribeStoreChanges((change) => {
      if ((change.entity !== "chat" && change.entity !== "task" && change.entity !== "project") || burst || document.visibilityState === "hidden") return;
      burst = setTimeout(() => { burst = null; void read(); }, 400);
    });
    return () => { offActive?.(); offStore(); if (burst) clearTimeout(burst); };
  }, [read]);

  // The first read has an end: a bridge that never answers becomes the failure line with its retry, not an empty row for ever.
  useEffect(() => {
    if (rows !== null) return undefined;
    const timer = window.setTimeout(() => { setFailed(true); setRows((current) => current ?? []); }, FIRST_READ_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [rows]);

  const cards = useMemo(() => pickCards(rows ?? [], waitingByChat), [rows, waitingByChat]);
  const signature = cards.map((row) => row.id).join("|");
  const overflow = useMemo(() => {
    const shown = new Set(cards.map((row) => row.id));
    return (rows ?? []).filter((row) => waitingByChat.has(row.id) && !shown.has(row.id)).length;
  }, [cards, rows, waitingByChat]);

  return (
    <section data-tour-id="dashboard.activity" aria-labelledby="dashboard-wip-title">
      {/* Empty: no [View all] (there is nothing to view). Could not read: it stays, the cards are not what failed. */}
      {(() => {
        const empty = rows !== null && rows.length === 0 && !failed;
        const unread = failed && cards.length === 0;
        return (
          <>
            <div className={s.wipHead}>
              <h2 className={s.h} id="dashboard-wip-title">{pick(ko, COPY.workInProgress)}</h2>
              {!empty && <button type="button" className={s.quiet} onClick={() => navigate("/workspace")}>{pick(ko, COPY.viewAll)}</button>}
            </div>
            {unread && (
              <div className={s.band} role="alert" data-testid="wip-failed">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" /><path d="M8 4.8v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="8" cy="11" r=".85" fill="currentColor" /></svg>
                <span className={s.bandText}>{pick(ko, COPY.wipFailed)}</span>
                <button type="button" className={s.bandBtn} onClick={() => void read()}>{pick(ko, COPY.retry)}</button>
              </div>
            )}
            {failed && cards.length > 0 && (
              <p className={s.softLine} role="alert" data-testid="wip-failed">
                {pick(ko, COPY.wipFailed)}
                <button type="button" className={`${s.btn} ${s.inlineBtn}`} onClick={() => void read()}>{pick(ko, COPY.retry)}</button>
              </p>
            )}
            {empty ? (
              <div className={s.band} data-empty="true" data-testid="wip-empty">
                <IconCheck size={18} />
                <span className={s.bandText}>{pick(ko, COPY.wipEmpty)}</span>
                <button type="button" className={s.bandBtn} onClick={() => navigate("/workspace")}>{pick(ko, COPY.wipOpenWorkspace)}</button>
              </div>
            ) : rows !== null && cards.length > 0 ? (
              <div className={`${s.wipGrid} ${s.wipFade}`} key={signature} data-testid="wip-grid">
                {cards.map((row) => (
                  <Card key={row.id} row={row} line={lines.get(row.id)} waiting={waitingByChat.get(row.id)} working={active.has(row.id)}
                    project={row.projectId ? projects.get(row.projectId) ?? "" : ""} ko={ko} />
                ))}
              </div>
            ) : null}
          </>
        );
      })()}
      {overflow > 0 && <p className={s.softLine} style={{ margin: "6px 0 0", padding: "0 2px" }}>+{overflow} {pick(ko, COPY.more)}</p>}
    </section>
  );
}
