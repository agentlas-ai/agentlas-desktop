"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyLiveDocumentOps, findLiveTextTarget,
  type LiveDocumentEntry, type LiveDocumentMeta, type LiveDocumentModel, type LiveDocumentOp,
} from "@shared/live-document";
import { ipc } from "./ipc";

/*
 * Plays a live document session: the authoritative state comes from Main (snapshot + deltas); AI entries are
 * replayed op by op with a cursor that selects the target and types the new text, so the person watches the edit
 * happen. The person's own entries apply at once. A long backlog (or a hidden tab) fast-forwards.
 */

export interface LiveCursor {
  /** data-live-id of the element being edited (cells: `<sheetId>!A1`). */
  target: string;
  label: string;
  color: string;
  phase: "select" | "type" | "delete";
}

/** Text currently being typed into a target (shown instead of the model's text). */
export interface LiveTyping { target: string; text: string }

const AI_COLORS = ["#d97757", "#2a78d6", "#7a5bd1", "#2f9e72", "#c2417a"];
const MAX_BACKLOG = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function colorFor(runId: string | undefined): string {
  if (!runId) return AI_COLORS[0];
  let hash = 0;
  for (const ch of runId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AI_COLORS[hash % AI_COLORS.length];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export function cellTarget(model: LiveDocumentModel, sheetRef: string, cell: string): string {
  if (model.kind !== "sheet") return `${sheetRef}!${cell}`;
  const sheet = model.sheets.find((item) => item.id === sheetRef || item.name === sheetRef || item.name.toLowerCase() === sheetRef.toLowerCase());
  return `${sheet?.id ?? sheetRef}!${cell}`;
}

function textOf(model: LiveDocumentModel, target: string): string {
  return findLiveTextTarget(model, target)?.get() ?? "";
}

export function useLiveDocumentSession(sessionId: string | null) {
  const [meta, setMeta] = useState<LiveDocumentMeta | null>(null);
  const [display, setDisplay] = useState<LiveDocumentModel | null>(null);
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<LiveDocumentEntry[]>([]);
  const [cursor, setCursor] = useState<LiveCursor | null>(null);
  const [typing, setTyping] = useState<LiveTyping | null>(null);
  // Each AI focus carries a sequence so the view follows it once, and later model changes never pull the view back.
  const [focus, setFocusState] = useState<{ sheet?: string; slide?: string; seq: number } | null>(null);
  const focusSeq = useRef(0);
  const setFocus = useCallback((next: { sheet?: string; slide?: string }) => setFocusState({ ...next, seq: ++focusSeq.current }), []);
  const [error, setError] = useState<string | null>(null);
  const displayRef = useRef<LiveDocumentModel | null>(null);
  const revisionRef = useRef(0);
  const queue = useRef<LiveDocumentEntry[]>([]);
  const running = useRef<number | null>(null);
  const generation = useRef(0);
  const replayed = useRef(false);
  const playRef = useRef<(() => Promise<void>) | null>(null);

  const commit = useCallback((model: LiveDocumentModel) => { displayRef.current = model; setDisplay(model); }, []);

  // Each activation owns one reader. Events arriving during a read request one trailing pass.
  const refreshRef = useRef<((kind: "load" | "delta" | "changed") => Promise<void>) | null>(null);
  const load = useCallback(async () => { await refreshRef.current?.("load"); }, []);

  const play = useCallback(async () => {
    const gen = generation.current;
    if (running.current === gen) return;
    running.current = gen;
    const alive = () => gen === generation.current;
    try {
      while (queue.current.length && alive()) {
        const entry = queue.current.shift()!;
        const fast = entry.actor.kind !== "ai" || queue.current.length >= MAX_BACKLOG || document.visibilityState === "hidden";
        for (const op of entry.ops) {
          if (!alive()) return;
          const model = displayRef.current;
          if (!model) return;
          const finalOps = fast ? [op] : await animate(op, entry, model, alive);
          if (!alive()) return;
          try { commit(applyLiveDocumentOps(displayRef.current!, finalOps)); } catch { void load(); return; }
          setTyping(null);
        }
        setCursor(null);
        setEntries((current) => [...current, entry].slice(-40));
      }
    } finally {
      if (running.current === gen) running.current = null;
      if (alive()) { setCursor(null); setTyping(null); }
    }

    /** Plays one op and returns what still has to be committed (structure an animation pre-inserted is not re-inserted). */
    async function animate(op: LiveDocumentOp, entry: LiveDocumentEntry, model: LiveDocumentModel, isAlive: () => boolean): Promise<LiveDocumentOp[]> {
      const label = entry.actor.label || "AI";
      const color = colorFor(entry.actor.runId);
      const typeInto = async (target: string, from: string, to: string) => {
        setCursor({ target, label, color, phase: "select" });
        await sleep(220);
        if (!isAlive()) return;
        const keep = commonPrefix(from, to);
        // Erase back to the shared prefix, then type the rest.
        const eraseSteps = Math.min(12, from.length - keep);
        for (let i = 1; i <= eraseSteps && isAlive(); i++) {
          setTyping({ target, text: from.slice(0, from.length - Math.ceil(((from.length - keep) * i) / eraseSteps)) });
          await sleep(18);
        }
        if (!isAlive()) return;
        setCursor({ target, label, color, phase: "type" });
        const rest = to.slice(keep);
        const duration = Math.max(240, Math.min(1800, rest.length * 26));
        const frames = Math.max(1, Math.min(rest.length, Math.round(duration / 24)));
        for (let i = 1; i <= frames && isAlive(); i++) {
          setTyping({ target, text: to.slice(0, keep + Math.round((rest.length * i) / frames)) });
          await sleep(duration / frames);
        }
      };
      if (op.op === "set_text" || op.op === "insert_text") {
        const before = textOf(model, op.target);
        const after = op.op === "set_text" ? op.text : (() => { const at = op.at ?? before.length; return before.slice(0, at) + op.text + before.slice(at); })();
        if (model.kind === "slides") setFocus({ slide: model.slides.find((slide) => slide.shapes.some((shape) => shape.id === op.target))?.id });
        await typeInto(op.target, before, after);
      } else if (op.op === "set_cell") {
        const target = cellTarget(model, op.sheet, op.cell);
        setFocus({ sheet: target.split("!")[0] });
        const sheet = model.kind === "sheet" ? model.sheets.find((item) => item.id === target.split("!")[0]) : undefined;
        const cell = sheet?.cells[op.cell];
        await typeInto(target, cell ? (cell.f !== undefined ? `=${cell.f}` : cell.v) : "", op.value);
      } else if (op.op === "insert_paragraph" && op.id) {
        commit(applyLiveDocumentOps(model, [{ ...op, text: "" }]));
        await sleep(60);
        if (!isAlive()) return [];
        await typeInto(op.id, "", op.text);
        return [{ op: "set_text", target: op.id, text: op.text }];
      } else if (op.op === "add_slide" && op.id) {
        commit(applyLiveDocumentOps(model, [{ ...op, title: "", body: "" }]));
        setFocus({ slide: op.id });
        await sleep(120);
        if (!isAlive()) return [];
        if (op.title) await typeInto(`${op.id}.title`, "", op.title);
        if (!isAlive()) return [];
        if (op.title) commit(applyLiveDocumentOps(displayRef.current!, [{ op: "set_text", target: `${op.id}.title`, text: op.title }]));
        if (op.body) await typeInto(`${op.id}.body`, "", op.body);
        return [{ op: "set_text", target: `${op.id}.body`, text: op.body ?? "" }];
      } else if (op.op === "set_format") {
        const bang = op.target.lastIndexOf("!");
        const target = model.kind === "sheet" && bang > 0 ? cellTarget(model, op.target.slice(0, bang), op.target.slice(bang + 1).toUpperCase()) : op.target;
        if (model.kind === "sheet") setFocus({ sheet: target.split("!")[0] });
        if (model.kind === "slides") setFocus({ slide: model.slides.find((slide) => slide.shapes.some((shape) => shape.id === op.target))?.id });
        setCursor({ target, label, color, phase: "select" });
        await sleep(380);
      } else if (op.op === "delete_block" || op.op === "delete_slide") {
        setCursor({ target: op.target, label, color, phase: "delete" });
        await sleep(420);
      } else if (op.op === "add_sheet") {
        setFocus({ sheet: op.id });
        await sleep(200);
      } else if (op.op === "rename_sheet" || op.op === "add_chart" || op.op === "set_number_format") {
        const ref = op.op === "set_number_format" ? op.target.slice(0, op.target.lastIndexOf("!")) : op.sheet;
        const sheet = model.kind === "sheet" ? model.sheets.find((item) => item.id === ref || item.name.toLowerCase() === ref.toLowerCase()) : undefined;
        if (sheet) setFocus({ sheet: sheet.id });
        await sleep(260);
      } else if (op.op === "set_notes") {
        if (model.kind === "slides") setFocus({ slide: op.target });
        await sleep(260);
      } else if (op.op === "insert_table" && op.after) {
        if (model.kind === "slides") setFocus({ slide: op.after });
        setCursor({ target: op.after, label, color, phase: "type" });
        await sleep(260);
      }
      return [op];
    }
  }, [commit, load]);

  playRef.current = play;

  const pull = useCallback(async () => { await refreshRef.current?.("delta"); }, []);

  useEffect(() => {
    let disposed = false;
    let needsLoad = false;
    let needsDelta = false;
    let needsMeta = false;
    let chatId: string | null = null;
    let pending: Promise<void> | null = null;
    generation.current++;
    queue.current = [];
    replayed.current = false;
    displayRef.current = null;
    revisionRef.current = 0;
    setMeta(null); setDisplay(null); setError(null);
    setEntries([]); setRevision(0); setCursor(null); setTyping(null);

    const refresh = (kind: "load" | "delta" | "changed"): Promise<void> => {
      if (disposed || !sessionId) return Promise.resolve();
      if (kind === "load") needsLoad = true;
      else needsDelta = true;
      if (kind === "changed") needsMeta = true;
      if (!pending) {
        pending = drain().finally(() => { pending = null; });
      }
      return pending;
    };
    async function drain() {
      try {
        while (!disposed && (needsLoad || needsDelta || needsMeta)) {
          if (needsLoad) {
            needsLoad = false; needsDelta = false; needsMeta = false;
            const snapshot = await ipc()?.liveDocument?.snapshot(sessionId!);
            if (disposed) return;
            if (!snapshot) { setError("session_unknown"); continue; }
            generation.current++;
            queue.current = [];
            setCursor(null); setTyping(null); setError(null);
            setMeta(snapshot.meta);
            chatId = snapshot.meta.chatId;
            revisionRef.current = snapshot.revision;
            setRevision(snapshot.revision);
            if (snapshot.replayFrom && !replayed.current) {
              replayed.current = true;
              setEntries([]);
              commit(snapshot.replayFrom);
              queue.current.push(...snapshot.entries);
              void playRef.current?.();
            } else {
              setEntries(snapshot.entries);
              commit(snapshot.model);
            }
            continue;
          }
          if (needsDelta) {
            needsDelta = false;
            const since = revisionRef.current;
            const delta = await ipc()?.liveDocument?.entries(sessionId!, since);
            if (disposed) return;
            if (needsLoad) continue;
            if (delta?.reset) { needsLoad = true; continue; }
            if (delta) {
              setError(null);
              // The watermark includes queued animation, so an entry is accepted only once.
              const fresh = delta.entries.filter((entry) => entry.seq > revisionRef.current);
              revisionRef.current = Math.max(revisionRef.current, delta.revision);
              if (fresh.length) {
                setRevision(revisionRef.current);
                queue.current.push(...fresh);
                void playRef.current?.();
              }
            }
            // A notification received mid-read may describe a later revision than this response.
            if (needsDelta || needsLoad) continue;
          }
          if (needsMeta) {
            needsMeta = false;
            // Reuse the metadata API; cloning the document model is unnecessary for save/name changes.
            const sessions = chatId ? await ipc()?.liveDocument?.list(chatId) : null;
            if (disposed) return;
            const current = sessions?.find((item) => item.sessionId === sessionId);
            if (current) setMeta(current);
          }
        }
      } catch {
        if (!disposed) {
          if (!displayRef.current) needsLoad = true;
          setError("unavailable");
        }
      }
    }
    refreshRef.current = refresh;
    void refresh("load");
    const off = ipc()?.liveDocument?.onChanged((event) => {
      if (event.sessionId === sessionId) {
        chatId = event.chatId;
        void refresh("changed");
      }
    });
    const timer = window.setInterval(() => void refresh("delta"), 2500);
    return () => {
      disposed = true;
      if (refreshRef.current === refresh) refreshRef.current = null;
      off?.(); window.clearInterval(timer); generation.current++;
      queue.current = [];
    };
  }, [sessionId, commit]);

  /** The person's edit: shown at once, then journaled; a refusal reloads the authoritative state. */
  const apply = useCallback(async (ops: LiveDocumentOp[]): Promise<{ ok: boolean; reason?: string; created?: string[] }> => {
    if (!sessionId) return { ok: false, reason: "session_unknown" };
    const refresh = refreshRef.current;
    // Insertions are not idempotent: their journal entry must apply exactly once, after Main accepts it.
    const optimistic = ops.every((op) => op.op === "set_text" || op.op === "set_cell" || op.op === "set_format");
    if (optimistic && displayRef.current) { try { commit(applyLiveDocumentOps(displayRef.current, ops)); } catch { /* reload below */ } }
    const result = await ipc()?.liveDocument?.apply({ sessionId, baseRevision: revisionRef.current, ops });
    if (refreshRef.current !== refresh) return { ok: false, reason: "session_changed" };
    if (!result?.ok) { await load(); return { ok: false, reason: result && !result.ok ? result.reason : "unavailable" }; }
    await pull();
    return { ok: true, created: result.created };
  }, [sessionId, commit, load, pull]);

  return { meta, display, displayRef, revision, entries, cursor, typing, focus, error, apply, reload: load };
}
