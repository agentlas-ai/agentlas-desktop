/*
 * Where an unsent composer draft is kept so that closing the window does not eat it. Session storage ends with the window it was
 * written in: a window the person closed to the tray, or one the app made anew, started with an empty box. Local storage keeps the words
 * across that, and drops a draft nobody opened again after 14 days (retention: every draft is read when its conversation opens, replaced on the
 * next keystroke, removed when the box empties or the conversation is gone, and an unopened one is swept once when the app starts).
 * Plain text only; attachments are never stored. Best effort: no storage means no persistence, never a broken composer.
 */
export const COMPOSER_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHARS = 200_000;
const PREFIXES = ["agentlas.chat-composer-draft.v1:", "agentlas.one-composer-draft.v1:"] as const;

type Stored = Record<string, unknown> & { at?: unknown };

function read(storage: Storage | undefined, key: string): Stored | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Stored) : null;
  } catch { return null; }
}

const local = (): Storage | undefined => { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } };
const session = (): Storage | undefined => { try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; } };

/** The saved text of one draft (`field` is "input" or "composer"), or "" when there is none, it expired, or storage is unavailable. */
export function readComposerDraft(key: string, field: string, now: number = Date.now()): string {
  const kept = read(local(), key);
  if (kept && typeof kept[field] === "string") {
    const at = typeof kept.at === "number" ? kept.at : 0;
    if (now - at <= COMPOSER_DRAFT_MAX_AGE_MS) return kept[field] as string;
    try { local()?.removeItem(key); } catch { /* best effort */ }
    return "";
  }
  // A draft written by an earlier build lives in session storage only.
  const legacy = read(session(), key);
  return legacy && typeof legacy[field] === "string" ? (legacy[field] as string) : "";
}

export function writeComposerDraft(key: string, field: string, value: string, now: number = Date.now()): void {
  try {
    if (value) local()?.setItem(key, JSON.stringify({ [field]: value.slice(0, MAX_CHARS), at: now }));
    else local()?.removeItem(key);
    session()?.removeItem(key);
  } catch { /* quota or security: typing must never break */ }
}

export function removeComposerDraft(key: string): void {
  try { local()?.removeItem(key); session()?.removeItem(key); } catch { /* best effort */ }
}

/** Once at start: drafts nobody reopened for 14 days leave the store. */
export function sweepComposerDrafts(now: number = Date.now()): number {
  let removed = 0;
  try {
    const storage = local();
    if (!storage) return 0;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) { const key = storage.key(i); if (key && PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key); }
    for (const key of keys) {
      const at = read(storage, key)?.at;
      if (typeof at !== "number" || now - at > COMPOSER_DRAFT_MAX_AGE_MS) { storage.removeItem(key); removed += 1; }
    }
  } catch { /* best effort */ }
  return removed;
}

if (typeof window !== "undefined") sweepComposerDrafts();
