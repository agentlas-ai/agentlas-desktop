import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MobileBridgeOntologyProjectionDto } from "../../shared/mobile-bridge";
import type { MobileBridgeTasteRuntimeOverlayDto } from "../../shared/mobile-bridge";
import type { InstalledAgentHubBinding } from "./hub-bindings";
import type { OntologyHubProjectionResult } from "../mobile-bridge/ontology-hub-client";
import { tasteRuntimeTokenEvidenceIsValid } from "./taste-runtime-contract";
import { getDb } from "../store/db";

export const TERMINAL_ONTOLOGY_LOADOUT_CONTRACT =
  "agentlas.desktop-terminal.ontology-loadout.v2" as const;
export const TERMINAL_ONTOLOGY_LOADOUT_VALIDITY_MS = 5 * 60 * 1_000;

const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const REVISION_RE = /^rev_[a-f0-9]{32}$/;
const AUTHORITY_INSTANCE_RE = /^lai_[a-f0-9]{48}$/;
const RECEIPT_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const AUTHORITY_INSTANCE_META_KEY = "terminal_loadout_authority_instance_v2";
const AUTHORITY_SEQUENCE_META_KEY = "terminal_loadout_authority_sequence_v2";

export type TerminalOntologyLoadoutChipReceipt = {
  chipId: string;
  releaseId: string;
  kind: "operational";
} | {
  chipId: string;
  releaseId: string;
  kind: "taste";
  runtimeOverlay: MobileBridgeTasteRuntimeOverlayDto;
};

export interface TerminalOntologyLoadoutEntryReceipt {
  /** One-way local binding proof. The raw installed-agent id never leaves the DB. */
  installedAgentFingerprint: string;
  agentDefinitionId: string;
  baseAgentReleaseId: string;
  projectionRevision: string;
  loadoutRevision: string;
  selectionAuthority: "hub-approved-current-loadout";
  chips: TerminalOntologyLoadoutChipReceipt[];
}

export interface TerminalOntologyLoadoutFeedReceipt {
  schemaVersion: 2;
  contract: typeof TERMINAL_ONTOLOGY_LOADOUT_CONTRACT;
  producer: "agentlas-desktop";
  /** Local Desktop installation authority, not a Hub/server signature. */
  authorityInstanceId: string;
  authoritySequence: number;
  status: "live" | "partial" | "unavailable";
  generatedAt: string;
  expiresAt: string;
  entries: TerminalOntologyLoadoutEntryReceipt[];
  /** Corruption/tamper evidence. Authority comes from the canonical path + DB state. */
  receiptHash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key.normalize("NFC"))}:${canonical(child)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  return JSON.stringify(value);
}

function feedReceiptHash(value: Omit<TerminalOntologyLoadoutFeedReceipt, "receiptHash">): string {
  return `sha256:${createHash("sha256")
    .update("agentlas-desktop-terminal-loadout-v2\0", "utf8")
    .update(canonical(value), "utf8")
    .digest("hex")}`;
}

function nextLocalAuthorityState(): { authorityInstanceId: string; authoritySequence: number } {
  const db = getDb();
  return db.transaction(() => {
    let authorityInstanceId = (db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(AUTHORITY_INSTANCE_META_KEY) as { value?: string } | undefined)?.value ?? null;
    if (authorityInstanceId === null) {
      authorityInstanceId = `lai_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 48)}`;
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(AUTHORITY_INSTANCE_META_KEY, authorityInstanceId);
    } else if (!AUTHORITY_INSTANCE_RE.test(authorityInstanceId)) {
      throw new Error("Terminal loadout local authority identity is invalid.");
    }
    const sequenceRaw = (db.prepare("SELECT value FROM meta WHERE key = ?")
      .get(AUTHORITY_SEQUENCE_META_KEY) as { value?: string } | undefined)?.value ?? null;
    const previous = sequenceRaw === null ? 0 : Number(sequenceRaw);
    if (!Number.isSafeInteger(previous) || previous < 0) {
      throw new Error("Terminal loadout local authority sequence is invalid.");
    }
    const authoritySequence = previous + 1;
    if (!Number.isSafeInteger(authoritySequence)) throw new Error("Terminal loadout local authority sequence is exhausted.");
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(AUTHORITY_SEQUENCE_META_KEY, String(authoritySequence));
    return { authorityInstanceId, authoritySequence };
  })();
}

function safeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF_RE.test(value) && !value.includes("..");
}

function safeRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION_RE.test(value);
}

export function installedAgentFingerprint(installedAgentId: string): string {
  return `sha256:${createHash("sha256")
    .update("agentlas-installed-agent\0", "utf8")
    .update(installedAgentId, "utf8")
    .digest("hex")}`;
}

export function terminalOntologyLoadoutFeedPath(userDataPath: string): string {
  return path.join(userDataPath, "terminal-bridge", "ontology-loadout-v2.json");
}

function projectionKey(value: { agentDefinitionId: string; agentReleaseId: string }): string {
  return `${value.agentDefinitionId}\0${value.agentReleaseId}`;
}

function projectionEntry(
  binding: InstalledAgentHubBinding,
  projection: MobileBridgeOntologyProjectionDto | undefined,
  nowMs: number,
): TerminalOntologyLoadoutEntryReceipt | null {
  if (
    !projection ||
    projection.state !== "live" ||
    projection.loadout.state !== "ready" ||
    !safeRef(binding.installedAgentId) ||
    !safeRef(binding.agentDefinitionId) ||
    !safeRef(binding.agentReleaseId) ||
    projection.agentDefinitionId !== binding.agentDefinitionId ||
    projection.agentReleaseId !== binding.agentReleaseId ||
    !safeRevision(projection.revision) ||
    !safeRevision(projection.loadout.revision)
  ) {
    return null;
  }
  const generatedAtMs = Date.parse(projection.generatedAt);
  if (
    !projection.generatedAt.endsWith("Z") ||
    !Number.isFinite(generatedAtMs) ||
    generatedAtMs > nowMs + 30_000 ||
    nowMs - generatedAtMs > TERMINAL_ONTOLOGY_LOADOUT_VALIDITY_MS
  ) {
    return null;
  }

  const operationalCatalog = new Set(projection.operationalChips
    .filter((chip) => chip.verification === "verified")
    .map((chip) => `${chip.chipId}\0${chip.releaseId}`));
  const tasteCatalog = new Map(projection.tasteChips
    .filter((chip) => chip.verification === "verified")
    .map((chip) => [`${chip.chipId}\0${chip.releaseId}`, chip] as const));
  const selected = projection.loadout.entries;
  if (selected.length === 0 || selected.length > 2) return null;
  const chips: TerminalOntologyLoadoutChipReceipt[] = [];
  const kinds = new Set<string>();
  for (const item of selected) {
    if (
      (item.state !== "attached" && item.state !== "update-available") ||
      !safeRef(item.chipId) ||
      !safeRef(item.releaseId) || kinds.has(item.kind)
    ) {
      return null;
    }
    kinds.add(item.kind);
    // availableReleaseId is deliberately omitted. Terminal may execute only
    // the exact release already selected in the current Hub loadout.
    if (item.kind === "operational") {
      if (!operationalCatalog.has(`${item.chipId}\0${item.releaseId}`)) continue;
      chips.push({ chipId: item.chipId, releaseId: item.releaseId, kind: "operational" });
      continue;
    }
    const catalog = tasteCatalog.get(`${item.chipId}\0${item.releaseId}`);
    const overlay = catalog?.runtimeOverlay;
    if (
      !overlay ||
      overlay.chipId !== item.chipId ||
      overlay.releaseId !== item.releaseId ||
      overlay.baseAgentDefinitionId !== binding.agentDefinitionId ||
      overlay.baseAgentReleaseId !== binding.agentReleaseId ||
      !tasteRuntimeTokenEvidenceIsValid(overlay)
    ) {
      // A malformed/older Taste payload does not cancel a valid independent
      // Operational chip. It simply cannot become executable prompt material.
      continue;
    }
    chips.push({ chipId: item.chipId, releaseId: item.releaseId, kind: "taste", runtimeOverlay: overlay });
  }
  if (chips.length === 0) return null;

  return {
    installedAgentFingerprint: installedAgentFingerprint(binding.installedAgentId),
    agentDefinitionId: binding.agentDefinitionId,
    baseAgentReleaseId: binding.agentReleaseId,
    projectionRevision: projection.revision,
    loadoutRevision: projection.loadout.revision,
    selectionAuthority: "hub-approved-current-loadout",
    chips,
  };
}

function writePrivateAtomic(file: string, value: unknown): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Terminal loadout receipt parent must be a private local directory.");
  }
  try { fs.chmodSync(parent, 0o700); } catch {}
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    try {
      const directory = fs.openSync(parent, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {}
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

/**
 * Writes a private Desktop -> independent Terminal projection.
 *
 * Only a currently-live, exact Hub projection can create an executable entry.
 * Recommendations, pending approvals, next-session schedules, display text,
 * previews, votes, rater identities, paths, raw prompts, memory, credentials,
 * and MCP process data are never serialized. Taste contains only the bounded,
 * server-derived generalized runtime overlay for the exact attached release.
 * A known offline/stale result atomically replaces
 * the prior live receipt with an unavailable receipt so Terminal cannot keep
 * using it.
 */
export function writeTerminalOntologyLoadoutFeed(input: {
  file: string;
  bindings: readonly InstalledAgentHubBinding[];
  result: OntologyHubProjectionResult;
  now?: Date;
}): TerminalOntologyLoadoutFeedReceipt {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Terminal loadout receipt time is invalid.");
  const projections = new Map(
    input.result.supported && (input.result.status === "live" || input.result.status === "stale")
      ? input.result.projections.map((projection) => [projectionKey(projection), projection] as const)
      : [],
  );
  const entries = input.bindings.flatMap((binding) => {
    const entry = projectionEntry(binding, projections.get(projectionKey(binding)), nowMs);
    return entry ? [entry] : [];
  });
  const expected = new Set(input.bindings.map((binding) => installedAgentFingerprint(binding.installedAgentId)));
  const unique = new Set(entries.map((entry) => entry.installedAgentFingerprint));
  if (unique.size !== entries.length || entries.some((entry) => !expected.has(entry.installedAgentFingerprint))) {
    throw new Error("Terminal loadout receipt contains an ambiguous local agent binding.");
  }
  const status: TerminalOntologyLoadoutFeedReceipt["status"] = entries.length === 0
    ? "unavailable"
    : entries.length === input.bindings.length && input.result.status === "live"
      ? "live"
      : "partial";
  const authority = nextLocalAuthorityState();
  const draft: Omit<TerminalOntologyLoadoutFeedReceipt, "receiptHash"> = {
    schemaVersion: 2,
    contract: TERMINAL_ONTOLOGY_LOADOUT_CONTRACT,
    producer: "agentlas-desktop",
    ...authority,
    status,
    generatedAt: now.toISOString(),
    expiresAt: new Date(nowMs + TERMINAL_ONTOLOGY_LOADOUT_VALIDITY_MS).toISOString(),
    entries,
  };
  const receipt: TerminalOntologyLoadoutFeedReceipt = {
    ...draft,
    receiptHash: feedReceiptHash(draft),
  };
  if (!RECEIPT_HASH_RE.test(receipt.receiptHash)) throw new Error("Terminal loadout receipt hash is invalid.");
  writePrivateAtomic(input.file, receipt);
  return receipt;
}

/**
 * One lifecycle owner per running Desktop bridge. Disposing the old owner
 * before a network rebind prevents a slower query from the retired bridge from
 * overwriting a newer receipt.
 */
export class TerminalOntologyLoadoutFeedWriter {
  private active = true;

  constructor(readonly file: string) {
    // Close any prior-process freshness window before the first authenticated
    // query of this Desktop lifecycle finishes.
    this.invalidate();
  }

  write(input: {
    bindings: readonly InstalledAgentHubBinding[];
    result: OntologyHubProjectionResult;
    now?: Date;
  }): TerminalOntologyLoadoutFeedReceipt | null {
    if (!this.active) return null;
    return writeTerminalOntologyLoadoutFeed({ file: this.file, ...input });
  }

  dispose(): void {
    if (!this.active) return;
    this.invalidate();
    this.active = false;
  }

  private invalidate(): void {
    try {
      writeTerminalOntologyLoadoutFeed({
        file: this.file,
        bindings: [],
        result: { supported: false, status: "endpoint-absent", projections: [] },
      });
    } catch {}
  }
}
