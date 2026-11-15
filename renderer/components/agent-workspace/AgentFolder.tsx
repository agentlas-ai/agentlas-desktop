"use client";

// The agent's folder on Manage agents (Agentlas 2.0 F-D9, picture desktop-states-pieces 3): the four folder states (ok / root-unavailable / folder-missing /
// no-folder) and the refusal lines of a move. Reads when an agent is opened and after the owner's own command, never on a timer; the words are made here
// from the host's machine codes. The agents-root move is the host's (agentRoot.preview / move) and always ends in one of its answers.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconFolder } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { josaIga } from "@/lib/one-home-copy";
import { homeRelative } from "./AgentSyncTab";
import { IconDisk, IconFolderOff, IconPause, IconCloudOff } from "./agent-manage-icons";
import type { AgentFolderStatusView } from "@shared/agent-root";
import styles from "./AgentManage.module.css";

type RootBridge = {
  folderStatus?: (agentId: string) => Promise<AgentFolderStatusView>;
  setLocation?: (input: { agentId: string; folder: string }) => Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
  preview?: (target: string) => Promise<{ ok: true; folders: number; bytes: number; freeBytes: number | null; mode: string } | { ok: false; code: string; detail?: string }>;
  move?: (target: string) => Promise<{ ok: true } | { ok: false; code: string; detail?: string }>;
  reconnect?: (target: string) => Promise<{ ok: boolean; code?: string }>;
  status?: () => Promise<{ root: { path: string | null; available: boolean } }>;
};
const bridge = (): RootBridge | undefined => (ipc() as unknown as { agentRoot?: RootBridge } | null)?.agentRoot;

export function useFolderStatus(agentId: string) {
  const [status, setStatus] = useState<AgentFolderStatusView | null>(null);
  const generation = useRef(0);
  const read = useCallback(async () => {
    const current = ++generation.current;
    try { const value = await bridge()?.folderStatus?.(agentId); if (current === generation.current && value?.agentId === agentId) setStatus(value); }
    catch { if (current === generation.current) setStatus(null); }
  }, [agentId]);
  useEffect(() => { setStatus(null); void read(); return () => { generation.current++; }; }, [agentId, read]);
  return { status, reload: read };
}

/** Why a move or a new folder did not happen: a title and one line. */
export function moveRefusalText(code: string, detail: string | undefined, agentName: string, ko: boolean): { title: string; sub: string; icon: "pause" | "disk" | "folder" } {
  const t = (k: string, e: string) => (ko ? k : e);
  switch (code) {
    case "agent_running": case "agent_busy": return { icon: "pause", title: t("지금은 이동할 수 없어요", "Can't move now"), sub: t(`${agentName}${josaIga(agentName)} 작업 중이에요`, `${agentName} is working`) };
    case "disk_low": return { icon: "disk", title: t("저장 공간이 부족해요", "Not enough disk space"), sub: detail ? t(`${detail} 필요해요`, `Needs ${detail}`) : t("공간을 확보한 뒤 다시 시도해 주세요", "Free some space and try again") };
    case "target_not_empty": return { icon: "folder", title: t("그 폴더는 비어 있지 않아요", "That folder is not empty"), sub: t("빈 폴더를 선택해 주세요", "Choose an empty folder") };
    case "target_not_writable": return { icon: "folder", title: t("그 폴더에 쓸 수 없어요", "Can't write to that folder"), sub: t("쓰기 가능한 폴더를 선택해 주세요", "Choose a folder you can write to") };
    case "same_root": return { icon: "folder", title: t("현재 사용 중인 폴더예요", "That's the folder in use"), sub: t("다른 폴더를 선택해 주세요", "Choose a different folder") };
    case "move_in_progress": case "install_in_progress": case "memory_move_active": case "home_move_active": return { icon: "pause", title: t("다른 작업이 끝나기를 기다리는 중이에요", "Waiting for something else to finish"), sub: t("작업이 끝난 뒤 다시 시도해 주세요", "Try again when it's done") };
    case "root_unavailable": return { icon: "folder", title: t("에이전트 폴더가 연결돼 있지 않아요", "The agents folder is not connected"), sub: t("연결한 뒤 다시 시도해 주세요", "Connect it and try again") };
    case "folder_used_by_other_agent": return { icon: "folder", title: t("다른 에이전트가 사용 중인 폴더예요", "Another agent uses that folder"), sub: t("다른 폴더를 선택해 주세요", "Choose a different folder") };
    case "not_an_agent_folder": return { icon: "folder", title: t("에이전트 폴더가 아니에요", "That isn't an agent folder"), sub: t("에이전트가 들어 있는 폴더를 선택해 주세요", "Choose the folder that holds the agent") };
    default: return { icon: "folder", title: t("이동하지 못했어요", "Couldn't do that"), sub: t("폴더를 확인한 뒤 다시 시도해 주세요", "Check the folder and try again") };
  }
}
const refusalIcon = (kind: "pause" | "disk" | "folder") => kind === "pause" ? <IconPause /> : kind === "disk" ? <IconDisk /> : <IconFolderOff />;

export function AgentFolderNotes({ agentId, agentName, ko, status, reload, working }: { agentId: string; agentName: string; ko: boolean; status: AgentFolderStatusView | null; reload: () => Promise<void>; working: boolean }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; detail?: string } | null>(null);
  const choose = async () => {
    const selection = await ipc()?.fs.pickDirectory().catch(() => null);
    if (!selection) return;
    setBusy(true); setRefusal(null);
    try { const answer = await bridge()?.setLocation?.({ agentId, folder: selection.path }); if (answer && !answer.ok) setRefusal({ code: answer.code, detail: answer.detail }); await reload(); }
    catch { setRefusal({ code: "unknown" }); } finally { setBusy(false); }
  };
  const tryAgain = async () => { setBusy(true); setRefusal(null); try { await reload(); } finally { setBusy(false); } };
  if (!status || status.state === "ok") return null;
  return <div className={styles.notes} role="status" data-agent-folder-state={status.state}>
    {status.state === "folder-missing" && <div className={`${styles.note} ${styles.noteWarn}`}><IconFolderOff size={20} /><div><b>{ko ? "폴더를 찾을 수 없어요" : "Folder not found"}</b><small title={status.path ?? ""}>{homeRelative(status.path)}</small></div>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || working} onClick={() => void choose()}>{ko ? "찾아보기…" : "Locate…"}</button></div>}
    {status.state === "root-unavailable" && <div className={`${styles.note} ${styles.noteWarn}`}><IconCloudOff size={20} /><div><b>{ko ? "에이전트 폴더가 연결돼 있지 않아요" : "The agents folder is not connected"}</b><small title={status.path ?? ""}>{status.path ?? ""}</small></div>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void tryAgain()}>{ko ? "재시도" : "Try again"}</button></div>}
    {status.state === "no-folder" && <div className={styles.note}><IconFolder size={20} /><div><b>{ko ? "아직 폴더가 없어요" : "No folder yet"}</b><small>{ko ? "이 에이전트의 파일을 둘 폴더를 선택해 주세요" : "Choose a folder to keep this agent's files in"}</small></div>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy || working} onClick={() => void choose()}>{ko ? "폴더 고르기…" : "Choose folder…"}</button></div>}
    {refusal && (() => { const text = moveRefusalText(refusal.code, refusal.detail, agentName, ko); return <div className={styles.rowsCard}><div>{refusalIcon(text.icon)}<span><b>{text.title}</b><small>{text.sub}</small></span></div></div>; })()}
  </div>;
}

/** The folder button's popover: where the agent's folder is, show it, and move the agents folder (the host checks and refuses with a code). */
export function AgentFolderPopover({ agentName, ko, status, working, onClose, onReveal, onChanged }: { agentName: string; ko: boolean; status: AgentFolderStatusView | null; working: boolean; onClose: () => void; onReveal: (path: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; detail?: string } | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  const move = async () => {
    const api = bridge();
    const selection = await ipc()?.fs.pickDirectory().catch(() => null);
    if (!selection || !api?.preview || !api.move) return;
    setBusy(true); setRefusal(null); setDone(false);
    try {
      const preview = await api.preview(selection.path);
      if (!preview.ok) { setRefusal({ code: preview.code, detail: preview.detail }); return; }
      const size = preview.bytes >= 1e9 ? `${(preview.bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(preview.bytes / 1e6))} MB`;
      if (preview.freeBytes !== null && preview.freeBytes < preview.bytes) { setRefusal({ code: "disk_low", detail: size }); return; }
      const answer = await api.move(selection.path);
      if (!answer.ok) { setRefusal({ code: answer.code, detail: answer.detail }); return; }
      setDone(true); onChanged();
    } catch { setRefusal({ code: "unknown" }); } finally { setBusy(false); }
  };
  return <div className={styles.folderPop} role="dialog" aria-label={ko ? "폴더" : "Folder"}>
    <b style={{ fontSize: 15 }}>{ko ? "에이전트 폴더" : "Agent folder"}</b>
    <div className={styles.folderPath}>{status?.path ?? (ko ? "아직 폴더가 없어요" : "No folder yet")}</div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className={styles.btn} disabled={!status?.path || status.state !== "ok"} onClick={() => status?.path && onReveal(status.path)}>{ko ? "폴더 열기" : "Show in folder"}</button>
      <button type="button" className={styles.btn} disabled={busy || working} onClick={() => void move()}>{ko ? "에이전트 폴더 이동…" : "Move agents folder…"}</button>
    </div>
    {working && <small style={{ color: "var(--muted-deep)" }}>{ko ? `${agentName}${josaIga(agentName)} 작업 중일 때는 이동할 수 없어요` : `Can't move while ${agentName} is working`}</small>}
    {done && <small style={{ color: "var(--ok)" }}>{ko ? "이동했어요" : "Moved"}</small>}
    {refusal && (() => { const text = moveRefusalText(refusal.code, refusal.detail, agentName, ko); return <div className={styles.rowsCard}><div>{refusalIcon(text.icon)}<span><b>{text.title}</b><small>{text.sub}</small></span></div></div>; })()}
    {busy && <small style={{ color: "var(--muted-deep)" }}><IconAlertTriangle size={0} />{ko ? "이동 중…" : "Moving…"}</small>}
  </div>;
}
