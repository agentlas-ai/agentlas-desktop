"use client";

/**
 * "결함 보고" (owner decision D5, 2026-09-28) — like Claude's app.
 *
 *  - AgiDefectChip: a small chip in the chat when AGI filed an our-defect for it. Pressing it opens the dialog.
 *  - AgiBugReportDialog: shows EXACTLY what will be sent (redaction already applied on this machine), and sends only
 *    when the owner presses Send. The generic help-menu entry uses the same dialog with a short form first.
 *  - "보낸 결함 보고": the owner's sent reports with the server status, including "수리됨 (버전)".
 */
import { useCallback, useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { AGI_BUG_REPORT_CATEGORIES, type AgiBugReportCategory, type AgiBugReportDraftInput, type AgiBugReportPreview,
  type AgiBugReportRow, type AgiDefectChip as DefectChip } from "@shared/agi";
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

function statusLabel(row: AgiBugReportRow, ko: boolean): string {
  if (row.fixedVersion) return ko ? `수리됨 (${row.fixedVersion})` : `Fixed (${row.fixedVersion})`;
  if (row.remoteStatus) return row.remoteStatus;
  if (row.status === "sent") return ko ? "보냄" : "Sent";
  if (row.status === "queued") return ko ? "보내기 대기 중 · 연결되면 자동으로 다시 보내요" : "Waiting to send · retries automatically";
  if (row.status === "failed") return ko ? `보내지 못함 · ${row.error ?? ""}` : `Not sent · ${row.error ?? ""}`;
  return row.status;
}

export function AgiBugReportDialog({ open, onClose, draft, locale }: {
  open: boolean; onClose: () => void; draft: AgiBugReportDraftInput | null; locale: "ko" | "en";
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
  const [sent, setSent] = useState<AgiBugReportRow[] | null>(null);
  const fromDefect = Boolean(draft?.defectId);

  const makePreview = useCallback(async (input: AgiBugReportDraftInput) => {
    const api = ipc()?.agi;
    if (!api) { setError(ko ? "이 버전에서는 결함 보고를 쓸 수 없어요." : "Defect reports are unavailable in this build."); return; }
    setBusy(true); setError(null);
    try { setPreview(await api.bugReportPreview(input)); } catch (e) { setError(codeOf(e)); } finally { setBusy(false); }
  }, [ko]);

  useEffect(() => {
    if (!open) return;
    setTab("new"); setTitle(""); setSummary(""); setCategory("other"); setPreview(null); setResult(null); setError(null); setSent(null);
    if (draft?.defectId) void makePreview(draft);
  }, [open, draft, makePreview]);

  useEffect(() => {
    if (!open || tab !== "sent") return;
    void ipc()?.agi?.bugReportList().then(setSent).catch((e) => setError(codeOf(e)));
  }, [open, tab]);

  if (!open) return null;
  const send = async () => {
    const api = ipc()?.agi;
    if (!api || !preview) return;
    setBusy(true); setError(null);
    try { setResult(await api.bugReportSend({ clientReportId: preview.clientReportId })); } catch (e) { setError(codeOf(e)); } finally { setBusy(false); }
  };

  return <div className={styles.backdrop} role="presentation" onClick={onClose}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={ko ? "결함 보고" : "Report a defect"} data-agi-bug-report="true"
      onClick={(event) => event.stopPropagation()}>
      <header className={styles.head}>
        <strong>{ko ? "결함 보고" : "Report a defect"}</strong>
        <div className={styles.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>{ko ? "새 보고" : "New"}</button>
          <button type="button" role="tab" aria-selected={tab === "sent"} onClick={() => setTab("sent")}>{ko ? "보낸 결함 보고" : "Sent reports"}</button>
        </div>
        <button type="button" className={styles.close} aria-label={ko ? "닫기" : "Close"} onClick={onClose}>×</button>
      </header>
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
          <label>{ko ? "무엇이 잘못됐나요? (제목)" : "What went wrong? (title)"}
            <input value={title} maxLength={140} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>{ko ? "자세히 (무엇을 하다가, 무엇을 기대했는데, 무엇이 일어났는지)" : "Details (what you did, expected, and saw)"}
            <textarea value={summary} maxLength={4000} rows={5} onChange={(event) => setSummary(event.target.value)} required />
          </label>
          <label>{ko ? "종류" : "Kind"}
            <select value={category} onChange={(event) => setCategory(event.target.value as AgiBugReportCategory)}>
              {AGI_BUG_REPORT_CATEGORIES.map((value) => <option key={value} value={value}>{(ko ? CATEGORY_KO : CATEGORY_EN)[value]}</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy || !title.trim() || !summary.trim()}>{ko ? "보낼 내용 미리 보기" : "Preview what will be sent"}</button>
        </form>}
        {preview && <>
          <p className={styles.muted}>{ko
            ? `아래 내용이 그대로 전송돼요. 비밀값·계정·경로 ${preview.redactions}곳은 이 컴퓨터에서 이미 가렸어요.${preview.signedIn ? "" : " 로그인하지 않아 요약·로그가 더 짧게 보내져요."}`
            : `Exactly this is sent. ${preview.redactions} secret/account/path spans were already masked on this computer.${preview.signedIn ? "" : " Not signed in: summary and log are sent shorter."}`}</p>
          <pre className={styles.preview} data-agi-bug-report-preview="true">{JSON.stringify(preview.payload, null, 2)}</pre>
        </>}
        {result && <p className={styles.result} role="status" data-agi-bug-report-result={result.status}>{result.status === "sent"
          ? (ko ? `보냈어요 · 번호 ${result.serverId ?? "-"}` : `Sent · id ${result.serverId ?? "-"}`)
          : statusLabel(result, ko)}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <footer className={styles.foot}>
          <button type="button" onClick={onClose}>{result ? (ko ? "닫기" : "Close") : (ko ? "보내지 않기" : "Don't send")}</button>
          {preview && !result && <button type="button" className={styles.primary} disabled={busy} onClick={() => { void send(); }}>
            {busy ? (ko ? "보내는 중…" : "Sending…") : (ko ? "보내기" : "Send")}</button>}
        </footer>
      </div>}
    </div>
  </div>;
}

/** The chip AGI leaves in a chat after it filed our own defect there. Nothing is sent until the owner presses Send. */
export function AgiDefectChip({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [defects, setDefects] = useState<DefectChip[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => {
    const api = ipc()?.agi;
    if (!chatId || !api) { setDefects([]); return; }
    void api.defectsForChat(chatId).then(setDefects).catch(() => setDefects([]));
  }, [chatId]);
  useEffect(() => {
    load();
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "chat" && (!change.id || change.id === chatId)) load(); });
    return () => { off?.(); };
  }, [chatId, load]);
  const pending = defects.find((defect) => defect.reportStatus === null || defect.reportStatus === "failed");
  if (!pending) return null;
  return <>
    <button type="button" className={styles.chip} data-agi-defect-chip={pending.code}
      title={ko ? `AGI가 앱 결함으로 분류했어요: ${pending.code}` : `AGI classified this as an app defect: ${pending.code}`}
      onClick={() => setOpen(true)}>{ko ? "결함 보고" : "Report defect"}</button>
    <AgiBugReportDialog open={open} locale={locale} draft={{ defectId: pending.defectId, chatId }}
      onClose={() => { setOpen(false); load(); }} />
  </>;
}
