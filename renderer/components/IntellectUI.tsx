"use client";

import { memo, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  buildIntellectUiFollowup, evaluateIntellectUiExpression, getIntellectUiInitialValues,
  parseIntellectUiFence, type IntellectUiNode,
  type IntellectUiDocument, INTELLECT_UI_LIMITS,
} from "@shared/intellect-ui";
import { IntellectUiActions } from "@/lib/intellect-ui-actions";
import { useT } from "@/lib/i18n";
import styles from "./IntellectUI.module.css";

type Values = Record<string, string | number>;
const COLORS = ["var(--accent)", "#578b9f", "#c78654", "#7c76a4", "#749564", "#b6677c"];
const scalarText = (value: unknown) => value == null ? "—" : String(value);
const EMPTY_UI: IntellectUiDocument = { version: 1, children: [] };

/** Compile a validated component tree to native React controls; never execute model code. */
export const IntellectUI = memo(function IntellectUI({ code, blockId, complete }: {
  code: string; blockId: string; complete: boolean;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const actions = useContext(IntellectUiActions);
  const parsed = useMemo(() => parseIntellectUiFence(code, { streaming: !complete }), [code, complete]);
  const document = parsed.document ?? EMPTY_UI;
  const initial = useMemo(() => getIntellectUiInitialValues(document), [document]);
  const [edited, setEdited] = useState<Values>({});
  const [status, setStatus] = useState("");
  const [preparing, setPreparing] = useState(false);
  const inFlight = useRef(false);
  const values = useMemo(() => ({ ...initial, ...edited }), [initial, edited]);
  // State belongs to this message/fence. New streamed controls add defaults without resetting edits.
  useEffect(() => { setEdited({}); setStatus(""); }, [blockId]);
  const number = (value: number, precision = 4) => value.toLocaleString(ko ? "ko-KR" : "en-US", { maximumFractionDigits: precision });
  const change = (id: string, value: string | number) => {
    setEdited(previous => ({ ...previous, [id]: value }));
    setStatus("");
  };
  async function followup(node: Extract<IntellectUiNode, { type: "button" }>) {
    if (!complete || parsed.errors.length || actions.disabled || !actions.prepareFollowup || inFlight.current) return;
    const prompt = buildIntellectUiFollowup(node.action, values, document);
    if (!prompt) { setStatus(ko ? "입력값을 확인해 주세요." : "Check the input values."); return; }
    inFlight.current = true; setPreparing(true);
    try {
      const added = await actions.prepareFollowup(prompt);
      setStatus(added
        ? (ko ? "작성창에 추가했습니다. 내용을 확인하고 보내세요." : "Added to your message. Review it and send.")
        : (ko ? "이 대화의 작성창에 추가하지 못했습니다." : "Could not add this to this conversation's message."));
    } catch {
      setStatus(ko ? "작성창에 추가하지 못했습니다. 다시 시도해 주세요." : "Could not prepare the message. Try again.");
    } finally { inFlight.current = false; setPreparing(false); }
  }
  function render(node: IntellectUiNode, path: string): React.ReactNode {
    const key = node.id ?? path;
    switch (node.type) {
      case "container": case "card":
        return <section key={key} className={node.type === "card" ? styles.card : undefined}>
          {node.title && <h4 className={styles.heading}>{node.title}</h4>}
          <div className={[styles.children, node.layout === "horizontal" ? styles.horizontal : node.layout === "grid" ? styles.grid : ""].join(" ")}>
            {node.children.map((child, index) => render(child, `${path}.${index}`))}
          </div>
        </section>;
      case "text": return <p key={key} className={[styles.text, node.tone && node.tone !== "default" ? styles[node.tone] : ""].join(" ")}>{node.text}</p>;
      case "metric": case "calculator": {
        const value = node.expression !== undefined ? evaluateIntellectUiExpression(node.expression, values) : node.type === "metric" ? node.value : null;
        return <div key={key} className={styles.metric}>
          <span className={styles.label}>{node.label}</span>
          <output className={styles.value} aria-live="polite" data-ui-output={key}>
            {typeof value === "number" ? number(value, node.type === "calculator" ? node.precision ?? 4 : 4) : scalarText(value)}
            {node.unit && <span className={styles.unit}>{node.unit}</span>}
          </output>
          {node.type === "metric" && node.description && <span className={styles.label}>{node.description}</span>}
        </div>;
      }
      case "input": return <label key={key} className={styles.field}>
        <span>{node.label}</span>
        <input className={styles.input} type={node.inputType === "text" ? "text" : "number"} value={values[node.id] ?? ""}
          min={node.min} max={node.max} step={node.step ?? (node.inputType !== "text" ? "any" : undefined)} maxLength={INTELLECT_UI_LIMITS.inputChars}
          data-ui-input={node.id} onChange={event => {
            const raw = event.target.value;
            if (node.inputType === "text" || !raw.trim() || !Number.isFinite(Number(raw))) change(node.id, raw.slice(0, INTELLECT_UI_LIMITS.inputChars));
            else change(node.id, Math.min(node.max ?? Infinity, Math.max(node.min ?? -Infinity, Number(raw))));
          }} />
      </label>;
      case "select": return <label key={key} className={styles.field}>
        <span>{node.label}</span>
        <select className={styles.input} value={values[node.id] ?? node.options[0]?.value ?? ""} data-ui-input={node.id}
          onChange={event => change(node.id, event.target.value)}>
          {node.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>;
      case "slider": return <label key={key} className={styles.field}>
        <span>{node.label} <output>{number(Number(values[node.id] ?? node.min))}</output></span>
        <input className={styles.range} type="range" min={node.min} max={node.max} step={node.step ?? 1}
          value={values[node.id] ?? node.min} data-ui-input={node.id} onChange={event => change(node.id, Number(event.target.value))} />
        <span className={styles.rangeBounds}><span>{number(node.min)}</span><span>{number(node.max)}</span></span>
      </label>;
      case "button": return <div key={key}>
        <button type="button" className={styles.button} data-ui-action={key}
          disabled={!complete || Boolean(parsed.errors.length) || !actions.prepareFollowup || actions.disabled || preparing}
          onClick={() => { void followup(node); }}>{node.label}</button>
      </div>;
      case "table": return <IntellectTable key={key} node={node} />;
      case "chart": return <IntellectChart key={key} node={node} ko={ko} />;
      case "diagram": return <IntellectDiagram key={key} node={node} ko={ko} />;
    }
  }
  if (!document.children.length && !parsed.errors.length && complete) return null;
  return <section className={styles.surface} data-intellect-ui="true" data-ui-block={blockId} aria-busy={!complete || parsed.pending} aria-label={document.title || (ko ? "인터랙티브 응답" : "Interactive response")}>
    {document.title && <h3 className={styles.heading}>{document.title}</h3>}
    <div className={styles.children}>{document.children.map((node, index) => render(node, String(index)))}</div>
    {(!document.children.length && (!complete || parsed.pending)) && <p className={`${styles.hint} ${styles.loading}`} role="status">{ko ? "화면을 구성하고 있습니다…" : "Building the response…"}</p>}
    {parsed.errors.length > 0 && <p className={styles.hint} role="status">{ko ? "일부 내용을 표시하지 못했습니다." : "Some of this response could not be displayed."}</p>}
    {complete && document.children.some(hasButton) && !actions.prepareFollowup && <p className={styles.hint}>{ko ? "대화 화면에서 후속 요청을 보낼 수 있습니다." : "Open this in its conversation to prepare a follow-up."}</p>}
    {status && <p className={styles.status} role="status" aria-live="polite">{status}</p>}
  </section>;
});

function hasButton(node: IntellectUiNode): boolean {
  return node.type === "button" || ((node.type === "container" || node.type === "card") && node.children.some(hasButton));
}

function IntellectTable({ node }: { node: Extract<IntellectUiNode, { type: "table" }> }) {
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return node.rows;
    return [...node.rows].sort((left, right) => {
      const a = left[sort.column]; const b = right[sort.column];
      const order = typeof a === "number" && typeof b === "number" ? a - b : scalarText(a).localeCompare(scalarText(b), undefined, { numeric: true });
      return sort.descending ? -order : order;
    });
  }, [node.rows, sort]);
  return <section className={styles.card}>
    {node.title && <h4 className={styles.heading}>{node.title}</h4>}
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={node.title || node.columns.join(", ")}>
      <table className={styles.table}>
        <thead><tr>{node.columns.map((column, index) => <th key={index} scope="col" aria-sort={sort?.column === index ? sort.descending ? "descending" : "ascending" : "none"}>
          <button type="button" className={styles.sortButton} onClick={() => setSort(current => ({ column: index, descending: current?.column === index ? !current.descending : false }))}>
            {column}{sort?.column === index ? sort.descending ? " ↓" : " ↑" : " ↕"}
          </button>
        </th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{scalarText(cell)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function IntellectChart({ node, ko }: { node: Extract<IntellectUiNode, { type: "chart" }>; ko: boolean }) {
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const visible = node.series.map((series, index) => ({ ...series, index })).filter(series => !hidden.has(series.index));
  const values = visible.flatMap(series => series.values);
  const min = Math.min(0, ...values); const observedMax = Math.max(0, ...values);
  const max = observedMax === min ? min + 1 : observedMax;
  const range = max - min;
  const y = (value: number) => 200 - (value - min) / range * 170;
  const step = 530 / Math.max(1, node.labels.length);
  return <figure className={`${styles.card} ${styles.figure}`}>
    {node.title && <figcaption className={styles.heading}>{node.title}</figcaption>}
    <div className={styles.legend} aria-label={ko ? "표시할 데이터" : "Visible series"}>
      {node.series.map((series, index) => <button key={index} type="button" className={styles.legendButton} aria-pressed={!hidden.has(index)} onClick={() => setHidden(previous => {
        const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next;
      })}><span className={styles.swatch} style={{ background: COLORS[index % COLORS.length] }} />{series.name}</button>)}
    </div>
    <svg className={styles.chart} viewBox="0 0 640 252" role="img" aria-label={node.title || (ko ? "데이터 차트" : "Data chart")}>
      <title>{node.title || (ko ? "데이터 차트" : "Data chart")}</title>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1="64" x2="602" y1={30 + fraction * 170} y2={30 + fraction * 170} stroke="var(--paper-edge)" />
        <text x="56" y={34 + fraction * 170} textAnchor="end" fontSize="10" fill="currentColor">{(max - fraction * range).toLocaleString(undefined, { maximumFractionDigits: 2 })}</text>
      </g>)}
      <line x1="64" x2="602" y1={y(0)} y2={y(0)} stroke="var(--ink-soft)" opacity="0.35" />
      {node.labels.map((label, index) => <text key={index} x={68 + (index + 0.5) * step} y="224" textAnchor="middle" fontSize="10" fill="currentColor">{label.length > 13 ? `${label.slice(0, 12)}…` : label}</text>)}
      {visible.map((series, seriesIndex) => node.chartType === "line"
        ? <g key={series.index}>
          <polyline points={series.values.map((value, index) => `${68 + (index + 0.5) * step},${y(value)}`).join(" ")} fill="none" stroke={COLORS[series.index % COLORS.length]} strokeWidth="2.5" />
          {series.values.map((value, index) => <circle key={index} cx={68 + (index + 0.5) * step} cy={y(value)} r="3" fill={COLORS[series.index % COLORS.length]}><title>{`${series.name} · ${node.labels[index]}: ${value}`}</title></circle>)}
        </g>
        : <g key={series.index}>{series.values.map((value, index) => <rect key={index}
          x={68 + index * step + step * 0.12 + seriesIndex * step * 0.76 / Math.max(1, visible.length)}
          y={Math.min(y(value), y(0))} width={Math.max(1, step * 0.76 / Math.max(1, visible.length) - 2)} height={Math.abs(y(value) - y(0))}
          rx="2" fill={COLORS[series.index % COLORS.length]}><title>{`${series.name} · ${node.labels[index]}: ${value}`}</title></rect>)}</g>)}
      {node.yLabel && <text x="64" y="246" fontSize="11" fill="currentColor">{node.yLabel}</text>}
    </svg>
    <details className={styles.details}><summary>{ko ? "데이터 보기" : "View data"}</summary>
      <IntellectTable node={{ type: "table", columns: [ko ? "항목" : "Item", ...node.series.map(series => series.name)], rows: node.labels.map((label, index) => [label, ...node.series.map(series => series.values[index])]) }} />
    </details>
  </figure>;
}

function IntellectDiagram({ node, ko }: { node: Extract<IntellectUiNode, { type: "diagram" }>; ko: boolean }) {
  const markerId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [selected, setSelected] = useState<string | null>(null);
  const vertical = node.layout !== "horizontal";
  const width = vertical ? 360 : Math.max(640, node.nodes.length * 164);
  const height = vertical ? Math.max(120, node.nodes.length * 88) : 156;
  const position = (id: string) => {
    const index = Math.max(0, node.nodes.findIndex(item => item.id === id));
    return vertical ? { x: 8, y: 12 + index * 88 } : { x: 12 + index * 164, y: 30 };
  };
  const choice = node.nodes.find(item => item.id === selected);
  return <figure className={`${styles.card} ${styles.figure}`}>
    {node.title && <figcaption className={styles.heading}>{node.title}</figcaption>}
    <div className={styles.diagram}>
      <svg className={styles.diagramSvg} style={{ minWidth: vertical ? undefined : width }} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={node.title || (ko ? "인터랙티브 다이어그램" : "Interactive diagram")}>
        <defs><marker id={`ui-arrow-${markerId}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-soft)" /></marker></defs>
        {node.edges.map((edge, index) => {
          const from = position(edge.from); const to = position(edge.to);
          const x1 = vertical ? from.x + 172 : from.x + 144; const y1 = vertical ? from.y + 54 : from.y + 27;
          const x2 = vertical ? to.x + 172 : to.x; const y2 = vertical ? to.y : to.y + 27;
          return <g key={index}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ink-soft)" strokeWidth="1.5" markerEnd={`url(#ui-arrow-${markerId})`} markerStart={edge.bidirectional ? `url(#ui-arrow-${markerId})` : undefined} opacity={selected && edge.from !== selected && edge.to !== selected ? 0.25 : 0.75} />
            {edge.label && <text x={vertical ? x1 + 10 : (x1 + x2) / 2} y={vertical ? (y1 + y2) / 2 - 4 : Math.min(from.y, to.y) - 8} textAnchor={vertical ? "start" : "middle"} fontSize="11" fill="var(--ink-soft)">{edge.label.slice(0, 24)}</text>}</g>;
        })}
        {node.nodes.map(item => {
          const at = position(item.id); const size = vertical ? 344 : 144;
          const select = () => setSelected(previous => previous === item.id ? null : item.id);
          return <g key={item.id} className={styles.diagramNode} role="button" tabIndex={0} aria-label={item.label} aria-pressed={selected === item.id} onClick={select} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }}>
            <rect x={at.x} y={at.y} width={size} height="54" rx="10" fill="var(--paper-2)" stroke={selected === item.id ? "var(--accent)" : "var(--paper-edge)"} strokeWidth={selected === item.id ? 2 : 1} />
            <text className={styles.diagramLabel} x={at.x + size / 2} y={at.y + 31} textAnchor="middle">{item.label.length > (vertical ? 27 : 17) ? `${item.label.slice(0, vertical ? 26 : 16)}…` : item.label}</text><title>{item.label}</title>
          </g>;
        })}
      </svg>
    </div>
    {choice && <p className={styles.selection} role="status">{choice.label}{node.edges.filter(edge => edge.from === choice.id || edge.to === choice.id).map(edge => ` · ${edge.label || (ko ? "연결" : "Connected")}: ${node.nodes.find(item => item.id === (edge.from === choice.id ? edge.to : edge.from))?.label}`).join("")}</p>}
  </figure>;
}
