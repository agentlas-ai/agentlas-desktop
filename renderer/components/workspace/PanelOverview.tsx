"use client";

import { useState, type ReactNode } from "react";
import { IconCheck, IconChevronDown, IconChevronRight, IconCode, IconFileText, IconFolder, IconImage, IconMonitor, IconSettings, IconTarget, IconUsers } from "@/components/Icon";
import styles from "./PanelOverview.module.css";

/*
 * The panel's first view, "Overview" (F-D7; picture workspace-v6-panels-1 / -2, 8): Environment, Activity, Outputs - three sections of quiet rows.
 * It draws what TaskSidePanel gives it and reads nothing itself: the rows come from the same activity the panel already reads, so nothing new is
 * asked of Main. A section with nothing to say is not drawn (no "0" rows): a fresh conversation shows an empty-state line instead.
 */
export type OverviewRowState = "running" | "done" | "failed" | "waiting";
export interface OverviewRow { id: string; label: string; state: OverviewRowState; meta?: string; mono?: boolean }
export interface OverviewOutput { id: string; name: string; kind: "file" | "image"; onOpen: () => void; /** Shown on hover when the name alone does not say which file it is (a path). */ title?: string }

export function PanelOverview({ locale, environment, onEnvironmentSettings, goal, onOpenGoal, subagents, commands, outputs, earlier, children, onOpenTerminal }: {
  locale: "ko" | "en";
  environment?: { name: string | null; folder: string | null } | null;
  onEnvironmentSettings?: () => void;
  goal?: { title: string; done: number; total: number } | null;
  onOpenGoal?: () => void;
  subagents: OverviewRow[];
  commands: OverviewRow[];
  outputs: OverviewOutput[];
  /** "Earlier" outputs of earlier runs, drawn under the list when the person presses it. Absent = no link. */
  earlier?: ReactNode;
  /** Whatever the panel keeps in this view besides the three sections (the continuity line, MCP results, sources). */
  children?: ReactNode;
  onOpenTerminal?: () => void;
}) {
  const ko = locale === "ko";
  const [open, setOpen] = useState<{ agents: boolean; commands: boolean; earlier: boolean }>({ agents: false, commands: false, earlier: false });
  const hasEnvironment = Boolean(environment && (environment.name || environment.folder));
  const hasActivity = Boolean(goal) || subagents.length > 0 || commands.length > 0;
  const fold = (key: "agents" | "commands") => setOpen((current) => ({ ...current, [key]: !current[key] }));
  // A finished command is a check mark (picture 2); everything else is the quiet dot (blue = running, green = done, red = failed).
  const dot = (state: OverviewRowState, check = false) => check && state === "done" ? <IconCheck size={13} style={{ color: "var(--ok)" }} aria-hidden="true" /> : <i className={styles.dot} data-state={state} aria-hidden="true" />;
  const rowsOf = (rows: OverviewRow[], check = false) => rows.map((row) => (
    <div key={row.id} className={`${styles.row} ${styles.sub}`} data-overview-sub-row={row.state}>
      {dot(row.state, check)}
      <span className={styles.grow} data-mono={row.mono ? "true" : undefined} title={row.label}>{row.label}</span>
      {row.meta ? <small>{row.meta}</small> : null}
    </div>
  ));
  const running = (rows: OverviewRow[]) => rows.filter((row) => row.state === "running").length;
  return (
    <div className={styles.overview} data-panel-overview="true">
      {hasEnvironment && <section className={styles.sec} data-overview-section="environment">
        <h4>{ko ? "환경" : "Environment"}</h4>
        {environment?.name ? <div className={styles.row}>
          <IconMonitor size={15} aria-hidden="true" /><span className={styles.grow} title={environment.name}>{environment.name}</span>
          {onEnvironmentSettings ? <button type="button" className={styles.iconButton} aria-label={ko ? "프로젝트 설정" : "Project settings"} title={ko ? "프로젝트 설정" : "Project settings"} onClick={onEnvironmentSettings}><IconSettings size={15} /></button> : null}
        </div> : null}
        {environment?.folder ? <div className={styles.row}><IconFolder size={15} aria-hidden="true" /><span className={styles.grow} title={environment.folder}>{environment.folder}</span></div> : null}
      </section>}
      {hasActivity && <section className={styles.sec} data-overview-section="activity">
        <h4>{ko ? "활동" : "Activity"}</h4>
        {goal ? <button type="button" className={`${styles.row} ${styles.press}`} onClick={onOpenGoal} data-overview-row="goal">
          <IconTarget size={15} aria-hidden="true" /><span className={styles.grow}>{ko ? "목표" : "Goal"} · {goal.title}</span>
          {goal.total > 0 ? <span className={styles.num}>{goal.done} / {goal.total}</span> : null}<IconChevronRight size={13} aria-hidden="true" />
        </button> : null}
        {subagents.length > 0 && <>
          <button type="button" className={`${styles.row} ${styles.press}`} aria-expanded={open.agents} onClick={() => fold("agents")} data-overview-row="subagents">
            <IconUsers size={15} aria-hidden="true" /><span className={styles.grow} data-open={open.agents ? "true" : undefined}>{ko ? "하위 에이전트" : "Subagents"}</span>
            <span className={styles.num}>{subagents.length}</span>{open.agents ? <IconChevronDown size={13} aria-hidden="true" /> : <IconChevronRight size={13} aria-hidden="true" />}
          </button>
          {open.agents && rowsOf(subagents)}
        </>}
        {commands.length > 0 && <>
          <button type="button" className={`${styles.row} ${styles.press}`} aria-expanded={open.commands} onClick={() => fold("commands")} data-overview-row="commands">
            <IconCode size={15} aria-hidden="true" /><span className={styles.grow} data-open={open.commands ? "true" : undefined}>{ko ? "명령" : "Commands"}</span>
            <span className={styles.num}>{running(commands) > 0 ? (ko ? `${running(commands)}개 실행 중` : `${running(commands)} running`) : commands.length}</span>{open.commands ? <IconChevronDown size={13} aria-hidden="true" /> : <IconChevronRight size={13} aria-hidden="true" />}
          </button>
          {open.commands && <>{rowsOf(commands, true)}{onOpenTerminal ? <button type="button" className={`${styles.row} ${styles.sub} ${styles.press}`} onClick={onOpenTerminal}><span className={styles.grow}>{ko ? "터미널 열기" : "Open the terminal"}</span><IconChevronRight size={13} aria-hidden="true" /></button> : null}</>}
        </>}
      </section>}
      <section className={styles.sec} data-overview-section="outputs">
        <h4>{ko ? "산출물" : "Outputs"}{earlier ? <button type="button" className={styles.earlier} aria-expanded={open.earlier} onClick={() => setOpen((current) => ({ ...current, earlier: !current.earlier }))}>{ko ? "이전" : "Earlier"}</button> : null}</h4>
        {outputs.length === 0 ? <p className={styles.empty}>{ko ? "생성한 파일과 사이트가 여기에 표시돼요" : "Files or sites you create appear here"}</p>
          : outputs.map((item) => <button key={item.id} type="button" className={`${styles.row} ${styles.press}`} onClick={item.onOpen} data-overview-output={item.kind}>
            {item.kind === "image" ? <IconImage size={15} aria-hidden="true" /> : <IconFileText size={15} aria-hidden="true" />}<span className={styles.grow} title={item.title ?? item.name}>{item.name}</span>
          </button>)}
        {earlier && open.earlier ? <div className={styles.earlierBody}>{earlier}</div> : null}
      </section>
      {children}
    </div>
  );
}
