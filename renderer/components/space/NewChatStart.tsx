"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, grantForDroppedFile } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { listFailureText } from "@/lib/workspace-list-copy";
import { readViewData, writeViewData } from "@/lib/view-data-cache";
import { chipRuntimeFor } from "@/lib/one-runtime-chip";
import { holdFirstMessage } from "@/lib/new-chat-start";
import { openProjectSettings } from "@/lib/project-settings";
import { isCallOnlyHubAgent } from "@shared/call-only-agent";
import type { FsPathGrant, InstalledAgent, Project, RuntimeStatus } from "@/lib/types";
import { pickableAgents, toggleSelection } from "../NewAgentChatDialog";
import { IconArrowUp, IconCheck, IconPlus, IconChevronDown, IconCode, IconFolder, IconGithub, IconSearch, IconUsers } from "../Icon";
import { OneVoiceInputHelp } from "../one/OneVoiceInputHelp";
import { OneAgentPortrait } from "../one/OneAgentPortrait";
import { OneBottomSheet } from "../one/OneBottomSheet";
import { PopupAction } from "../Popup";
import { runtimeEffectiveModelId, runtimeModelDisplayLabel } from "../dashboard/RuntimeModelPicker";
import { startCopy, type SpaceLocale } from "./copy";
import styles from "./NewChatStart.module.css";

/*
 * New chat (Agentlas 2.0 F-D6, confirmed pictures workspace-v5-start-*): a pane with a centered composer and two drop-downs under it. Nothing exists
 * until the first message is sent - then the chat is made, opened in this pane, and shows in the left list with its first line.
 *   - project: the project of the conversation the person is looking at (the caller says which; none = "Empty project"). Never "the last one used".
 *   - the second drop-down is always "Work session" when it opens; picking agents there starts an Agent Chat with them instead (one = 1:1, more = a group).
 *   - the first message of a Work session is handed to the new chat's surface, which sends it like any typed message; an Agent Chat room opens with the
 *     words in its composer (the room's composer belongs to the personal agent's screen, which this change does not touch).
 * Words under the box say what the session will run with (read from the same runtime list the composer reads); they are not a second setting.
 */

const folderName = (grant: FsPathGrant): string => grant.path.split(/[\\/]/).filter(Boolean).pop() || grant.path;

export function NewChatStart({ projectId: wanted, onStarted }: {
  /** The project to start in: an id, or null = Empty project. */
  projectId: string | null;
  onStarted: (chatId: string, kind: "room" | "work") => void;
}) {
  const { locale: appLocale, t } = useT();
  const locale: SpaceLocale = appLocale === "ko" ? "ko" : "en";
  const copy = startCopy(locale);
  const [projects, setProjects] = useState<Project[] | "failed">(() => readViewData<Project[]>("dashboard.projects")?.value ?? []);
  const [projectId, setProjectId] = useState<string | null>(wanted);
  const [agents, setAgents] = useState<InstalledAgent[] | "loading" | "failed">("loading");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<"project" | "agents" | "plus" | null>(null);
  const [env, setEnv] = useState<{ grant: FsPathGrant | null; busy: boolean; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ model: string; effort: string | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef(0);

  // The project the caller wants follows the caller (a new "+" on another project row), but never overrides a pick the person made here.
  const pickedHere = useRef(false);
  useEffect(() => { if (!pickedHere.current) setProjectId(wanted); }, [wanted]);

  // Projects and agents are read once when the screen opens (and when the project list says it changed); nothing here polls.
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    const load = () => {
      if (!api) { setProjects("failed"); return; }
      api.projects.list().then((rows) => { if (!cancelled) { setProjects(rows); writeViewData("dashboard.projects", rows); setProjectId((chosen) => (chosen && !rows.some((row) => row.id === chosen) ? null : chosen)); } }).catch(() => { if (!cancelled) setProjects((previous) => (Array.isArray(previous) && previous.length ? previous : "failed")); });
    };
    load();
    window.addEventListener("agentlas:projects-changed", load);
    if (!api?.team?.list) setAgents("failed");
    else api.team.list().then((list) => { if (!cancelled) setAgents(pickableAgents(list)); }).catch(() => { if (!cancelled) setAgents("failed"); });
    if (api?.runtime?.detect) {
      void api.runtime.detect().then(async (list) => {
        const active = chipRuntimeFor(list, null);
        if (!active || cancelled) return;
        const models = await api.runtime.listModels?.({ kind: active.kind }).catch(() => []) ?? [];
        if (cancelled) return;
        const status = active as RuntimeStatus;
        const id = runtimeEffectiveModelId(status, models);
        const label = id ? runtimeModelDisplayLabel(status, locale, models) : status.kind;
        const effort = active.effort ? (active.efforts?.find((item) => item.id === active.effort)?.label ?? active.effort) : null;
        setRuntime({ model: label, effort });
      }).catch(() => undefined);
    }
    return () => { cancelled = true; window.removeEventListener("agentlas:projects-changed", load); };
  }, [locale]);

  // A drop-down closes on Escape and on a press outside it (events, not a clock).
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event: Event) => { if (!(event.target as Element | null)?.closest?.("[data-start-menu-area]")) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [menu]);

  const list = Array.isArray(agents) ? agents : [];
  const callOnly = useMemo(() => new Set(list.filter((agent) => isCallOnlyHubAgent(agent)).map((agent) => agent.id)), [list]);
  const nameOf = (agent: InstalledAgent) => agent.localDisplayName || (locale === "ko" ? agent.name : agent.nameEn || agent.name);
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? list.filter((agent) => `${agent.localDisplayName ?? ""} ${agent.name} ${agent.nameEn}`.toLocaleLowerCase().includes(needle)) : list;
  const projectList = Array.isArray(projects) ? projects : [];
  const currentProject = projectId ? projectList.find((project) => project.id === projectId) : null;
  const projectName = currentProject?.name ?? (projectId ? "…" : copy.emptyProject);
  const sessionName = selected.length === 0 ? copy.workSession : selected.length === 1 ? nameOf(list.find((agent) => agent.id === selected[0]) ?? ({ name: "?", nameEn: "?" } as InstalledAgent)) : copy.agentCount(selected.length);

  const start = useCallback(async () => {
    const message = text.trim();
    const api = ipc();
    if (!api || !message || busy) return;
    const mine = ++attempt.current;
    setBusy(true); setError(null);
    let madeProject: string | null = null;
    try {
      let target = projectId;
      if (target === null) {
        // "Empty project": a project whose folder Main makes and manages - made now, with the first message, never before.
        const made = await api.projects.create({ name: copy.emptyName, sourceType: "empty" });
        madeProject = made.id; target = made.id;
        window.dispatchEvent(new Event("agentlas:projects-changed"));
      }
      if (selected.length === 0) {
        const chat = await api.chats.create({ projectId: target });
        if (mine !== attempt.current) return;
        holdFirstMessage(chat.id, message);
        onStarted(chat.id, "work");
      } else {
        if (!api.chats.createAgentChat) throw new Error("unavailable");
        const made = await api.chats.createAgentChat({ agentIds: selected, projectId: target });
        if (mine !== attempt.current) return;
        holdFirstMessage(made.chat.id, message);
        onStarted(made.chat.id, "room");
      }
    } catch (cause) {
      if (mine !== attempt.current) return;
      // A project made for this start that no chat came out of is not left behind.
      if (madeProject) { void api.projects.remove(madeProject).then(() => window.dispatchEvent(new Event("agentlas:projects-changed"))).catch(() => undefined); }
      setBusy(false);
      setError(copy.failed(listFailureText(cause, locale)));
    }
  }, [text, busy, projectId, selected, onStarted, copy, locale]);

  const addEnvironment = async () => {
    const api = ipc();
    if (!api || !env?.grant || env.busy) return;
    setEnv({ ...env, busy: true, error: null });
    try {
      const made = await api.projects.create({ name: folderName(env.grant), sourceType: "local", folderGrant: env.grant });
      pickedHere.current = true;
      setProjects((previous) => { const rows = [made, ...(Array.isArray(previous) ? previous.filter((item) => item.id !== made.id) : [])]; writeViewData("dashboard.projects", rows); return rows; });
      setProjectId(made.id);
      setEnv(null);
      window.dispatchEvent(new Event("agentlas:projects-changed"));
    } catch { setEnv((current) => (current ? { ...current, busy: false, error: copy.envFailed } : current)); }
  };

  return (
    <div ref={root} className={styles.start} data-new-chat-start="true" aria-busy={busy ? "true" : "false"}>
      <div className={styles.column}>
        <div className={styles.pill}>
          <div className={styles.plusWrap} data-start-menu-area="true">
            <button type="button" className={styles.plus} aria-haspopup="menu" aria-expanded={menu === "plus"} aria-label={copy.plus} title={copy.plus} disabled={busy} data-new-chat-plus="true" onClick={() => setMenu(menu === "plus" ? null : "plus")}><IconPlus size={16} /></button>
            {menu === "plus" ? (
              <div className={styles.menu} role="menu" aria-label={copy.plus}>
                <button type="button" role="menuitem" className={styles.item} data-start-attach-folder="true" onClick={() => { setMenu(null); setEnv({ grant: null, busy: false, error: null }); }}>
                  <IconFolder size={15} /><span className={styles.itemText}>{copy.attachFolder}</span>
                </button>
              </div>
            ) : null}
          </div>
          <textarea ref={inputRef} className={styles.input} value={text} rows={1} placeholder={copy.composer} aria-label={copy.title} disabled={busy} data-new-chat-input="true" autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void start(); }
            }} />
          <span className={styles.voice} data-new-chat-voice="true"><OneVoiceInputHelp locale={locale} composerRef={inputRef} disabled={busy} surface="work" /></span>
          <button type="button" className={styles.send} aria-label={copy.send} title={copy.send} disabled={busy || !text.trim()} data-new-chat-send="true" onClick={() => void start()}><IconArrowUp size={16} /></button>
        </div>
        <div className={styles.row}>
          <div className={styles.drops} data-start-menu-area="true">
            <div className={styles.dropWrap}>
              <button type="button" className={styles.drop} aria-haspopup="menu" aria-expanded={menu === "project"} data-start-project="true" disabled={busy} onClick={() => setMenu(menu === "project" ? null : "project")}>
                <IconFolder size={14} /><span className={styles.dropText}>{projectName}</span><IconChevronDown size={13} />
              </button>
              {menu === "project" ? (
                <div className={styles.menu} role="menu" aria-label={copy.projectLabel}>
                  {projects === "failed" ? <p className={styles.note} role="alert">{copy.projectsFailed}</p> : null}
                  {projectList.map((project) => (
                    <button key={project.id} type="button" role="menuitemradio" aria-checked={project.id === projectId} className={styles.item} data-project-id={project.id}
                      onClick={() => { pickedHere.current = true; setProjectId(project.id); setMenu(null); }}>
                      <IconFolder size={15} /><span className={styles.itemText}>{project.name}</span>{project.id === projectId ? <IconCheck size={14} /> : null}
                    </button>
                  ))}
                  {projectList.length ? <div className={styles.rule} role="separator" /> : null}
                  <button type="button" role="menuitemradio" aria-checked={projectId === null} className={styles.item} data-start-empty="true"
                    onClick={() => { pickedHere.current = true; setProjectId(null); setMenu(null); }}>
                    <IconCode size={15} /><span className={styles.itemText}>{copy.emptyProject}</span>{projectId === null ? <IconCheck size={14} /> : null}
                  </button>
                  <button type="button" role="menuitem" className={styles.item} data-start-add-environment="true" onClick={() => { setMenu(null); setEnv({ grant: null, busy: false, error: null }); }}>
                    <IconFolder size={15} /><span className={styles.itemText}>{copy.addEnvironment}</span>
                  </button>
                </div>
              ) : null}
            </div>
            <div className={styles.dropWrap}>
              <button type="button" className={styles.drop} aria-haspopup="menu" aria-expanded={menu === "agents"} data-start-session="true" disabled={busy} onClick={() => setMenu(menu === "agents" ? null : "agents")}>
                {selected.length === 0 ? <IconCode size={14} /> : <IconUsers size={14} />}<span className={styles.dropText}>{sessionName}</span><IconChevronDown size={13} />
              </button>
              {menu === "agents" ? (
                <div className={`${styles.menu} ${styles.menuWide}`} role="menu" aria-label={copy.workSession}>
                  <button type="button" role="menuitemradio" aria-checked={selected.length === 0} className={styles.item} data-start-work-session="true" onClick={() => { setSelected([]); setMenu(null); }}>
                    <IconCode size={15} /><span className={styles.itemText}>{copy.workSession}</span>{selected.length === 0 ? <IconCheck size={14} /> : null}
                  </button>
                  <div className={styles.rule} role="separator" />
                  <label className={styles.search}><IconSearch size={14} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.findAgent} aria-label={copy.findAgent} />
                  </label>
                  <div className={styles.agents} role="group" aria-label={copy.findAgent}>
                    {agents === "loading" ? <p className={styles.note}>{copy.agentsLoading}</p>
                      : agents === "failed" ? <p className={styles.note} role="alert">{copy.agentsFailed}</p>
                      : list.length === 0 ? <p className={styles.note}>{copy.agentsNone}</p>
                      : shown.length === 0 ? <p className={styles.note}>{copy.agentsNoMatch}</p>
                      : shown.map((agent) => {
                        const checked = selected.includes(agent.id), only1to1 = callOnly.has(agent.id);
                        const blocked = only1to1 && selected.length > 0 && !checked;
                        return (
                          <button key={agent.id} type="button" role="menuitemcheckbox" aria-checked={checked} className={styles.item} data-agent-id={agent.id} disabled={blocked}
                            onClick={() => setSelected((current) => toggleSelection(current, agent.id, callOnly))}>
                            <OneAgentPortrait status="quiet" label={nameOf(agent)} tone={agent.tone} size="small" />
                            <span className={styles.itemText}>{nameOf(agent)}{only1to1 ? <small className={styles.sub}>{copy.callOnly}</small> : null}</span>
                            <span className={styles.box} data-checked={checked ? "true" : undefined} aria-hidden="true">{checked ? <IconCheck size={12} /> : null}</span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className={styles.words} data-start-words="true">
            <span>{runtime?.model ?? copy.modelUnknown}</span>
            {runtime?.effort ? <span>{runtime.effort}</span> : null}
            <span>{t("chatinput.perm.write")}</span>
          </div>
        </div>
        {busy ? <p className={styles.status} role="status">{copy.working}</p> : null}
        {error ? <p className={styles.error} role="alert" data-new-chat-error="true">{error}</p> : null}
      </div>
      <OneBottomSheet open={env !== null} onClose={() => setEnv(null)} closeLabel={copy.close} size="compact" title={copy.envTitle} titleId="new-chat-env-title" ariaLabelledBy="new-chat-env-title"
        description={copy.envBody} dataAttributes={{ "data-new-chat-env": "true" }}
        footer={<>
          <PopupAction onClick={() => setEnv(null)}>{copy.envCancel}</PopupAction>
          <PopupAction primary data-env-add="true" disabled={!env?.grant || env.busy} onClick={() => void addEnvironment()}>{copy.envAdd}</PopupAction>
        </>}>
        <div className={styles.envBody}>
          <div className={styles.envDrop} data-env-drop="true"
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (!file) return;
              void grantForDroppedFile(file).then((grant) => setEnv((current) => (current ? { ...current, grant: grant && grant.kind === "directory" ? grant : null, error: grant && grant.kind === "directory" ? null : copy.envNoDrop } : current)));
            }}>
            <IconFolder size={22} />
            <strong>{env?.grant ? copy.envPicked(folderName(env.grant)) : copy.envDrop}</strong>
            <PopupAction data-env-choose="true" onClick={() => { void ipc()?.workspace.selectFolder().then((grant) => { if (grant) setEnv((current) => (current ? { ...current, grant, error: null } : current)); }).catch(() => setEnv((current) => (current ? { ...current, error: copy.envFailed } : current))); }}>{copy.envChoose}</PopupAction>
          </div>
          {env?.error ? <p className={styles.error} role="alert">{env.error}</p> : null}
          <button type="button" className={styles.github} data-env-github="true" onClick={() => { setEnv(null); openProjectSettings({ mode: "create", sourceType: "github" }); }}>
            <IconGithub size={16} /><span>{copy.envGithub}</span>
          </button>
        </div>
      </OneBottomSheet>
    </div>
  );
}
