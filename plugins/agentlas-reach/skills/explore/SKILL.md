---
name: explore
description: Look at one running app now: open its dialogs, read them, close them, and turn what works into capabilities.
---

# Steps

1. `reach.status` → `explorationSwitch` (the owner's choice in Settings → Explore this desktop's apps) and the `driver`. The background service explores on its own only when the switch is on and the owner is away; this operation is for the app the owner is asking about now.
2. The app must be running with a window. `reach.map` shows its `level`; `reach.app` shows what is already known.
3. `reach.explore` with `app` (needs a write run). It brings the app to the front, opens up to six of its dialog items one by one (`…` items such as Print…, Export…, Preferences…), reads each dialog's controls by caption, cancels it, and puts the owner's app back. It never types into a field, never confirms a dialog, and never opens an app that holds credentials, money, messages or the system (`app_off_limits`).
4. Read the report: `nowUsable` capabilities are callable at once through `$operate`; `failed` ones stay unproven and are retried only a limited number of times.
5. `reach.verify` with `app` and `capability` re-reads one explored capability after an app update: it is found again if its menu item moved or was renamed (new revision), and marked failed if it is gone.

# Verification

Report the numbers the report gives (`menuItemsSeen`, `dialogsTried`, `nowUsable`, `failed`) and list the new capabilities with `reach.app {"usable":true}`. If `blocked` or `stoppedEarly` is true, say so; the rest of the app was not looked at.
