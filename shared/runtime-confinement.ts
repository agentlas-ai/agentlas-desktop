import type { RuntimeKind } from "./types";

/**
 * who keeps a "write inside the working folder" run inside that folder.
 *  - "host":    the Agentlas host gate (hook / arbiter / in-process tool dispatch) enforces it, whatever the CLI does.
 * - "runtime": the CLI's own sandbox / permission mode enforces it (measured; see the evidence column).
 * - "none": nothing enforces it. The run is allowed (decision pending, sheet question 1: option A) but the
 *               chip and the card must say so as a typed value, never reuse the plain "write" label silently.
 * A pure table: no I/O, no model, importable from Main, the daemon and the renderer.
 */
export type RuntimeConfinement = "host" | "runtime" | "none";

interface ConfinementRow {
  readonly default: RuntimeConfinement;
  /** Platform overrides (process.platform values). */
  readonly byPlatform?: Readonly<Partial<Record<string, RuntimeConfinement>>>;
  readonly evidence: string;
}

const TABLE: Readonly<Record<RuntimeKind, ConfinementRow>> = {
  "claude-code": { default: "runtime", evidence: "--permission-mode acceptEdits (invocation/service.ts)" },
  codex: { default: "runtime", evidence: "--sandbox workspace-write" },
  antigravity: {
    default: "host",
    byPlatform: { win32: "none" },
    evidence: "agy-write-boundary PreToolUse hook (antigravity-delete-gate.ts); the plugin is not installed on win32 (agy runs hooks through cmd.exe, unverified)",
  },
  grok: { default: "runtime", evidence: "--permission-mode acceptEdits" },
  kimi: { default: "none", evidence: "kimi.ts passes no permission flag (permission-not-enforceable)" },
  cursor: { default: "none", evidence: "cursor.ts: --force applies writes anywhere the process can reach" },
  acp: { default: "host", evidence: "ACP session/request_permission is arbitrated by the host (runtime/acp.ts)" },
  byok: { default: "host", evidence: "in-process tool dispatch passes the Main gate" },
  ollama: { default: "host", evidence: "local tool loop dispatches through the Main gate" },
  lmstudio: { default: "host", evidence: "local tool loop dispatches through the Main gate" },
  mlx: { default: "host", evidence: "local tool loop dispatches through the Main gate" },
  "agentlas-local": { default: "host", evidence: "local tool loop dispatches through the Main gate" },
  agentlas: { default: "host", evidence: "serving: tools run in-process behind the Main gate" },
};

export function writeConfinement(kind: RuntimeKind, platform: string = process.platform): RuntimeConfinement {
  const row = TABLE[kind];
  if (!row) return "none";
  return row.byPlatform?.[platform] ?? row.default;
}

/** Plain words for the chip and the card when a write run cannot be kept inside its folder. Null when something enforces it. */
export function confinementChipText(confinement: RuntimeConfinement, locale: "ko" | "en"): string | null {
  if (confinement !== "none") return null;
  return locale === "ko"
    ? "이 AI는 작업 폴더 밖 쓰기를 막을 수 없어요"
    : "This AI cannot be stopped from writing outside the working folder";
}

/** The process.platform value a renderer infers from navigator.platform (no `process` there). Unknown reads as darwin, the table's default row for every runtime. */
export function platformOfNavigator(navigatorPlatform: string | null | undefined): string {
  const text = navigatorPlatform || "";
  return /Win/i.test(text) ? "win32" : /Mac/i.test(text) ? "darwin" : /Linux|X11/i.test(text) ? "linux" : "darwin";
}

/** The short line at selection (chip menu and composer, before any send) for a write run on an AI this OS cannot keep inside its folder; the full sentence is the notice after the send. Null for read/full and for a confined AI. */
export function unconfinedWriteWarning(runtime: { kind?: RuntimeKind | string | null; acpAgentId?: string | null } | null | undefined, permission: "read" | "write" | "full" | undefined, platform: string, locale: "ko" | "en"): string | null {
  if (permission !== "write" || !runtime?.kind) return null;
  // Kimi and Cursor run over ACP: their row says kind "acp" with the agent id, and it is the agent that decides (acp.ts spec.id, the same rule the runner's notice uses).
  const kind = runtime.kind === "acp" && (runtime.acpAgentId === "kimi" || runtime.acpAgentId === "cursor") ? runtime.acpAgentId : runtime.kind;
  return confinementChipText(writeConfinement(kind as RuntimeKind, platform), locale) === null ? null : locale === "ko" ? "폴더 밖 쓰기 못 막음" : "Writes not confined";
}

/** A host notice (same shape as RuntimeEvents.onNotice) a runner emits for a write/full run that nothing confines. */
export function confinementNotice(kind: RuntimeKind, permission: "read" | "write" | "full" | undefined, locale: "ko" | "en" | undefined, platform: string = process.platform) {
  if (permission !== "write") return null;
  const text = confinementChipText(writeConfinement(kind, platform), locale === "ko" ? "ko" : "en");
  if (!text) return null;
  const ko = confinementChipText("none", "ko") as string;
  const en = confinementChipText("none", "en") as string;
  return { level: "warning" as const, code: "write-not-confined", message: text, i18n: { ko, en } };
}
