# Agentlas Computer Use

The 1.1.12 unified Computer Use API presents browser tabs and native apps through one persistent JavaScript object. The implementation lives in `electron/computer-use/unified` and is transport-injected by design.

```ts
const cua = createUnifiedComputerUse({
  browser: { browserId: "iab", call: scopedBrowserMcpCall },
  native: { platform: "darwin", call: scopedComputerUseMcpCall },
});

const state = await cua.getState();
const tab = cua.getTab(state.browsers[0].tabs[0].id, { browser: "iab" });
const before = await tab.snapshot();
await tab.click({ element: "Save button", ref: "e42" });
const changes = cua.diff(before, await tab.snapshot());

const finder = cua.getApp("Finder");
const screen = await finder.snapshot();
await finder.click({ x: 320, y: 240, sourceId: String((screen.value as any).selectedSourceId) });
```

## Security and runtime wiring

The adapter does not start a browser, connect to CDP, read capability files, or execute caller-supplied JavaScript. Its browser callback must be wired to the current run's existing `agentlas-browser` MCP binding. That path retains the task-scoped native-browser grant, tab presentation, cancellation propagation, session lease, site validation, and approval classifier. In particular, do not wire this API directly to Playwright or Electron `webContents.debugger`.

The native callback must be wired to the current run's canonical `cua-driver` MCP binding. That binding retains the private control-file token, app identity refocus, measured screenshot coordinate space, Accessibility and Screen Recording checks, and serialized input queue. A future Accessibility-tree payload may be returned through this same callback and snapshot value without changing the adapter's authority boundary.

The runtime still needs to expose one persistent, per-run JavaScript host object and provide callbacks shaped as:

```ts
type ScopedCall = (tool: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
```

Each callback must call only its already selected MCP binding and must forward the run abort signal through the normal MCP client. Browser and native callbacks must not be substituted across tasks or retained after the run grant is revoked. The host may expose only the methods on `UnifiedComputerUse`; there is deliberately no general `evaluate`, `runCode`, or Main-process JavaScript method.

This module is an adapter layer. Until the MCP/runtime creates the per-run object and injects both scoped callbacks, it is not a callable product surface.

`UnifiedComputerUseSessions` provides the lifecycle holder for that wiring. Bind it when a run's MCP selections and grants are final, expose the returned object as `cua` in the model's existing JavaScript worker, and call `revoke(runId)` on cancellation, completion, or grant revocation. Do not add a JavaScript evaluator to Electron Main: the worker may evaluate model code under its existing sandbox, while `cua` crosses into Main only through the two scoped MCP callbacks.
