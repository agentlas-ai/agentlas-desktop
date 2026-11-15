// Keys that features which no longer exist left in this profile's local storage. Dropped once per renderer process.
const RETIRED_PREFIXES = ["agentlas.quest-claim-intent.v1:"];

let dropped = false;

export function dropRetiredLocalKeys(): void {
  if (dropped || typeof window === "undefined") return;
  dropped = true;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && RETIRED_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable: there is nothing to drop.
  }
}
