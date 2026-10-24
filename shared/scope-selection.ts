export function createScopeSelection<T>() {
  let value: T | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  return {
    read: (): T | null => value,
    snapshot: (): Readonly<{ generation: number; value: T | null }> =>
      Object.freeze({ generation, value }),
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    bind(next: T | null): () => void {
      const binding = ++generation;
      value = next;
      for (const listener of listeners) listener();
      return () => {
        if (generation !== binding) return;
        value = null;
        for (const listener of listeners) listener();
      };
    },
  };
}
