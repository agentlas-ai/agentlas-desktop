











export interface ConfirmationIdentity {
  chatId: string;
  sourceMessageId: string;
}

export interface ConfirmationAnswerFence {
  /** Marks a question answered here. False when it was already marked (an answer is already on its way). */
  claim(item: ConfirmationIdentity): boolean;
  /** Main refused the answer and the question is still pending: it may show again. */
  release(item: ConfirmationIdentity): void;
  has(item: ConfirmationIdentity): boolean;
  /** Main's pending list without the questions answered here. */
  apply<T extends ConfirmationIdentity>(pending: T[]): T[];
}

const key = (item: ConfirmationIdentity) => `${item.chatId}\0${item.sourceMessageId}`;

export function createConfirmationAnswerFence(limit = 200): ConfirmationAnswerFence {
  const answered = new Set<string>();
  return {
    claim(item) {
      const id = key(item);
      if (answered.has(id)) return false;
      answered.add(id);
      if (answered.size > limit) answered.delete(answered.values().next().value as string);
      return true;
    },
    release(item) {
      answered.delete(key(item));
    },
    has(item) {
      return answered.has(key(item));
    },
    apply(pending) {
      return answered.size === 0 ? pending : pending.filter((item) => !answered.has(key(item)));
    },
  };
}
