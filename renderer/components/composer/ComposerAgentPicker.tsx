"use client";
// The "@" list of a composer that has no agent menu of its own (a room's split pane, the personal agent's window). Every rule - what a half-typed `@` is, what picking
// does to the words, which agent ids the turn carries - is lib/composer-agent-pick.ts; this file only lists the candidates and calls it.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { OrchestrationTarget } from "@shared/types";
import { AGENT_PICK_ATTRS, mentionAtCaret, pickAgent } from "@/lib/composer-agent-pick";
import { visibleAgents } from "@/lib/agent-visibility";
import { ipc } from "@/lib/ipc";
import { pickLocalized, tFor } from "@/lib/i18n";
import type { InstalledAgent } from "@/lib/types";

const MAX_ROWS = 8;

export interface ComposerAgentPicker {
  /** The open list (null while no `@` is being typed). Put it right above the input. */
  node: ReactNode;
  /** Call first in the input's onKeyDown: true when the list took the key (arrows, Enter, Tab, Escape), so the input must not send. */
  handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The agents picked for THIS turn, as the run's agent list (what Main reads before any `@name` in the words). */
  targets: () => OrchestrationTarget[];
  /** Forget the picks (after a send). */
  reset: () => void;
}

export function useComposerAgentPicker({ text, setText, inputRef, locale }: {
  text: string;
  setText: (next: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  locale: "ko" | "en";
}): ComposerAgentPicker {
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // The installed agents are read once per composer, only when the person first types an `@`.
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    const api = ipc();
    let live = true;
    void Promise.resolve(api?.team?.list?.()).then((list) => { if (live && Array.isArray(list)) setAgents(visibleAgents(list as InstalledAgent[])); }).catch(() => undefined);
    return () => { live = false; };
  }, [wanted]);

  const caret = inputRef.current?.selectionStart ?? text.length;
  const token = mentionAtCaret(text, caret);
  useEffect(() => { if (token && !wanted) setWanted(true); }, [token, wanted]);
  const query = token?.query.trim().toLowerCase() ?? "";
  const rows = useMemo(() => {
    if (!token) return [];
    const named = agents.map((agent) => ({ id: agent.id, name: pickLocalized(agent, locale).name, tagline: pickLocalized(agent, locale).tagline, slug: agent.slug ?? "" }));
    // Two agents with the same display name (an imported variant of another) are told apart by their own short name, never by order.
    const count = new Map<string, number>();
    for (const row of named) count.set(row.name, (count.get(row.name) ?? 0) + 1);
    return named
      .filter((row) => row.name && (!query || row.name.toLowerCase().includes(query)))
      .map((row) => ({ ...row, same: (count.get(row.name) ?? 0) > 1 && row.slug ? row.slug : "" }))
      .slice(0, MAX_ROWS);
  }, [agents, locale, query, token]);
  const open = Boolean(token) && dismissedFor !== text.slice(0, token?.end ?? 0);

  const choose = useCallback((row: { id: string; name: string }) => {
    const at = mentionAtCaret(text, inputRef.current?.selectionStart ?? text.length);
    const result = pickAgent(text, picked, row, { at, mode: "add" });
    setPicked(result.picked);
    setText(result.text);
    setActive(0);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(result.caret, result.caret);
    });
  }, [inputRef, picked, setText, text]);

  const handleKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { setDismissedFor(text.slice(0, token?.end ?? 0)); return true; }
    if (!rows.length) return false;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => (value + 1) % rows.length); return true; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => (value + rows.length - 1) % rows.length); return true; }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(rows[Math.min(active, rows.length - 1)]); return true; }
    return false;
  }, [active, choose, open, rows, text, token]);

  const targets = useCallback((): OrchestrationTarget[] => {
    // A pick still counts only while its `@name` is in the words: the person may have deleted the name again.
    return picked.flatMap((id) => {
      const agent = agents.find((item) => item.id === id);
      if (!agent || (agent.kind ?? "agent") === "team") return [];
      const name = pickLocalized(agent, locale).name;
      return name && text.includes(`@${name}`) ? [{ source: "local", entityKind: "agent", agentId: id } as OrchestrationTarget] : [];
    });
  }, [agents, locale, picked, text]);
  const reset = useCallback(() => setPicked([]), []);

  const node = open ? (
    <div {...AGENT_PICK_ATTRS} role="listbox" aria-label={tFor(locale, "composer.agentPick.label")}
      style={{ display: "flex", flexDirection: "column", gap: 2, padding: 4, margin: "0 0 6px", border: "1px solid var(--border, rgba(127,127,127,.3))", borderRadius: 10, background: "var(--surface, transparent)", maxHeight: 220, overflowY: "auto" }}>
      {rows.length === 0
        ? <p style={{ margin: 0, padding: "6px 8px", opacity: 0.7, fontSize: 12 }}>{tFor(locale, "composer.agentPick.empty")}</p>
        : rows.map((row, index) => (
          <button key={row.id} type="button" role="option" aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(row)}
            style={{ textAlign: "left", padding: "6px 8px", borderRadius: 8, border: 0, background: index === active ? "rgba(127,127,127,.16)" : "transparent", color: "inherit", cursor: "pointer" }}>
            <strong style={{ fontSize: 13 }}>@{row.name}</strong>
            {row.same ? <span data-agent-pick-same-name="true" style={{ display: "block", fontSize: 11, opacity: 0.8 }}>{row.same}</span> : null}
            {row.tagline ? <span style={{ display: "block", fontSize: 11, opacity: 0.65 }}>{row.tagline}</span> : null}
          </button>
        ))}
    </div>
  ) : null;
  return { node, handleKey, targets, reset };
}
