import path from "node:path";
import type { ScienceDocumentPanelState, ScienceExportFormat, ScienceExportOpenResult } from "../../shared/science-document-panel";

/*
 * Science's Document panel (state side). The panel itself is the Work Document rail component, hosted by the Science
 * screen next to the Science view; it lists the live-document sessions of the Science runtime chat of the conversation
 * the Science view is showing, which is the chat the AI's document_* tools open sessions in
 * (science-host/document-tools.ts), so the AI's edits and the owner's edits share one journal.
 *
 * This module knows two things Science does not tell the host in a form it could trust:
 *   - which conversation the view shows (from the approvals watch the view already sends, daemon-ipc.ts), and
 *   - where a manuscript export was saved (the view downloads a Blob; Main sees the finished download).
 * The renderer never names a path: an export is offered under an opaque token, and only Main turns it into a session.
 *
 * No electron import (the Main wiring is science-host/document-panel-main.ts), so a plain Node gate runs all of it.
 */

export type { ScienceDocumentPanelState, ScienceExportFormat, ScienceExportOpenResult };

export interface ScienceDocumentPanelPorts {
  /** The conversation's title, or null when this project has no such conversation. */
  conversationTitle(projectId: string, conversationId: string): string | null;
  /** The Science runtime chat id of a conversation (store/chats.ts stableScienceRuntimeChatId). */
  chatIdFor(conversationId: string): string;
  /** live-document store openLiveDocument; throws an error carrying `reason` when the file cannot be opened. */
  openDocument(input: { chatId: string; path: string }): Promise<{ sessionId: string }>;
  /** Delivers a changed state to the owner window `ownerId`. */
  publish(ownerId: number, state: ScienceDocumentPanelState): void;
  now(): number;
  token(): string;
}

/** The part of Electron's DownloadItem this uses. */
export interface ScienceDownloadItemLike {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
}

interface Offer {
  token: string;
  conversationId: string;
  chatId: string;
  path: string;
  name: string;
  format: ScienceExportFormat;
  at: number;
}

interface OwnerState {
  context: { projectId: string; conversationId: string; chatId: string; title: string } | null;
  offers: Offer[];
  published: string;
}

const OFFER_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_OFFERS = 8;
const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

function formatOf(file: string): ScienceExportFormat | null {
  const extension = path.extname(file).toLowerCase();
  return extension === ".docx" ? "docx" : extension === ".hwpx" ? "hwpx" : null;
}

export class ScienceDocumentPanel {
  private readonly owners = new Map<number, OwnerState>();

  constructor(private readonly ports: ScienceDocumentPanelPorts) {}

  private owner(ownerId: number): OwnerState {
    let state = this.owners.get(ownerId);
    if (!state) { state = { context: null, offers: [], published: "" }; this.owners.set(ownerId, state); }
    return state;
  }

  private live(state: OwnerState): Offer[] {
    const cutoff = this.ports.now() - OFFER_TTL_MS;
    state.offers = state.offers.filter(offer => offer.at >= cutoff);
    return state.offers;
  }

  /** What the owner window shows: this conversation's offers only. */
  state(ownerId: number): ScienceDocumentPanelState {
    const state = this.owner(ownerId);
    const context = state.context;
    return {
      context: context ? { conversationId: context.conversationId, chatId: context.chatId, title: context.title } : null,
      offers: context ? this.live(state).filter(offer => offer.conversationId === context.conversationId)
        .map(({ token, name, format }) => ({ token, name, format })) : [],
    };
  }

  private publish(ownerId: number): void {
    const state = this.owner(ownerId);
    const next = this.state(ownerId);
    const serialized = JSON.stringify(next);
    if (serialized === state.published) return;
    state.published = serialized;
    this.ports.publish(ownerId, next);
  }

  /** The Science view of `ownerId` now shows this conversation (or one that does not exist: then none). */
  watchConversation(ownerId: number, scope: { projectId: string; conversationId: string }): void {
    if (!ID_RE.test(scope.projectId) || !ID_RE.test(scope.conversationId)) return;
    const state = this.owner(ownerId);
    const title = this.ports.conversationTitle(scope.projectId, scope.conversationId);
    let chatId: string | null = null;
    // A conversation id that is not a Science conversation id has no runtime chat: no context rather than a throw.
    try { chatId = title === null ? null : this.ports.chatIdFor(scope.conversationId); } catch { chatId = null; }
    state.context = title === null || chatId === null ? null : {
      projectId: scope.projectId, conversationId: scope.conversationId, chatId, title,
    };
    this.publish(ownerId);
  }

  /** The owner window closed its Science view: nothing is shown and no export stays offered. */
  releaseOwner(ownerId: number): void {
    const state = this.owners.get(ownerId);
    if (!state) return;
    state.context = null;
    state.offers = [];
    this.publish(ownerId);
    this.owners.delete(ownerId);
  }

  /**
   * A download the Science view started. The save dialog is unchanged; once the file is finished, a docx or hwpx
   * becomes an offer bound to the conversation shown when the download began (the manuscript's own conversation).
   */
  captureDownload(ownerId: number, item: ScienceDownloadItemLike): void {
    const state = this.owner(ownerId);
    const context = state.context;
    if (!context) return;
    item.once("done", (_event, result) => {
      if (result !== "completed") return;
      const savePath = item.getSavePath();
      const format = formatOf(savePath);
      if (!format || !path.isAbsolute(savePath)) return;
      const live = this.live(state);
      // The same file exported again replaces its earlier offer.
      state.offers = live.filter(offer => !(offer.chatId === context.chatId && offer.path === savePath));
      state.offers.push({ token: this.ports.token(), conversationId: context.conversationId, chatId: context.chatId,
        path: savePath, name: path.basename(savePath), format, at: this.ports.now() });
      if (state.offers.length > MAX_OFFERS) state.offers.splice(0, state.offers.length - MAX_OFFERS);
      if (this.owners.get(ownerId) === state) this.publish(ownerId);
    });
  }

  /** The owner chose "open in the Document tab" for an offered export: a session of that conversation's chat. */
  async openExport(ownerId: number, token: unknown): Promise<ScienceExportOpenResult> {
    const state = this.owners.get(ownerId);
    if (!state || typeof token !== "string") return { ok: false, reason: "export_unknown" };
    const offer = this.live(state).find(candidate => candidate.token === token);
    if (!offer) return { ok: false, reason: "export_unknown" };
    try {
      const meta = await this.ports.openDocument({ chatId: offer.chatId, path: offer.path });
      state.offers = state.offers.filter(candidate => candidate !== offer);
      this.publish(ownerId);
      return { ok: true, sessionId: meta.sessionId, chatId: offer.chatId };
    } catch (error) {
      const reason = (error as { reason?: unknown })?.reason;
      return { ok: false, reason: typeof reason === "string" ? reason : "file_unreadable" };
    }
  }

  dismissExport(ownerId: number, token: unknown): void {
    const state = this.owners.get(ownerId);
    if (!state || typeof token !== "string") return;
    state.offers = state.offers.filter(offer => offer.token !== token);
    this.publish(ownerId);
  }
}
