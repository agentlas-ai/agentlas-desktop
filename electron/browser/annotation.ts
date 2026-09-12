import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { nativeBrowserGuest, nativeBrowserGuestDocument } from "../work-live-view";
import { BROWSER_ANNOTATION_SCHEMA, type BrowserAnnotationAPI, type BrowserAnnotationReceipt, type BrowserAnnotationResult,
  type BrowserAnnotationSelection, type BrowserAnnotationSession, type BrowserAnnotationTarget } from "../../shared/browser-annotation";
import { annotationInstallScript, annotationReadScript, annotationStopScript, BROWSER_ANNOTATION_WORLD } from "./annotation-script";

type Entry = { ownerId: number; guest: WebContents; session: BrowserAnnotationSession; expiresAt: number;
  sequence: number; selection: BrowserAnnotationSelection | null; receipt: BrowserAnnotationReceipt | null };
const sessions = new Map<string, Entry>();
const starts = new Map<string, string>();
const TTL = 5 * 60_000;
function targetValid(value: BrowserAnnotationTarget): boolean {
  return !!value && /^[A-Za-z0-9_-]{8,80}$/.test(String(value.viewId ?? "")) && /^[A-Za-z0-9_:.-]{8,200}$/.test(String(value.taskScopeId ?? ""));
}
function failure(reason: string): { ok: false; reason: string } { return { ok: false, reason }; }
async function execute(guest: WebContents, code: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([guest.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code }]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("annotation_script_timeout")), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function current(entry: Entry): boolean {
  const doc = nativeBrowserGuestDocument(entry.ownerId, entry.session.taskScopeId, entry.session.viewId);
  return sessions.get(entry.session.sessionId) === entry && entry.expiresAt > Date.now() && !!doc && doc.state === "ready"
    && doc.webContentsId === entry.guest.id && doc.navigationEpoch === entry.session.navigationEpoch
    && doc.url === entry.session.sourceUrl && nativeBrowserGuest(entry.ownerId, entry.session.taskScopeId, entry.session.viewId) === entry.guest;
}
function find(ownerId: number, input: BrowserAnnotationTarget & { sessionId: string }): Entry | null {
  if (!targetValid(input) || typeof input.sessionId !== "string") return null;
  const entry = sessions.get(input.sessionId);
  return entry?.ownerId === ownerId && entry.session.taskScopeId === input.taskScopeId && entry.session.viewId === input.viewId ? entry : null;
}
async function remove(entry: Entry): Promise<void> {
  sessions.delete(entry.session.sessionId);
  if (!entry.guest.isDestroyed()) await execute(entry.guest, annotationStopScript(entry.session.sessionId)).catch(() => {});
}
function validElement(value: unknown): value is BrowserAnnotationSelection["element"] {
  if (!value || typeof value !== "object") return false;
  const e = value as BrowserAnnotationSelection["element"];
  return typeof e.tagName === "string" && /^[a-z0-9-]{1,80}$/.test(e.tagName)
    && typeof e.selector === "string" && e.selector.length <= 512 && typeof e.textSnippet === "string" && e.textSnippet.length <= 500
    && (e.role === null || typeof e.role === "string" && e.role.length <= 80)
    && (e.ariaLabel === null || typeof e.ariaLabel === "string" && e.ariaLabel.length <= 200)
    && !!e.rect && [e.rect.x,e.rect.y,e.rect.width,e.rect.height].every(n => Number.isFinite(n) && Math.abs(n) < 10_000_000)
    && e.rect.width >= 0 && e.rect.height >= 0;
}

export async function startBrowserAnnotation(ownerId: number, input: BrowserAnnotationTarget): ReturnType<BrowserAnnotationAPI["start"]> {
  if (!targetValid(input)) return failure("annotation_invalid_target");
  const targetKey = `${ownerId}:${input.taskScopeId}:${input.viewId}`;
  const generation = randomUUID();
  if (starts.size >= 128) starts.delete(starts.keys().next().value!);
  starts.set(targetKey, generation);
  for (const entry of [...sessions.values()]) {
    if (entry.expiresAt <= Date.now() || entry.guest.isDestroyed() || entry.ownerId === ownerId && entry.session.viewId === input.viewId) await remove(entry);
  }
  if (starts.get(targetKey) !== generation) return failure("annotation_start_superseded");
  if (sessions.size >= 64) return failure("annotation_session_capacity");
  const guest = nativeBrowserGuest(ownerId, input.taskScopeId, input.viewId);
  const doc = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  if (!guest || !doc || doc.state !== "ready") return failure("annotation_guest_unavailable");
  const session: BrowserAnnotationSession = { taskScopeId: input.taskScopeId, viewId: input.viewId, sessionId: randomUUID(), navigationEpoch: doc.navigationEpoch, sourceUrl: doc.url };
  const entry: Entry = { ownerId, guest, session, expiresAt: Date.now() + TTL, sequence: -1, selection: null, receipt: null };
  sessions.set(session.sessionId, entry);
  try {
    await execute(guest, annotationInstallScript.replace("__ANNOTATION_SESSION_ID__", session.sessionId));
    if (!current(entry)) { await remove(entry); return failure("annotation_navigation_changed"); }
    return { ok: true, session };
  } catch { await remove(entry); return failure("annotation_picker_unavailable"); }
}
export async function stopBrowserAnnotation(ownerId: number, input: BrowserAnnotationTarget & { sessionId: string }): Promise<BrowserAnnotationResult> {
  const entry = find(ownerId, input);
  if (entry) { starts.delete(`${ownerId}:${input.taskScopeId}:${input.viewId}`); await remove(entry); }
  return { ok: true };
}
export async function browserAnnotationSelection(ownerId: number, input: BrowserAnnotationTarget & { sessionId: string }): ReturnType<BrowserAnnotationAPI["selection"]> {
  const entry = find(ownerId, input);
  if (!entry) return failure("annotation_session_unavailable");
  if (!current(entry)) { await remove(entry); return failure("annotation_navigation_changed"); }
  try {
    const raw = await execute(entry.guest, annotationReadScript(entry.session.sessionId)) as { error?: unknown; sequence?: unknown; element?: unknown };
    if (!current(entry)) { await remove(entry); return failure("annotation_navigation_changed"); }
    if (typeof raw?.error === "string") return failure(/^annotation_[a-z_]+$/.test(raw.error) ? raw.error : "annotation_invalid_selection");
    if (raw?.element == null) return { ok: true, selection: null };
    if (!Number.isSafeInteger(raw.sequence) || !validElement(raw.element)) return failure("annotation_invalid_selection");
    if (entry.sequence !== raw.sequence) {
      entry.sequence = raw.sequence as number;
      entry.selection = { ...entry.session, selectionId: randomUUID(), selectedAt: new Date().toISOString(), viewportScale: entry.guest.getZoomFactor(), evidence: "untrusted-page-reference", element: raw.element };
    }
    if (entry.selection) entry.selection = { ...entry.selection, element: raw.element, viewportScale: entry.guest.getZoomFactor() };
    return { ok: true, selection: entry.selection };
  } catch { return failure("annotation_picker_unavailable"); }
}
export async function commentBrowserAnnotation(ownerId: number, input: Parameters<BrowserAnnotationAPI["comment"]>[0]): ReturnType<BrowserAnnotationAPI["comment"]> {
  if (typeof input?.comment !== "string" || !input.comment.trim() || input.comment.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.comment)) return failure("annotation_invalid_comment");
  const entry = find(ownerId, input);
  if (!entry) return failure("annotation_session_unavailable");
  if (!current(entry)) return failure("annotation_navigation_changed");
  if (entry.receipt) return entry.receipt.userComment === input.comment.trim() && entry.receipt.selection.selectionId === input.selectionId
    ? { ok: true, receipt: entry.receipt } : failure("annotation_comment_conflict");
  const selected = await browserAnnotationSelection(ownerId, input);
  if (!selected.ok) return selected;
  if (!selected.selection || selected.selection.selectionId !== input.selectionId) return failure("annotation_selection_changed");
  if (!current(entry)) return failure("annotation_navigation_changed");
  const concurrentlyCaptured = sessions.get(input.sessionId)?.receipt;
  if (concurrentlyCaptured) return concurrentlyCaptured.userComment === input.comment.trim() && concurrentlyCaptured.selection.selectionId === input.selectionId
    ? { ok: true, receipt: concurrentlyCaptured } : failure("annotation_comment_conflict");
  const receipt: BrowserAnnotationReceipt = { schema: BROWSER_ANNOTATION_SCHEMA, annotationId: randomUUID(), status: "captured", capturedAt: new Date().toISOString(), userComment: input.comment.trim(), selection: selected.selection };
  entry.receipt = receipt;
  return { ok: true, receipt };
}
