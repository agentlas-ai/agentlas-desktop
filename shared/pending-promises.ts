/*
 * the promises a conversation still has - its durable objects. A promise exists only as one of
 * these (a schedule, a wait for another conversation's answer, a Goal's wait); a sentence in an answer is not one. The strip every surface draws is made from this list and from
 * nothing else. No model reads it; no text of the model's reaches it.
 */
export type PendingPromiseKind = "schedule" | "wait" | "goal-wait";

export interface PendingPromiseItem {
  kind: PendingPromiseKind;
  /** automation id | wait id | goal id: the object, so a card and the strip name the same thing. */
  id: string;
  /** Next run (schedule) / the wait's expiry (wait) / the Goal's next look (goal-wait); null = no time (a schedule that is paused). */
  at: string | null;
  /** schedule only: false = paused. */
  enabled?: boolean;
  /** schedule: its name; wait: the title of the conversation it waits for; goal-wait: the machine cause (`wait:automation`, `retry`...), drawn through the dictionary. */
  label: string;
}

export interface PendingPromises {
  chatId: string;
  items: PendingPromiseItem[];
}
