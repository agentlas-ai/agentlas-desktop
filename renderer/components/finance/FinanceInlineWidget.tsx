"use client";
import type { FinanceAIResult, FinanceWidget, FinanceWorkspace } from "@shared/finance";
import { IconFileText, IconChat } from "@/components/Icon";
import styles from "./FinanceInlineArtifact.module.css";
import noteStyles from "./FinanceInlineWidget.module.css";

export interface FinanceInlineWidgetSnapshot { dashboardId: string; widget: FinanceWidget; ownerScope: string | null; revision: number }
/** Only explicitly changed, successfully committed notes become message output. */
export function financeInlineWidgetSnapshots(response: FinanceAIResult, committed: FinanceWorkspace, operationsApplied: boolean, before: FinanceWorkspace): FinanceInlineWidgetSnapshot[] {
  if (!operationsApplied || response.status && response.status !== "ok" || before.ownerScope !== committed.ownerScope || response.baseRevision !== before.revision || committed.revision <= before.revision) return [];
  const touched = new Map<string, Set<string>>();
  for (const operation of response.operations ?? []) {
    if (operation.type !== "widget.add" && operation.type !== "widget.update") continue;
    const ids = touched.get(operation.dashboardId) ?? new Set<string>();
    ids.add(operation.type === "widget.add" ? operation.widget.id : operation.widgetId);
    touched.set(operation.dashboardId, ids);
  }
  return committed.dashboards.flatMap(dashboard => dashboard.widgets.filter(widget => widget.type === "notes" && touched.get(dashboard.id)?.has(widget.id) && JSON.stringify(before.dashboards.find(item => item.id === dashboard.id)?.widgets.find(item => item.id === widget.id)) !== JSON.stringify(widget)).map(widget => ({ dashboardId: dashboard.id, widget: structuredClone(widget), ownerScope: committed.ownerScope, revision: committed.revision })));
}
export function financeInlineWidgetCurrent(snapshot: FinanceInlineWidgetSnapshot, workspace: FinanceWorkspace): boolean {
  return snapshot.ownerScope === workspace.ownerScope && workspace.revision >= snapshot.revision && workspace.dashboards.some(dashboard => dashboard.id === snapshot.dashboardId && dashboard.widgets.some(widget => widget.type === "notes" && widget.id === snapshot.widget.id && JSON.stringify(widget) === JSON.stringify(snapshot.widget)));
}
export function FinanceInlineWidget({ snapshot, messageId, ko, current, busy, canOpen, onOpen, onContinue }: {
  snapshot: FinanceInlineWidgetSnapshot; messageId: string; ko: boolean; current: boolean; busy: boolean; canOpen: boolean; onOpen: () => void; onContinue: () => void;
}) {
  const { widget } = snapshot;
  return <section className={styles.card} data-widget-result-id={`${messageId}:${snapshot.dashboardId}:${widget.id}`} aria-label={widget.title}>
    <header className={styles.header}><h3 title={widget.title}>{widget.title}</h3><div className={styles.actions}>{canOpen && <button type="button" disabled={!current || busy} onClick={onOpen} aria-label={`${ko ? "저장한 메모 열기" : "Open saved note"} · ${widget.title}`} title={ko ? "메모 열기" : "Open note"}><IconFileText size={17}/></button>}</div></header>
    <p className={noteStyles.body}>{widget.notes || (ko ? "메모 내용이 없습니다." : "This note is empty.")}</p>
    <footer className={styles.footer}><button type="button" className={styles.continue} disabled={!current || busy} onClick={onContinue}><IconChat size={16}/>{ko ? "이 메모로 계속" : "Continue with this note"}</button>{!current && <span>{ko ? "저장한 메모가 변경되었습니다." : "The saved note has changed."}</span>}</footer>
  </section>;
}
