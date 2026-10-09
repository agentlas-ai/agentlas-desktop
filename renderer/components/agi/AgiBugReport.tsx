"use client";

/**
 * "결함 보고" (owner decision D5, 2026-09-28) — like Claude's app.
 *
 *  - AgiDefectChip: a small chip in the chat when AGI filed an our-defect for it. Pressing it opens the dialog.
 *  - AgiBugReportDialog: shows EXACTLY what will be sent (redaction already applied on this machine), and sends only
 *    when the owner presses Send. The generic help-menu entry uses the same dialog with a short form first.
 *  - "보낸 결함 보고": the owner's sent reports with the server status, including "수리됨 (버전)".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { AGI_BUG_REPORT_CATEGORIES, type AgiBugReportCategory, type AgiBugReportDraftInput, type AgiBugReportPreview,
  type AgiBugReportRow, type AgiDefectChip as DefectChip } from "@shared/agi";
import { PopupFrame } from "../Popup";
import { IconBug } from "../Icon";
import styles from "./AgiBugReport.module.css";

const CATEGORY_KO: Record<AgiBugReportCategory, string> = {
  crash: "앱이 멈추거나 꺼짐", stall: "작업이 멈춰 진행 안 됨", "wrong-result": "결과가 틀림", ui: "화면 문제", login: "로그인 문제", other: "기타",
};
const CATEGORY_EN: Record<AgiBugReportCategory, string> = {
  crash: "Crash or freeze", stall: "Work stopped moving", "wrong-result": "Wrong result", ui: "Screen problem", login: "Sign-in problem", other: "Other",
};

function codeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return /agi\.[a-z0-9.-]+/.exec(text)?.[0] ?? text.slice(0, 160);
}

export function acknowledgedBugReport(row: AgiBugReportRow): boolean {
  return row.status === "sent" && Boolean(row.serverId?.trim());
}

function statusLabel(row: AgiBugReportRow, ko: boolean): string {
  if (row.fixedVersion) return ko ? `수리됨 (${row.fixedVersion})` : `Fixed (${row.fixedVersion})`;
  if (row.remoteStatus) return row.remoteStatus;
  if (row.status === "sent") return acknowledgedBugReport(row)
    ? (ko ? "보냄" : "Sent")
    : (ko ? "접수 확인 필요 · 같은 보고를 다시 보내지 마세요" : "Receipt unconfirmed · do not resend this report");
  if (row.status === "queued") return ko ? "보내기 대기 중 · 연결되면 자동으로 다시 보내요" : "Waiting to send · retries automatically";
  if (row.status === "failed") return ko ? `보내지 못함 · ${row.error ?? ""}` : `Not sent · ${row.error ?? ""}`;
  return row.status;
}

export function AgiBugReportDialog({ open, onClose, draft, locale, onReportUpdated }: {
  open: boolean; onClose: () => void; draft: AgiBugReportDraftInput | null; locale: "ko" | "en";
  onReportUpdated?: (report: AgiBugReportRow) => void;
}) {
  const ko = locale === "ko";
  const [tab, setTab] = useState<"new" | "sent">("new");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState<AgiBugReportCategory>("other");
  const [preview, setPreview] = useState<AgiBugReportPreview | null>(null);
  const [result, setResult] = useState<AgiBugReportRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<AgiBugReportRow[] | null>(null);
  const operation = useRef<object | null>(null);
  const context = useRef<string | null>(null);
  const generation = useRef(0);
  const currentPreview = useRef<AgiBugReportPreview | null>(null);
  const lastInput = useRef<AgiBugReportDraftInput | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const draftKey = JSON.stringify(draft ?? {});
  const fromDefect = Boolean(draft?.defectId || (draft?.runId && draft.title && draft.summary));
  const reportedCallback = useRef(onReportUpdated);
  reportedCallback.current = onReportUpdated;

  useEffect(() => () => { generation.current += 1; operation.current = null; }, []);

  const makePreview = useCallback(async (input: AgiBugReportDraftInput) => {
    if (operation.current) return;
    const api = ipc()?.agi;
    if (!api) { setError(ko ? "이 버전에서는 결함 보고를 쓸 수 없어요." : "Defect reports are unavailable in this build."); return; }
    const ticket = {};
    const epoch = generation.current;
    operation.current = ticket;
    lastInput.current = input;
    setBusy(true); setError(null);
    try {
      const next = await api.bugReportPreview(input);
      if (epoch !== generation.current) return;
      currentPreview.current = next;
      setPreview(next);
      setResult(next.report && next.report.status !== "draft" ? next.report : null);
      if (next.report) reportedCallback.current?.(next.report);
    } catch (e) { if (epoch === generation.current) setError(codeOf(e)); }
    finally { if (operation.current === ticket) { operation.current = null; setBusy(false); } }
  }, [ko]);

  useEffect(() => {
    if (!open) return;
    setTab("new"); setError(null); setSent(null);
    if (context.current !== draftKey) {
      context.current = draftKey; generation.current += 1; operation.current = null;
      currentPreview.current = null; lastInput.current = null;
      setTitle(""); setSummary(""); setCategory("other"); setPreview(null); setResult(null); setBusy(false); setSending(false);
    }
    // Reopening refreshes the same persisted report, including queued/sent state.
    // A new parent object with the same draft fields does not recreate a draft.
    if (latestDraft.current && (latestDraft.current.defectId || (latestDraft.current.runId && latestDraft.current.title && latestDraft.current.summary))) void makePreview(latestDraft.current);
    else if (currentPreview.current && lastInput.current) void makePreview(lastInput.current);
  }, [open, draftKey, makePreview]);

  useEffect(() => {
    if (!open || tab !== "sent") return;
    void ipc()?.agi?.bugReportList().then(setSent).catch((e) => setError(codeOf(e)));
  }, [open, tab]);

  if (!open) return null;
  const send = async () => {
    const api = ipc()?.agi;
    // React state renders later; claim synchronously before the first IPC await.
    if (operation.current || !api || !preview || result?.status === "sent" || result?.status === "queued") return;
    const ticket = {};
    const epoch = generation.current;
    operation.current = ticket;
    setBusy(true); setSending(true); setError(null);
    try {
      const next = await api.bugReportSend({ clientReportId: preview.clientReportId });
      if (epoch === generation.current) {
        setResult(next);
        reportedCallback.current?.(next);
      }
    } catch (e) { if (epoch === generation.current) setError(codeOf(e)); }
    finally { if (operation.current === ticket) { operation.current = null; setBusy(false); setSending(false); } }
  };

  return <PopupFrame title={ko ? "결함 보고" : "Report a defect"} icon={<IconBug size={18} />} closeLabel={ko ? "닫기" : "Close"} onClose={onClose} size="wide" dataAttributes={{ "data-agi-bug-report": "true" }}>
      <div className={styles.tabs} role="tablist" aria-label={ko ? "보고 목록" : "Reports"}>
        <button type="button" role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>{ko ? "새 보고" : "New"}</button>
        <button type="button" role="tab" aria-selected={tab === "sent"} onClick={() => setTab("sent")}>{ko ? "보낸 보고" : "Sent"}</button>
      </div>
      {tab === "sent" ? <div className={styles.body}>
        {!sent ? <p className={styles.muted}>{ko ? "불러오는 중…" : "Loading…"}</p>
          : !sent.length ? <p className={styles.muted}>{ko ? "보낸 결함 보고가 없어요." : "No reports sent yet."}</p>
          : <ul className={styles.list}>{sent.map((row) => <li key={row.clientReportId} data-report-status={row.status}>
            <span>{row.title}</span><em>{statusLabel(row, ko)}</em>
          </li>)}</ul>}
      </div> : <div className={styles.body}>
        {!fromDefect && !preview && <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          void makePreview({ ...(draft ?? {}), title, summary, category });
        }}>
          <label>{ko ? "제목" : "Title"}
            <input value={title} maxLength={140} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>{ko ? "상황 · 기대 · 실제 결과" : "Context · Expected · Actual"}
            <textarea value={summary} maxLength={4000} rows={5} onChange={(event) => setSummary(event.target.value)} required />
          </label>
          <label>{ko ? "종류" : "Kind"}
            <select value={category} onChange={(event) => setCategory(event.target.value as AgiBugReportCategory)}>
              {AGI_BUG_REPORT_CATEGORIES.map((value) => <option key={value} value={value}>{(ko ? CATEGORY_KO : CATEGORY_EN)[value]}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy || !title.trim() || !summary.trim()}>{ko ? "전송 미리보기" : "Preview send"}</button>
        </form>}
        {preview && <>
          <p className={styles.muted}>{ko
            ? `아래 내용이 그대로 전송돼요. 비밀값·계정·경로 ${preview.redactions}곳은 이 컴퓨터에서 이미 가렸어요.${preview.signedIn ? "" : " 로그인하지 않아 요약·로그가 더 짧게 보내져요."}`
            : `Exactly this is sent. ${preview.redactions} secret/account/path spans were already masked on this computer.${preview.signedIn ? "" : " Not signed in: summary and log are sent shorter."}`}</p>
          <pre className={styles.preview} data-agi-bug-report-preview="true">{JSON.stringify(preview.payload, null, 2)}</pre>
        </>}
        {sending && <p className={styles.result} role="status">{ko ? "전송 중… 닫아도 계속 보내요." : "Sending… You can close while it continues."}</p>}
        {!sending && result && <p className={styles.result} role="status" data-agi-bug-report-result={result.status}>{acknowledgedBugReport(result)
          ? (ko ? `보냈어요 · 번호 ${result.serverId ?? "-"}` : `Sent · id ${result.serverId ?? "-"}`)
          : statusLabel(result, ko)}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <footer className={styles.foot}>
          {!sending && result?.status !== "sent" && result?.status !== "queued" && <button type="button" onClick={onClose}>
            {result ? (ko ? "닫기" : "Close") : (ko ? "보내지 않기" : "Don't send")}</button>}
          {!fromDefect && preview && <button type="button" disabled={busy} onClick={() => {
            if (operation.current) return;
            generation.current += 1; currentPreview.current = null; lastInput.current = null;
            setPreview(null); setResult(null); setError(null); setTitle(""); setSummary(""); setCategory("other");
          }}>{ko ? "새 보고 작성" : "Write a new report"}</button>}
          {preview && <button type="button" className={styles.primary} disabled={busy && !sending}
            onClick={() => { if (sending || result?.status === "sent" || result?.status === "queued") onClose(); else void send(); }}>
            {sending || result?.status === "sent" || result?.status === "queued" ? (ko ? "닫기" : "Close")
              : busy ? (ko ? "불러오는 중…" : "Loading…")
              : result?.status === "failed" || error ? (ko ? "다시 보내기" : "Retry") : (ko ? "보내기" : "Send")}</button>}
        </footer>
      </div>}
  </PopupFrame>;
}

/** Read the persisted incident receipt. Previews are local; only Send dispatches it. */
export function AgiIncidentReportButton({ draft, locale, onAcknowledged }: {
  draft: AgiBugReportDraftInput; locale: "ko" | "en"; onAcknowledged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const key = JSON.stringify(draft);
  const latest = useRef(draft);
  const queued = useRef(false);
  const receiptGeneration = useRef(0);
  const acknowledgedCallback = useRef(onAcknowledged);
  acknowledgedCallback.current = onAcknowledged;
  latest.current = draft;
  useEffect(() => {
    let live = true;
    let reading = false;
    queued.current = false;
    receiptGeneration.current += 1;
    const read = async () => {
      if (reading || !ipc()?.agi) return;
      reading = true;
      const generation = receiptGeneration.current;
      try {
        const preview = await ipc()!.agi.bugReportPreview(latest.current);
        if (live && generation === receiptGeneration.current) {
          queued.current = preview.report?.status === "queued";
          if (preview.report && acknowledgedBugReport(preview.report)) {
            setAcknowledged(key);
            acknowledgedCallback.current?.();
          }
        }
      } catch { /* A failed receipt read must leave the report action reachable. */ }
      finally { reading = false; }
    };
    void read();
    // Offline reports may be acknowledged by Main's existing retry queue.
    const timer = window.setInterval(() => { if (queued.current && document.visibilityState !== "hidden") void read(); }, 5_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [key]);
  return <>
    {acknowledged !== key && <button type="button" className={styles.chip} style={{ alignSelf: "flex-start" }}
      data-agi-incident-report={draft.failureCode ?? draft.defectId} data-agi-defect-chip={draft.defectId ? draft.failureCode : undefined}
      onClick={() => setOpen(true)}>{locale === "ko" ? "결함 보고" : "Report defect"}</button>}
    <AgiBugReportDialog open={open} draft={draft} locale={locale} onClose={() => setOpen(false)}
      onReportUpdated={(report) => {
        receiptGeneration.current += 1;
        queued.current = report.status === "queued";
        if (acknowledgedBugReport(report)) {
          setAcknowledged(key);
          acknowledgedCallback.current?.();
        }
      }} />
  </>;
}

/** The chip AGI leaves in a chat after it filed our own defect there. Nothing is sent until the owner presses Send. */
export function AgiDefectChip({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [defects, setDefects] = useState<DefectChip[]>([]);
  const [loadedChat, setLoadedChat] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    const api = ipc()?.agi;
    if (!chatId || !api) { setDefects([]); setLoadedChat(chatId); return; }
    void api.defectsForChat(chatId).then((rows) => {
      if (generation === loadGeneration.current) { setDefects(rows); setLoadedChat(chatId); }
    }).catch(() => { if (generation === loadGeneration.current) setDefects([]); });
  }, [chatId]);
  useEffect(() => {
    load();
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "chat" && (!change.id || change.id === chatId)) load(); });
    return () => { off?.(); loadGeneration.current += 1; };
  }, [chatId, load]);
  const visibleDefects = loadedChat === chatId ? defects : [];
  const pending = visibleDefects.find((defect) => !defect.resolved && defect.reportStatus !== "sent");
  if (!pending) {
    // Nothing left to report here. If AGI filed defects in this chat that a commit has since fixed, say so quietly.
    const fixed = visibleDefects.find((defect) => defect.resolved);
    if (!fixed?.resolved) return null;
    const commit = fixed.resolved.commit.split(",")[0] ?? "";
    return <span className={styles.chip} data-agi-defect-resolved={fixed.code}
      title={fixed.resolved.note || (ko ? "이 결함은 수정됐어요" : "This defect was fixed")}>
      {ko ? `해결됨${commit ? ` · ${commit}` : ""}` : `Fixed${commit ? ` · ${commit}` : ""}`}</span>;
  }
  return <AgiIncidentReportButton key={pending.defectId} locale={locale} onAcknowledged={load}
    draft={{ defectId: pending.defectId, failureCode: pending.code, chatId }} />;
}
