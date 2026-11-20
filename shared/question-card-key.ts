/*
 * The key of a model's ask-fence card: `fence:<question ids>`. Main stores a closed card under its key and refuses one longer than 300 characters
 * (chat/closed-question-cards.ts KEY_MAX). A batch of 8 questions (`<36-char message id>-q<n>` each) made a 320-character key, so the close was refused SILENTLY,
 * the renderer took Main's empty answer as the truth, and the card stayed after "closed" and came back after every start.
 * A long key is shortened the same way in the window and in Main: first id + count + a hash of the whole list. A short key is unchanged, so what is already stored stays valid.
 */
export const FENCE_KEY_MAX = 200;

function hash32(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

export function fenceCardKeyOfIds(ids: readonly string[]): string {
  const joined = ids.join("|");
  const key = `fence:${joined}`;
  if (key.length <= FENCE_KEY_MAX) return key;
  return `fence:${ids[0]?.slice(0, 80) ?? ""}+${ids.length}:${hash32(joined, 2166136261)}${hash32(joined, 97)}`;
}
