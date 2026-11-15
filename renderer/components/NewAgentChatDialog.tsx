"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { listCopy, listFailureText } from "@/lib/workspace-list-copy";
import { openChatInSpace } from "@/lib/space-store";
import { isCallOnlyHubAgent } from "@shared/call-only-agent";
import { BUILTIN_ONE_AGENT_ID, BUILTIN_ORCHESTRATOR_AGENT_ID } from "@shared/builtin-agent-ids";
import type { InstalledAgent } from "@/lib/types";
import { IconCheck, IconSearch, IconUsers } from "./Icon";
import { OneAgentPortrait } from "./one/OneAgentPortrait";
import { OneBottomSheet } from "./one/OneBottomSheet";
import { PopupAction } from "./Popup";
import styles from "./NewAgentChatDialog.module.css";

/*
 * New Agent Chat (Agentlas 2.0 §2.3). Pick agents: one = a 1:1 room, two or more = a group room, inside the
 * project the "+" belongs to (or no project). Every Create makes a NEW room; picking an agent that is not on the org chart yet
 * seats it as part of Create (Main does it, idempotently). A call-only Hub agent can only be talked to one-to-one, and the row
 * says so in one line instead of failing later.
 *
 * F-D3: Cancel / close are always live (a create that never answers cannot lock the dialog; a late answer after Cancel opens nothing),
 * the lead is a drop-down (the first pick), the group name is its own field, a failed or empty agent list says what to do.
 */
export function pickableAgents(agents: readonly InstalledAgent[]): InstalledAgent[] {
  return agents.filter((agent) => agent.kind !== "team" && !agent.sourceMissingSince
    && agent.visibility !== "private" && agent.visibility !== "background"
    && agent.id !== BUILTIN_ONE_AGENT_ID && agent.id !== BUILTIN_ORCHESTRATOR_AGENT_ID && agent.slug !== "agentlas-one" && agent.slug !== "agentlas-orchestrator");
}

/** Next selection after a click. Call-only agents are 1:1 only: choosing one replaces the others, and choosing another agent drops it. */
export function toggleSelection(current: readonly string[], id: string, callOnly: ReadonlySet<string>): string[] {
  if (current.includes(id)) return current.filter((value) => value !== id);
  if (callOnly.has(id)) return [id];
  return [...current.filter((value) => !callOnly.has(value)), id];
}

export function NewAgentChatDialog({ open, projectId, projectName, locale, onClose }: {
  open: boolean; projectId: string | null; projectName: string | null; locale: "ko" | "en"; onClose: () => void;
}) {
  const ko = locale === "ko";
  const copy = listCopy(locale);
  const [agents, setAgents] = useState<InstalledAgent[] | "loading" | "failed">("loading");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the list is read again; `attempt` ends an answer that belongs to a closed dialog.
  const [reads, setReads] = useState(0);
  const attempt = useRef(0);

  useEffect(() => {
    if (!open) return;
    attempt.current += 1;
    setSelected([]); setQuery(""); setTitle(""); setError(null); setBusy(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setAgents("loading");
    let cancelled = false;
    const api = ipc();
    if (!api?.team?.list) { setAgents("failed"); return; }
    api.team.list().then((list) => { if (!cancelled) setAgents(pickableAgents(list)); }).catch(() => { if (!cancelled) setAgents("failed"); });
    return () => { cancelled = true; };
  }, [open, reads]);

  const list = Array.isArray(agents) ? agents : [];
  const callOnly = useMemo(() => new Set(list.filter((agent) => isCallOnlyHubAgent(agent)).map((agent) => agent.id)), [list]);
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? list.filter((agent) => `${agent.localDisplayName ?? ""} ${agent.name} ${agent.nameEn}`.toLocaleLowerCase().includes(needle)) : list;
  const nameOf = (agent: InstalledAgent) => agent.localDisplayName || (ko ? agent.name : agent.nameEn || agent.name);
  const nameById = (id: string) => { const agent = list.find((item) => item.id === id); return agent ? nameOf(agent) : id; };
  const close = () => { attempt.current += 1; onClose(); };
  const submit = async () => {
    const api = ipc();
    if (!api?.chats?.createAgentChat || selected.length === 0 || busy) return;
    const mine = ++attempt.current;
    setBusy(true); setError(null);
    try {
      const made = await api.chats.createAgentChat({ agentIds: selected, projectId, ...(title.trim() ? { title: title.trim() } : {}) });
      if (mine !== attempt.current) return; // Cancelled meanwhile: the room exists and shows in the list; nothing is opened behind the person's back.
      onClose();
      // The new room opens as a tab in Home's Space (it goes to Home first when this is another screen).
      openChatInSpace({ chatId: made.chat.id, kind: "room" }, "replace-pane");
    } catch (cause) {
      if (mine !== attempt.current) return;
      setBusy(false);
      setError(listFailureText(cause, locale));
    }
  };
  const emptyList = agents !== "loading" && agents !== "failed" && list.length === 0;
  return (
    <OneBottomSheet open={open} onClose={close} closeLabel={copy.close} size="wide"
      icon={<IconUsers size={20} />} title={copy.dialogTitle(projectName)} titleId="new-agent-chat-title" ariaLabelledBy="new-agent-chat-title"
      description={copy.dialogDesc}
      dataAttributes={{ "data-new-agent-chat": "true" }}
      footer={<>
        <PopupAction onClick={close}>{copy.cancel}</PopupAction>
        <PopupAction primary data-create="true" onClick={() => void submit()} disabled={busy || selected.length === 0}>
          {busy ? copy.creating : selected.length >= 2 ? copy.createN(selected.length) : copy.create}
        </PopupAction>
      </>}>
      <div className={styles.body} aria-busy={busy ? "true" : "false"}>
        <label className={styles.search}><IconSearch size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.find} aria-label={copy.find} autoFocus />
        </label>
        <div className={styles.list} role="listbox" aria-multiselectable="true" aria-label={copy.agentsLabel}>
          {agents === "loading" ? <p className={styles.note}>{copy.agentsLoading}</p>
            : agents === "failed" ? <><p className={styles.note} role="alert">{copy.agentsFailed}</p><div className={styles.retryRow}><PopupAction data-retry="true" onClick={() => setReads((count) => count + 1)}>{copy.retry}</PopupAction></div></>
            : emptyList ? <p className={styles.note} data-empty="true">{copy.agentsNone}</p>
            : shown.length === 0 ? <p className={styles.note}>{copy.agentsNoMatch}</p>
            : shown.map((agent) => {
              const checked = selected.includes(agent.id), only1to1 = callOnly.has(agent.id);
              const multi = selected.length > 0 && !checked;
              const blocked = only1to1 && multi;
              return (
                <button key={agent.id} type="button" role="option" aria-selected={checked} className={styles.row} data-checked={checked ? "true" : undefined}
                  data-agent-id={agent.id} data-call-only={only1to1 ? "true" : undefined} disabled={blocked || busy}
                  onClick={() => setSelected((current) => toggleSelection(current, agent.id, callOnly))}>
                  <OneAgentPortrait status="quiet" label={nameOf(agent)} tone={agent.tone} size="small" />
                  <span className={styles.copy}>
                    <strong>{nameOf(agent)}</strong>
                    {only1to1 ? <small data-call-only-reason="true">{copy.callOnly}</small> : null}
                  </span>
                  <span className={styles.check} aria-hidden="true">{checked ? <IconCheck size={13} /> : null}</span>
                </button>
              );
            })}
        </div>
        {selected.length >= 2 ? (
          <>
            <label className={styles.title}>{copy.lead}
              <select data-lead-select="true" value={selected[0]} disabled={busy}
                onChange={(event) => { const id = event.target.value; setSelected((current) => [id, ...current.filter((value) => value !== id)]); }}>
                {selected.map((id) => <option key={id} value={id}>{nameById(id)}</option>)}
              </select>
              <small>{copy.leadHelp}</small>
            </label>
            <label className={styles.title}>{copy.groupName}
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} disabled={busy}
                placeholder={selected.map(nameById).slice(0, 3).join(", ")} />
              <small>{copy.groupNameHint}</small>
            </label>
          </>
        ) : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </OneBottomSheet>
  );
}
