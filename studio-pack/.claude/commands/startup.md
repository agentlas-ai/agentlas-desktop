# /startup

**Always open the Startup Studio GUI first — on every invocation, before
anything else.** Do not gate this on whether the founder asked for a "visual
workflow"; the command itself is the GUI entrypoint.

Input:

```text
/startup <optional idea or founder workflow request>
```

## Step 1 — launch the GUI (always)

Run this in the background so the session is not frozen by the blocking server
(it auto-opens the browser after ~0.6s):

```bash
python3 scripts/open-studio-gui.py &
```

The launcher guarantees the GUI via a four-tier fallback ending in a page
embedded in the `.py` itself — it needs **only `python3`** (no node, npm, build,
or network), so it must appear even on a fresh install where the packager
stripped the built `web/dist` and static `webapp/*.html`. Skip only on an
explicit `--no-gui` flag or a headless/non-interactive runtime. If `python3` is
missing or the launcher errors, say so — do not claim the GUI opened.

## Step 2 — route if a request was given

If the founder also provided a complete request, route it through the Startup
orchestrator (`agents/00-startup-orchestrator/agent.md`) across the Startup HQs
and return a founder-ready Founder Execution Packet. If no request was given,
the GUI is the workflow surface — tell the founder it is up and wait for input.
