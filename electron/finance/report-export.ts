import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FinanceReport } from '../../shared/finance';
import { financeReportHtml, financeReportSectionTitle, reportLanguage, selectFinanceReportSections, type FinanceReportKeyFigure } from '../../shared/finance-report-presentation';
import { financeReportSeriesChart } from '../../shared/finance-report-svg';
import { userDataPath } from '../runtime-paths';

/**
 * A saved Finance report as one self-contained HTML file, written by the Main process so a Work or One conversation can hand it over
 * as an output without the Finance screen: the report's own text, its charts, key figures computed from its saved rows, a notice. The page
 * is static (a CSP of default-src none, no script, images only as inline data) and draws no source or as-of line.
 *
 * Charts: a section that holds one clear dated series (price history, Treasury par curve, FRED series, ECB reference rates) is drawn as an
 * inline SVG line from those saved rows (shared/finance-report-svg.ts). Vega is a development-only package and not available to the Main
 * process, so a chart the Finance screen draws with Vega (a custom chart spec, an allocation donut, a forecast fan) appears here as the table
 * of its saved rows instead; the Finance screen's own "export" keeps drawing those with Vega.
 */
export interface FinanceReportFile { path: string; name: string; bytes: number; sha256: string; sections: number; charts: number; language: string }
const LIMIT = 8 * 1024 * 1024;

export function buildFinanceReportHtml(report: FinanceReport, options: { generatedAt?: string } = {}): { html: string; language: string; sections: number; charts: number } {
  const language = reportLanguage(report), charts: Record<string, string> = {}, figures: Record<string, FinanceReportKeyFigure[]> = {};
  const sections = selectFinanceReportSections(report);
  for (const section of sections) {
    if (section.presentation === 'narrative' || section.presentation === 'comparison') continue;
    const drawn = financeReportSeriesChart(section, language, financeReportSectionTitle(section, language));
    if (drawn) { charts[section.id] = drawn.svg; figures[section.id] = drawn.figures; }
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return { html: financeReportHtml({ report, locale: language, charts, figures, generatedAt }), language, sections: sections.length, charts: Object.keys(charts).length };
}

/** Content-addressed, so the same report written twice is one file; the folder is the owner's and nothing in it is read back as an instruction. */
export function writeFinanceReportFile(ownerKey: string, report: FinanceReport, html: string): FinanceReportFile & { sections: number } {
  if (!/^[a-f0-9]{64}$/.test(ownerKey) || !html || Buffer.byteLength(html) > LIMIT) throw new Error('finance_report_export_invalid');
  const bytes = Buffer.from(html, 'utf8'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const stem = report.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'report';
  const name = `finance-report-${stem}.html`;
  const directory = userDataPath('generated-assets', 'finance-reports', ownerKey, sha256);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('finance_report_export_invalid');
  const file = path.join(directory, name);
  try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size !== bytes.length || createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== sha256) throw new Error('finance_report_export_invalid'); }
  finally { fs.closeSync(fd); }
  return { path: file, name, bytes: bytes.length, sha256, sections: 0, charts: 0, language: '' };
}

/** Build and write in one step; the receipt names the file, never its location in the model's result. */
export function exportFinanceReportFile(ownerKey: string, report: FinanceReport, generatedAt?: string): FinanceReportFile {
  const built = buildFinanceReportHtml(report, { generatedAt });
  const file = writeFinanceReportFile(ownerKey, report, built.html);
  return { ...file, sections: built.sections, charts: built.charts, language: built.language };
}
