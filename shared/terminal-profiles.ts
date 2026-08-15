// Terminal profile sanitizer — the one place that decides what a saved profile
// looks like (PRD 2026-08-15 B-1). Pure so main (IPC) and contract tests share it.
import type { TerminalProfile } from "./types";

export function sanitizeTerminalProfiles(input: unknown): TerminalProfile[] {
  const list = Array.isArray(input) ? input : [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p): TerminalProfile => {
      const mode: "template" | "acp" = p.mode === "acp" ? "acp" : "template";
      const acpRaw = p.acp && typeof p.acp === "object" ? (p.acp as Record<string, unknown>) : null;
      const acp = mode === "acp"
        ? {
            command: String(acpRaw?.command ?? "").trim().slice(0, 500),
            args: Array.isArray(acpRaw?.args) ? (acpRaw!.args as unknown[]).map((a) => String(a).slice(0, 200)).slice(0, 32) : [],
          }
        : undefined;
      return {
        id: String(p.id ?? ""),
        name: String(p.name ?? "").slice(0, 80),
        template: String(p.template ?? "").slice(0, 2000),
        enabled: p.enabled !== false,
        mode,
        ...(acp ? { acp } : {}),
      };
    })
    // template mode needs the {{{prompt}}} slot (else the message has nowhere to go);
    // acp mode needs a command (else there is nothing to spawn).
    .filter((p) => p.id && p.name && (p.mode === "acp" ? Boolean(p.acp?.command) : p.template.includes("{{{prompt}}}")));
}
