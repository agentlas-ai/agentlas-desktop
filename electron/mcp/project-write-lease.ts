type ProjectWriteLeaseQueue = {
  tail: Promise<void>;
  pending: number;
};

const projectWriteLeaseQueues = new Map<string, ProjectWriteLeaseQueue>();

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Project write lease wait was cancelled.");
  error.name = "AbortError";
  return error;
}

async function waitForPriorLease(prior: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await prior;
    return;
  }
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    prior.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
  if (signal.aborted) throw abortError(signal);
}

/**
 * Serializes write-capable firm turns that target the same canonical project.
 * Different projects and read-only/control-plane turns stay concurrent.
 *
 * A cancelled waiter resolves its own queue gate without running `work`, so it
 * cannot strand later turns behind an abandoned promise.
 */
export async function withProjectWriteLease<T>(
  projectKey: string | null,
  options: {
    signal?: AbortSignal;
    onWait?: () => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (!projectKey) return work();

  let queue = projectWriteLeaseQueues.get(projectKey);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    projectWriteLeaseQueues.set(projectKey, queue);
  }

  const prior = queue.tail;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const waited = queue.pending > 0;
  queue.pending += 1;
  queue.tail = prior.catch(() => undefined).then(() => gate);
  if (waited) options.onWait?.();

  try {
    await waitForPriorLease(prior, options.signal);
    return await work();
  } finally {
    queue.pending -= 1;
    releaseGate();
    if (queue.pending === 0 && projectWriteLeaseQueues.get(projectKey) === queue) {
      projectWriteLeaseQueues.delete(projectKey);
    }
  }
}
