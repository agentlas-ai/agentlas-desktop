/**
 * the ONE place that masks what the owner's own machine knows (absolute local paths) before text leaves the machine.
 *
 * Three views of one record exist: the model's (envelopes, system lines), the owner's desktop view (the real paths: a file an answer names must be
 * findable) and the remote view (the phone, the server). Only the remote view is made here, only at the channel's boundary
 * (mobile-bridge/sanitize.ts, the surface manifest the bridge sends), and it is never stored. The desktop's own renderer never calls it.
 *
 * One mask word on purpose: "[local-path]". An older phone already decodes that word (mobile answer_identity / app_controller), so its bytes do not change.
 * A pure module: no Electron, no I/O, no model. Both POSIX and Windows (drive and UNC) paths are known here, whatever OS the Desktop runs on.
 */
export const REMOTE_LOCAL_PATH_MARKER = "[local-path]";

export const REMOTE_POSIX_ROOT_SOURCE = "(?:Applications|System|Users|home|private|var|tmp|Volumes|opt|etc|usr|Library|root|mnt|media|srv|run|proc|sys|dev|bin|sbin|workspace|workspaces|app|data)";
// A local absolute path starts a token: without this left boundary the "/app/page.tsx" inside the relative "src/app/page.tsx" would read as a local path.
const POSIX_PATH_START = "(?<![\\w.~-])";
const POSIX_ABSOLUTE_PATH_RE = new RegExp(
  POSIX_PATH_START + "(?:file:\\/\\/)?\\/" + REMOTE_POSIX_ROOT_SOURCE + "(?:\\/[^\\/,\\r\\n\"'`<>|}\\]]+)*\\/[^\\s\\/,\\r\\n\"'`<>|}\\]]+\\/?",
  "g",
);
const POSIX_ROOT_PATH_RE = new RegExp(POSIX_PATH_START + "(?:file:\\/\\/)?\\/" + REMOTE_POSIX_ROOT_SOURCE + "(?=$|[\\s,;:\"'`<>|}\\]])", "g");
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
const WINDOWS_UNC_PATH_RE = /\\\\[^\\\s,\r\n"'`<>|}\]]+\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
// A structured card (a surface manifest) has no prose around its paths, so any "/x" token after a delimiter is a path there (the durable-manifest contract refuses these).
const BROAD_POSIX_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/gm;
const BROAD_UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/g;

export interface RemoteMaskOptions {
  /** Structured card text (the surface manifest): also masks any "/x/y" token after a delimiter. Prose keeps the narrow, root-anchored rule. */
  structured?: boolean;
}

/** Masks absolute local paths (POSIX, file://, drive, UNC). Idempotent: masking masked text changes nothing. */
export function maskLocalPathsForRemote(value: string, options: RemoteMaskOptions = {}): string {
  let out = value
    .replace(POSIX_ABSOLUTE_PATH_RE, REMOTE_LOCAL_PATH_MARKER)
    .replace(POSIX_ROOT_PATH_RE, REMOTE_LOCAL_PATH_MARKER)
    .replace(WINDOWS_UNC_PATH_RE, REMOTE_LOCAL_PATH_MARKER)
    .replace(WINDOWS_ABSOLUTE_PATH_RE, REMOTE_LOCAL_PATH_MARKER);
  if (options.structured) {
    out = out
      .replace(BROAD_POSIX_PATH_RE, (_m, prefix: string) => `${prefix}${REMOTE_LOCAL_PATH_MARKER}`)
      .replace(BROAD_UNC_PATH_RE, REMOTE_LOCAL_PATH_MARKER);
  }
  return out;
}

/** Deep-maps every string of a JSON-like value through the remote mask (structured). Non-strings are returned as they are; the input is not changed. */
export function projectValueForRemote<T>(value: T): T {
  const walk = (item: unknown): unknown => typeof item === "string" ? maskLocalPathsForRemote(item, { structured: true })
    : Array.isArray(item) ? item.map(walk)
      : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]))
        : item;
  return walk(value) as T;
}
