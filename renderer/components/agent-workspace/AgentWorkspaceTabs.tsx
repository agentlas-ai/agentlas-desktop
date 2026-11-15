"use client";

// The tabs Agentlas 2.0 added to an agent's workspace: Memory (map + list + forget), Rooms, and the skill list.
// Each reads only while it is on screen — leaving the tab unmounts it, so a hidden tab costs nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconFileText, IconUsers } from "@/components/Icon";
import { DesktopMemoryInspector } from "@/components/one/OneMemorySheet";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import type { InstalledAgent } from "@shared/types";
import type { AgentWorkspaceFile } from "@shared/agent-workspace";
import styles from "./AgentWorkspace.module.css";

/** Newest 300 memories of this one agent: the map and the list share that one read; "forget" and "edit" use the existing inspector. */
const AGENT_MEMORY_FIRST_READ = 300;

export function AgentRecallTab({ agent, name, locale }: { agent: InstalledAgent; name: string; locale: string }) {
  const lang = locale === "ko" ? "ko" : "en";
  return <section className={styles.recall} aria-label={lang === "ko" ? "기억" : "Memory"} data-agent-recall>
    <DesktopMemoryInspector open active locale={lang} revisionHint={null} fixed={{ actorId: agent.id, name, limit: AGENT_MEMORY_FIRST_READ }} />
    <p className={styles.meta}>{lang === "ko" ? "기억은 이 데스크탑에만 남고, 승인한 스킬만 다른 데스크탑으로 전달돼요." : "These memories stay on this computer. Only skills you approve follow the agent to other computers."}</p>
  </section>;
}

type Room = Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["agents"]["rooms"]>>[number];

export function AgentRoomsTab({ agent, locale }: { agent: InstalledAgent; locale: string }) {
  const ko = locale === "ko";
  // Three read states that never mix: reading (rooms null, not failed), failed (rooms null, failed: nothing is said about the list) and read (a list, possibly really empty).
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const read = useCallback(() => {
    const current = ++generation.current;
    const api = ipc();
    if (!api?.agents.rooms) { setFailed(true); return; }
    setRooms(null); setFailed(false);
    void api.agents.rooms(agent.id).then((value) => { if (current === generation.current) setRooms(value); }).catch(() => { if (current === generation.current) setFailed(true); });
  }, [agent.id]);
  useEffect(() => {
    read();
    // Rooms come and go with chats; one re-read per store change that names a chat, no timer.
    const off = window.agentlasEvents?.onStoreChanged?.((change) => {
      if (change.entity !== "chat" && change.entity !== "seat") return;
      const current = generation.current;
      void ipc()?.agents.rooms?.(agent.id).then((value) => { if (current === generation.current) { setRooms(value); setFailed(false); } }).catch(() => undefined);
    });
    return () => { generation.current++; off?.(); };
  }, [agent.id, read]);
  const unread = failed && rooms === null;
  return <section className={styles.history} aria-label={ko ? "참여한 대화" : "Conversations"} data-agent-rooms>
    <div className={styles.paneHeader}><IconUsers size={14} /><strong>{ko ? "참여한 대화" : "Conversations"}</strong>{!unread && <span>{rooms?.length ?? "…"}</span>}</div>
    {unread ? <div className={styles.readFailed} role="alert"><IconAlertTriangle size={14} /><span>{ko ? "대화 목록을 불러오지 못했어요." : "Couldn't load conversations."}</span><button type="button" className={styles.button} onClick={read}>{ko ? "재시도" : "Retry"}</button></div>
      : rooms === null ? <div className={styles.empty}><span className={styles.loading} /></div>
      : rooms.length === 0 ? <div className={styles.empty}>{ko ? "참여한 대화 없음" : "No conversations yet."}</div>
      : <ul className={styles.roomList}>{rooms.map((room) => <li key={room.chatId}>
        <button type="button" className={styles.roomRow} onClick={() => navigate(`/workspace?open=${encodeURIComponent(room.chatId)}`)}>
          <strong>{room.title || (ko ? "제목 없는 대화" : "Untitled conversation")}</strong>
          <span className={styles.meta}>{room.projectName || (ko ? "프로젝트 없음" : "No project")} · {room.kind === "group" ? (ko ? "그룹 대화" : "Group chat") : (ko ? "1:1 대화" : "1:1 chat")}</span>
        </button></li>)}</ul>}
  </section>;
}

/** Skills the agent has on disk (skills/<name>/SKILL.md), shown at the top of the Skills tab; a click opens the file in Files. */
export function skillFiles(files: AgentWorkspaceFile[]): Array<{ name: string; path: string }> {
  return files.filter((file) => file.kind === "file" && /^skills\/[^/]+\/SKILL\.md$/i.test(file.path)).map((file) => ({ name: file.path.split("/")[1], path: file.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function AgentSkillList({ files, locale, onOpen }: { files: AgentWorkspaceFile[]; locale: string; onOpen: (path: string) => void }) {
  const ko = locale === "ko";
  const skills = skillFiles(files);
  return <section className={styles.skillList} aria-label={ko ? "이 에이전트의 스킬" : "This agent's skills"} data-agent-skills>
    <div className={styles.paneHeader}><IconFileText size={14} /><strong>{ko ? "스킬" : "Skills"}</strong><span>{skills.length}</span></div>
    {skills.length === 0 ? <p className={styles.meta}>{ko ? "승인한 스킬 없음" : "No approved skills yet. A fix confirmed several times shows up here as a candidate."}</p>
      : <ul className={styles.roomList}>{skills.map((skill) => <li key={skill.path}><button type="button" className={styles.roomRow} onClick={() => onOpen(skill.path)}><strong>{skill.name}</strong><span className={styles.meta}>{skill.path}</span></button></li>)}</ul>}
  </section>;
}
