/**
 * Mobile bridge, Build reads (Agentlas 2.0 redesign backend C, contracts/mobile-bridge-2.0.md section 9): the saved Builds the Desktop already keeps,
 * read by the redesigned phone. Four methods, advertised by the bridge.ready capability `workspaceV2.build: true`:
 *   build2.list   { cursor?, limit?(1..100) }          -> { ok, items:[BuildListItem], next }
 *   build2.open   { buildKey }                          -> { ok, build, messages, messagesTruncated, turnDefaults, continuable, continuableReason }
 *   build2.files  { buildKey }                          -> { ok, nodes, truncated }
 *   build2.file.read { buildKey, path, sinceLine? }     -> { ok, file }
 * PB-D (contracts/phone-build2.md section 3), advertised as `workspaceV2.buildCommands` (the names that are there are the ones a phone may call):
 *   build2.forRun { runId }                             -> { ok, buildKey }                 (read: the saved Build of a run this Desktop started for the phone)
 *   build2.preview.send { buildKey, text, idempotencyKey } -> { ok, reply }                (write: one test turn with the agent being built; never remembered)
 *   build2.preview.restart { buildKey, idempotencyKey } -> { ok }                          (write)
 *   build2.preview.read { buildKey }                    -> { ok, messages:[{role,text,at}], busy } (read)
 * Continuing a Build is not here: it is `build.start { goal, buildKey, seenUpdatedAt }` (shared/mobile-bridge.ts). Not built: rename and delete of a saved Build.
 *
 * Every refusal is `{ ok:false, code }` with a `BuildWorkbenchRefusal` machine code (shared/build-workbench.ts), never a sentence. The folder's path, the
 * folder grant and the runtime of a Build are never sent. No Electron import: the wire parser (shared/mobile-bridge.ts), the authority and the gates load this file.
 */

export const MOBILE_BUILD_V2_METHODS = ["build2.list", "build2.open", "build2.files", "build2.file.read", "build2.forRun", "build2.preview.send", "build2.preview.restart", "build2.preview.read"] as const;
export type MobileBuildV2Method = (typeof MOBILE_BUILD_V2_METHODS)[number];
/** The two of them that change something (the wire demands an idempotency key and the Desktop's ledger keeps the first answer). */
export const MOBILE_BUILD_V2_WRITE_METHODS = ["build2.preview.send", "build2.preview.restart"] as const;
/** `workspaceV2.buildCommands`: the PB-D names (section 6). A phone draws and calls a command only when its name is in the list. */
export const MOBILE_BUILD_V2_COMMANDS = ["continue", "forRun", "preview.send", "preview.restart", "preview.read"] as const;

export const MOBILE_BUILD_V2_LIMITS = {
  listDefault: 30,
  listMax: 100,
  /** A file body the Desktop reads for the phone (the same bound as the Build window's own reader). */
  fileBytesMax: 512 * 1024,
  /** The newest messages of one saved Build that fit one answer; `messagesTruncated` says when older ones were left out. */
  messagesBytesMax: 256 * 1024,
  /** One message's text, characters; longer is cut at the end. */
  messageCharsMax: 60_000,
  lineTextMax: 300,
  pathMax: 260,
  sinceLineMax: 10_000_000,
  /** One Preview message the phone sends, characters: the Build window's own bound (hephaestus/build-preview.ts PREVIEW_MAX_TEXT). */
  previewTextMax: 12_000,
  idempotencyKeyMax: 160,
  runIdMax: 160,
} as const;

const BUILD_KEY_RE = /^[0-9a-f]{24}$/;
/** An ISO time the Desktop wrote (`new Date().toISOString()`): the phone passes back what it was given. */
const SEEN_UPDATED_AT_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
/** The Desktop's own list cursor: the last row's `updatedAt|id`. A phone passes back what it was given. */
const CURSOR_RE = /^[0-9TZ:.+-]{10,40}\|[0-9a-f]{24}$/;

type Args = Record<string, unknown>;
const onlyKeys = (args: Args, keys: readonly string[]): boolean => Object.keys(args).every((key) => keys.includes(key));

/** Closed argument check of one method: a key it does not know is refused. Returns the first problem or null. */
export function validateMobileBuildV2Params(method: string, params: Args): string | null {
  const L = MOBILE_BUILD_V2_LIMITS;
  const key = (): string | null => typeof params.buildKey === "string" && BUILD_KEY_RE.test(params.buildKey) ? null : "buildKey must be a build key this Desktop returned";
  const idempotencyKey = (): string | null => typeof params.idempotencyKey === "string" && params.idempotencyKey.length >= 1 && params.idempotencyKey.length <= L.idempotencyKeyMax ? null : "idempotencyKey is required";
  switch (method) {
    case "build2.list":
      if (!onlyKeys(params, ["cursor", "limit"])) return "build2.list accepts only cursor and limit";
      if (params.cursor !== undefined && !(typeof params.cursor === "string" && CURSOR_RE.test(params.cursor))) return "cursor must be one this Desktop returned";
      if (params.limit !== undefined && !(Number.isInteger(params.limit) && Number(params.limit) >= 1 && Number(params.limit) <= L.listMax)) return `limit must be an integer between 1 and ${L.listMax}`;
      return null;
    case "build2.open":
    case "build2.files":
      return onlyKeys(params, ["buildKey"]) ? key() : `${method} accepts only buildKey`;
    case "build2.file.read":
      if (!onlyKeys(params, ["buildKey", "path", "sinceLine"])) return "build2.file.read accepts only buildKey, path and sinceLine";
      if (key()) return key();
      // Which paths are inside the Build's folder is the Desktop's call (a code, not a thrown sentence); here only the shape.
      if (typeof params.path !== "string" || params.path.length < 1 || params.path.length > L.pathMax) return `path must be 1 to ${L.pathMax} characters`;
      if (params.sinceLine !== undefined && !(Number.isInteger(params.sinceLine) && Number(params.sinceLine) >= 0 && Number(params.sinceLine) <= L.sinceLineMax)) return "sinceLine must be a line number";
      return null;
    case "build2.forRun":
      return onlyKeys(params, ["runId"]) ? (typeof params.runId === "string" && params.runId.length >= 1 && params.runId.length <= L.runIdMax && !/[\u0000-\u001f]/.test(params.runId) ? null : `runId must be 1 to ${L.runIdMax} characters`) : "build2.forRun accepts only runId";
    case "build2.preview.read":
      return onlyKeys(params, ["buildKey"]) ? key() : "build2.preview.read accepts only buildKey";
    case "build2.preview.send":
      if (!onlyKeys(params, ["buildKey", "text", "idempotencyKey"])) return "build2.preview.send accepts only buildKey, text and idempotencyKey";
      if (key()) return key();
      if (typeof params.text !== "string" || params.text.length < 1 || params.text.length > L.previewTextMax) return `text must be 1 to ${L.previewTextMax} characters`;
      return idempotencyKey();
    case "build2.preview.restart":
      if (!onlyKeys(params, ["buildKey", "idempotencyKey"])) return "build2.preview.restart accepts only buildKey and idempotencyKey";
      return key() ?? idempotencyKey();
    default:
      return `${method} is not a build2 method`;
  }
}

/**
 * The optional continuation of `build.start` (contracts/phone-build2.md section 3): `buildKey` and `seenUpdatedAt` come together or not at all.
 * `seenUpdatedAt` is the `updatedAt` the phone read in `build2.open` / `build2.list`; the Desktop refuses (`build_changed`) when the Build moved on since.
 * Returns the first problem, or null.
 */
export function validateMobileBuildContinuation(params: Args): string | null {
  const has = (key: string): boolean => params[key] !== undefined;
  if (!has("buildKey") && !has("seenUpdatedAt")) return null;
  if (!has("buildKey") || !has("seenUpdatedAt")) return "buildKey and seenUpdatedAt go together";
  if (typeof params.buildKey !== "string" || !BUILD_KEY_RE.test(params.buildKey)) return "buildKey must be a build key this Desktop returned";
  if (typeof params.seenUpdatedAt !== "string" || !SEEN_UPDATED_AT_RE.test(params.seenUpdatedAt)) return "seenUpdatedAt must be the updatedAt this Desktop returned";
  return null;
}
