import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../node_modules/agentlas-science/ui/app.js", import.meta.url), "utf8");
const syncSource = appSource.slice(
  appSource.indexOf("// COMPOSER_EVENT_SYNC_BEGIN"),
  appSource.indexOf("// COMPOSER_EVENT_SYNC_END"),
);
assert.ok(syncSource.includes("function createComposerEventSync"), "composer event synchronizer source is missing");
const createComposerEventSync = Function(`${syncSource}; return createComposerEventSync;`)();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const event = (sequence, overrides = {}) => ({ projectId: "p", conversationId: "c", turnId: "t", sequence, ...overrides });
const turn = (lastSequence, status = "running", overrides = {}) => ({ id: "t", projectId: "p", conversationId: "c", lastSequence, status, ...overrides });

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 699 };
  const gate = deferred();
  let reads = 0;
  let inflight = 0;
  let maxInflight = 0;
  let hydrates = 0;
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async () => {
      reads += 1;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await gate.promise;
      inflight -= 1;
      return turn(1486, "completed");
    },
    onProgress: () => assert.fail("terminal receipt must not render as progress"),
    onTerminal: async (receipt) => { scope = { ...scope, lastSequence: receipt.lastSequence }; hydrates += 1; },
    onError: (error) => { throw error; },
  });
  for (let sequence = 700; sequence <= 1431; sequence += 1) sync.push(event(sequence));
  assert.equal(reads, 1, "a synchronous burst starts one receipt read");
  assert.equal(maxInflight, 1, "receipt reads are single-flight");
  gate.resolve();
  await tick();
  assert.equal(reads, 1, "a receipt covering the latest queued sequence removes the redundant read");
  assert.equal(hydrates, 1, "a terminal turn hydrates exactly once");
  assert.equal(sync.push(event(1432)), false, "later events for a hydrated terminal turn are rejected before another receipt read");
  await tick();
  assert.equal(reads, 1, "a hydrated terminal turn does not issue another receipt read");
  assert.equal(hydrates, 1, "later events for an already hydrated terminal turn cannot hydrate again");
}

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 0 };
  let reads = 0;
  let progress = 0;
  const errors = [];
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient-receipt-failure");
      return turn(2);
    },
    onProgress: (receipt) => { scope = { ...scope, lastSequence: receipt.lastSequence }; progress += 1; },
    onTerminal: async () => assert.fail("running receipt must not hydrate"),
    onError: (error) => errors.push(error.message),
  });
  sync.push(event(2));
  await tick();
  assert.equal(reads, 2, "one transient receipt failure is retried");
  assert.equal(progress, 1);
  assert.deepEqual(errors, []);
}

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 0 };
  let progress = 0;
  let hydrates = 0;
  const gate = deferred();
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async () => { await gate.promise; return turn(3); },
    onProgress: () => { progress += 1; },
    onTerminal: async () => { hydrates += 1; },
    onError: (error) => { throw error; },
  });
  sync.push(event(3));
  scope = { projectId: "other", conversationId: "other", turnId: "other", lastSequence: 0 };
  gate.resolve();
  await tick();
  assert.equal(progress, 0, "a receipt resolving after project/chat/turn switch is stale");
  assert.equal(hydrates, 0);
  assert.equal(sync.push(event(4)), false, "events from the stale chat are rejected");
  sync.dispose();
  assert.equal(sync.push(event(5, { projectId: "other", conversationId: "other", turnId: "other" })), false, "dispose rejects later events");
}

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 0 };
  let hydrates = 0;
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async ({ turnId }) => turn(1, "completed", { id: turnId }),
    onProgress: () => assert.fail("completed receipt must not render as progress"),
    onTerminal: async (receipt) => { scope = { ...scope, lastSequence: receipt.lastSequence }; hydrates += 1; },
    onError: (error) => { throw error; },
  });
  sync.push(event(1));
  await tick();
  scope = { projectId: "p", conversationId: "c", turnId: "follow-up", lastSequence: 0 };
  sync.push(event(1, { turnId: "follow-up" }));
  await tick();
  assert.equal(hydrates, 2, "a distinct follow-up turn gets its own terminal hydration");
}

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 0 };
  let hydrateAttempts = 0;
  let successfulHydrates = 0;
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async () => turn(1, "completed"),
    onProgress: () => assert.fail("completed receipt must not render as progress"),
    onTerminal: async (receipt) => {
      hydrateAttempts += 1;
      if (hydrateAttempts === 1) throw new Error("transient-hydration-failure");
      scope = { ...scope, lastSequence: receipt.lastSequence };
      successfulHydrates += 1;
    },
    onError: (error) => { throw error; },
  });
  sync.push(event(1));
  await tick();
  assert.equal(hydrateAttempts, 2, "one transient terminal hydration failure is retried");
  assert.equal(successfulHydrates, 1, "terminal hydration succeeds exactly once");
}

{
  let scope = { projectId: "p", conversationId: "c", turnId: "t", lastSequence: 0 };
  let hydrateAttempts = 0;
  const errors = [];
  const sync = createComposerEventSync({
    getCurrentScope: () => scope,
    readReceipt: async () => turn(1, "completed"),
    onProgress: () => assert.fail("completed receipt must not render as progress"),
    onTerminal: async (receipt) => {
      scope = { ...scope, lastSequence: receipt.lastSequence };
      hydrateAttempts += 1;
      throw new Error("permanent-hydration-failure");
    },
    onError: (error, failedEvent) => {
      if (failedEvent.projectId !== scope.projectId || failedEvent.conversationId !== scope.conversationId
        || failedEvent.turnId !== scope.turnId) return;
      errors.push(error.message);
    },
  });
  sync.push(event(1));
  await tick();
  assert.equal(hydrateAttempts, 2, "terminal hydration is attempted only once plus one retry");
  assert.deepEqual(errors, ["permanent-hydration-failure"], "a permanent terminal hydration failure remains visible after the turn sequence advances");
}

const appOnError = appSource.slice(appSource.indexOf("onError: (error, event) => {"), appSource.indexOf("      });", appSource.indexOf("onError: (error, event) => {")));
assert.doesNotMatch(appOnError, /event\.sequence\s*<=/, "the production wiring must not hide terminal hydration failures after updating activeTurn");

console.log("composer-event-sync-contract: ok");
