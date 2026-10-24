---
name: operate
description: Carry out one capability of an installed app with typed parameters (a script command, or the app's own menu and dialog).
---

# Steps

1. `reach.map` with `query` (part of the app's name) → the app's `key` and `level`. Several matches come back as `app_ambiguous` with candidates; name one by its key. An app that is not installed is `app_unknown`.
2. `reach.app` with `app` and optionally `search` or `usable:true` → capability ids. A capability with `usable:false` was only seen or failed last time; do not call it.
3. `reach.describe` with `app` and `capability` → `inputSchema` (JSON Schema: required fields, enum members, absolute paths), `runnable`, and `notRunnableBecause` when it is not.
4. `reach.invoke` with `app`, `capability`, `parameters` exactly as the schema says. The result has `ok` and a `value` (script) or `stepsRun` and `postcondition` (dialog).

# Parameters

- A reference to an object is an array of segments, innermost first: `[{"class":"cell","name":"B3"},{"class":"sheet","index":1}]` means cell "B3" of sheet 1. A segment has `index`, `name` or `id`. Only classes the app's own dictionary names are accepted.
- Paths are absolute. An enumeration takes one of the listed members. Anything else is refused before the app is touched, with the cause.

# What the answers mean

- `permission_required`: the run may only read. A command the app declares as a read (a value, a name) is allowed; everything else needs a write run. Ask the owner for write access; do not look for another way in.
- `automation_denied`: macOS has not allowed Agentlas to control this app. Tell the owner to allow it in System Settings → Privacy & Security → Automation, then call again.
- `app_not_running` / `app_has_no_window`: Reach drives only an app that is already open. Ask the owner to open it.
- `no_driver_in_this_host` / `cua_download_failed`: the app's screen cannot be driven from here. A script command still works; say which part did not.
- A dialog capability brings its app to the front for a moment and puts the owner's app back. On a failure the dialog it opened is closed again; `next` says whether the screen seems to have changed.

# Verification

Say what ran (app, capability, parameters) and quote `value`, `postcondition` or the `reason`. A call that did not return `ok:true` did not happen; never report it as done. For a file or a document the call produced, check the result in the app or on disk before saying it exists.
