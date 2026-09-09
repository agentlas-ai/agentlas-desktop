# Agentlas Computer Use

Agentlas Computer Use gives One and Work the same run-scoped JavaScript surface for an Agentlas browser tab and macOS applications. The `browser_cua_repl` tool keeps `globalThis` values between calls and returns the final value of each call.

```js
const state = await cua.getState();
const tab = cua.getTab(state.browsers[0].tabs[0].id);
const before = await tab.snapshot();
const save = before.value.match(/button "Save" \[ref=([^\]]+)\]/);
if (!save) throw new Error("Save button is not present in this snapshot");
await tab.click({ element: "Save button", ref: save[1] });
const changes = await cua.diff(before, await tab.snapshot());
return changes;
```

Browser methods include `snapshot`, `screenshot`, `focus`, `close`, `navigate`, `back`, `click`, `typeText`, and `pressKey`. `cua.createBrowserTab("iab", url)` opens a tab in the current task browser.

Native applications are available when Computer Use was selected for the same run:

```js
const finder = cua.getApp("Finder");
const observation = await finder.observe();
const row = observation.elements.find((element) => element.title === "Downloads");
if (!row) throw new Error("Downloads is not present in this observation");
await finder.clickElement({
  observationId: observation.observationId,
  elementIndex: row.element_index,
});
return await finder.observe();
```

Native methods include `observe`, `snapshot`, `screenshot`, `focus`, coordinate `click`, `drag`, `scroll`, `typeText`, `pressKey`, `setValue`, `clickElement`, `performElementAction`, `setElementValue`, and `selectElementText`. An accessibility observation is consumed after a mutation, so observe the app again before the next element action. `screenshot()` returns compact capture metadata to JavaScript; the tool response carries the captured PNG or JPEG as a separate image block.

Every call stays within its task's browser, workspace, permission, approval, cancellation, and artifact scope. Closing or cancelling the run revokes the surface.
