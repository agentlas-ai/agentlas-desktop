import { createFinanceDashboard, createFinanceWidget, financeEvidenceMetric, type FinanceDataSaveResult, type FinanceOperation, type FinanceWorkspace } from '../../shared/finance';

/** Independent CAS proposals; values and provenance remain in the saved report projection. */
export function financeReportDashboardActions(workspace: FinanceWorkspace, reportId: string): NonNullable<FinanceDataSaveResult['dashboardActions']> {
  const report = workspace.reports.find(item => item.id === reportId);
  const target = workspace.dashboards.find(item => item.id === workspace.activeDashboardId) ?? workspace.dashboards[0];
  const sections: NonNullable<FinanceDataSaveResult['dashboardActions']>['sections'] = [];
  if (!report || target && target.widgets.length >= 80) return { expectedRevision: workspace.revision, sections };
  for (const section of report.sections) {
    if (!section.projection) continue;
    let metric: string;
    // Legacy IDs may be valid individually but exceed the reserved metric bound.
    // Reading or saving their report must still succeed without an invalid proposal.
    try { metric = financeEvidenceMetric(report.id, section.id); } catch { continue; }
    const timeline = section.projection.rows.length > 0 && section.projection.rows.every(row => typeof row[0] === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(row[0]) && row.slice(1).some(value => typeof value === 'number'));
    const widget = { ...createFinanceWidget(timeline ? 'chart' : 'comparison', `${report.title} · ${section.title}`.slice(0, 300)), metric, assetIds: [], periodMode: 'pinned' as const, period: 'all' as const, chartType: timeline ? 'line' as const : 'table' as const };
    const dashboard = target ?? createFinanceDashboard(report.title);
    const operations: FinanceOperation[] = target ? [] : [{ type: 'dashboard.add', dashboard }];
    operations.push({ type: 'widget.add', dashboardId: dashboard.id, widget });
    sections.push({ sectionId: section.id, operations });
  }
  return { expectedRevision: workspace.revision, sections };
}
