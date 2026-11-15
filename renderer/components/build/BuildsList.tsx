"use client";

/*
 * Build home › "Builds" tab (Agentlas 2.0 F-D10, picture build-v5-home): the saved builds as quiet rows —
 * face, title and last line, state, date. Everything comes from `buildWorkbench.list` (shared/build-workbench.ts);
 * the screen adds no value of its own: no folder path (a new build's temporary folder name is never shown),
 * no count it was not given, no state it was not told. Read once when the screen opens and after the person's own
 * command (delete); never on a timer.
 */
import { useCallback, useEffect, useState } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ipc } from "@/lib/ipc";
import type { BuildListItem } from "@shared/build-workbench";
import styles from "./BuildWorkbench.module.css";

export type BuildListStatus = "loading" | "ready" | "failed" | "unavailable";

/** The saved builds. `unavailable` = this desktop has no Build backend (the tab is then not offered). */
export function useBuildList(): { items: BuildListItem[]; status: BuildListStatus; reload: () => void } {
  const [items, setItems] = useState<BuildListItem[]>([]);
  const [status, setStatus] = useState<BuildListStatus>("loading");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const api = ipc()?.buildWorkbench;
    if (!api?.list) { setStatus("unavailable"); return; }
    void Promise.resolve().then(() => api.list()).then((answer) => {
      if (!alive) return;
      if (answer && answer.ok) { setItems(answer.items); setStatus("ready"); } else { setItems([]); setStatus("failed"); }
    }).catch(() => { if (alive) { setItems([]); setStatus("failed"); } });
    return () => { alive = false; };
  }, [nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { items, status, reload };
}

export function buildStateText(item: BuildListItem, ko: boolean): { text: string; dot: "blue" | "amber" | null } {
  switch (item.state) {
    case "building":
      return { text: `${ko ? "만드는 중" : "Building"}${item.progress ? ` ${item.progress.reached} / ${item.progress.total}` : ""}`, dot: "blue" };
    case "question":
      return { text: item.questionCount > 0 ? (ko ? `질문 ${item.questionCount}개` : `${item.questionCount} question${item.questionCount === 1 ? "" : "s"}`) : (ko ? "질문" : "Question"), dot: "amber" };
    case "created": return { text: ko ? "생성됨" : "Created", dot: null };
    case "stopped": return { text: ko ? "중지됨" : "Stopped", dot: null };
    case "unfinished": return { text: ko ? "끝내지 못함" : "Unfinished", dot: null };
  }
}

/** Same day -> the time, within a minute -> "now", otherwise month/day. */
export function buildWhenText(iso: string, ko: boolean, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  if (now - at < 60_000 && now >= at) return ko ? "방금" : "now";
  const date = new Date(at), today = new Date(now);
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(ko ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function BuildsList({ ko, items, status, onOpen }: { ko: boolean; items: BuildListItem[]; status: BuildListStatus; onOpen: (item: BuildListItem) => void }) {
  if (status === "loading") return <p role="status">{ko ? "빌드를 불러오는 중…" : "Loading builds…"}</p>;
  if (status === "failed") return <p role="status" className={styles.empty}>{ko ? "빌드 목록을 불러오지 못했어요." : "Could not read your builds. Open this screen again to retry."}</p>;
  if (items.length === 0) return <div className={styles.empty}><strong>{ko ? "저장된 빌드가 없어요" : "No builds yet"}</strong><p>{ko ? "만든 에이전트 없음" : "Agents you build appear here."}</p></div>;
  return (
    <ul className={styles.buildRows} aria-label={ko ? "빌드" : "Builds"}>
      {items.map((item) => {
        const title = (item.name ?? "").trim() || item.title;
        const state = buildStateText(item, ko);
        return (
          <li key={item.id}>
            <button type="button" className={styles.buildRow} onClick={() => onOpen(item)} data-build-state={item.state}>
              <AgentAvatar name={title} agentId={item.agentId ?? undefined} size={30} />
              <span className={styles.buildRowText}><strong>{title}</strong><span>{item.folderAvailable ? item.lastLine : (ko ? "폴더를 찾을 수 없어요" : "Folder not found")}</span></span>
              <span className={styles.buildRowState}>{state.dot && <i data-dot={state.dot} aria-hidden="true" />}{state.text}</span>
              <span className={styles.buildRowWhen}>{buildWhenText(item.updatedAt, ko)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
