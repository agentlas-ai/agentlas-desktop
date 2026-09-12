import { createHash } from "node:crypto";
import { getDb } from "./db";
import type { ArtifactPresentationReceipt, ArtifactPresentationState, ArtifactPresentationWriteResult } from "../../shared/artifact-presentation";

const MAX_BYTES = 262_144;
const FORBIDDEN_KEY = /(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const TYPES = new Set(["text", "search", "email", "tel", "url", "number", "range", "date", "datetime-local", "month", "week", "time", "color", "checkbox", "radio", "textarea", "select-one", "select-multiple"]);
type Target = { appId: string; sourceIdentityDigest: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact_presentation_invalid");
  return value as Record<string, unknown>;
}

function key(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || FORBIDDEN_KEY.test(value)) throw new Error("artifact_presentation_field_refused");
  return value;
}

/** Normalize a closed schema; executable properties and sensitive inputs are rejected. */
export function validateArtifactPresentation(value: unknown): ArtifactPresentationState {
  const row = object(value);
  if (row.schemaVersion !== 1 || !Array.isArray(row.fields) || row.fields.length > 200) throw new Error("artifact_presentation_schema_unsupported");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) throw new Error("artifact_presentation_too_large");
  const keys = new Set<string>();
  const fields = row.fields.map((input): ArtifactPresentationState["fields"][number] => {
    const field = object(input), id = key(field.key);
    if (keys.has(id)) throw new Error("artifact_presentation_duplicate_field");
    keys.add(id);
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(String(field.tag)) || !TYPES.has(String(field.type)) || typeof field.value !== "string" || field.value.length > 32768) throw new Error("artifact_presentation_field_invalid");
    const selection = (value: unknown): number | null => value === null || value === undefined ? null
      : Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= field.value!.toString().length ? Number(value)
        : (() => { throw new Error("artifact_presentation_selection_invalid"); })();
    if (field.checked !== undefined && typeof field.checked !== "boolean") throw new Error("artifact_presentation_checked_invalid");
    return { key: id, tag: field.tag as ArtifactPresentationState["fields"][number]["tag"], type: String(field.type), value: field.value,
      ...(typeof field.checked === "boolean" ? { checked: field.checked } : {}), selectionStart: selection(field.selectionStart), selectionEnd: selection(field.selectionEnd) };
  });
  const scroll = object(row.scroll);
  if (![scroll.x, scroll.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000_000)) throw new Error("artifact_presentation_scroll_invalid");
  const focus = row.focus === null ? null : key(row.focus);
  if (focus !== null && !keys.has(focus)) throw new Error("artifact_presentation_focus_invalid");
  return { schemaVersion: 1, fields, focus, scroll: { x: Number(scroll.x), y: Number(scroll.y) } };
}

function store() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_presentation_state (
    app_id TEXT NOT NULL, source_identity_digest TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY (app_id, source_identity_digest)
  )`);
  return db;
}

export function readArtifactPresentation(target: Target): ArtifactPresentationReceipt | null {
  const row = store().prepare("SELECT receipt_json FROM artifact_presentation_state WHERE app_id = ? AND source_identity_digest = ?")
    .get(target.appId, target.sourceIdentityDigest) as { receipt_json: string } | undefined;
  if (!row) return null;
  const value = JSON.parse(row.receipt_json) as ArtifactPresentationReceipt;
  if (value.schemaVersion !== "agentlas.artifact-presentation.v1") throw new Error("artifact_presentation_receipt_schema_unsupported");
  validateArtifactPresentation(value.state);
  return value;
}

export function writeArtifactPresentation(target: Target, input: { originBundleDigest: string; expectedRevision: number; requestId: string; state: unknown }): ArtifactPresentationWriteResult {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) throw new Error("artifact_presentation_request_invalid");
  const state = validateArtifactPresentation(input.state);
  const stateDigest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  const db = store();
  return db.transaction((): ArtifactPresentationWriteResult => {
    const current = readArtifactPresentation(target);
    if (current?.requestId === input.requestId) {
      if (current.stateDigest !== stateDigest || current.originBundleDigest !== input.originBundleDigest) throw new Error("artifact_presentation_request_reused");
      return { status: "saved", receipt: current };
    }
    if ((current?.revision ?? 0) !== input.expectedRevision) return { status: "conflict", current };
    const receipt: ArtifactPresentationReceipt = { schemaVersion: "agentlas.artifact-presentation.v1", ...target,
      originBundleDigest: input.originBundleDigest, revision: input.expectedRevision + 1, stateDigest, requestId: input.requestId,
      state, updatedAt: new Date().toISOString() };
    db.prepare("INSERT INTO artifact_presentation_state(app_id,source_identity_digest,receipt_json) VALUES (?,?,?) ON CONFLICT(app_id,source_identity_digest) DO UPDATE SET receipt_json=excluded.receipt_json")
      .run(target.appId, target.sourceIdentityDigest, JSON.stringify(receipt));
    return { status: "saved", receipt };
  })();
}
