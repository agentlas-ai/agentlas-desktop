---
name: startup-studio-runtime
description: Diagnose + fix Agentlas Startup Studio runtime when "GUI 안 뜸", "클릭해도/Run 눌러도 생성 안 됨", "레거시/옛 GUI" 뜸, or you must do "재게시" — Startup Studio GUI/runtime won't open or generate; re-publish the package. Covers the local session-runtime bridge (open-studio-gui.py) + the StudioRunner auto-consumer and the forge-sync publish path. Use whenever a session is re-debugging these recurring symptoms.
---

# Startup Studio Runtime — operator runbook

Deterministic resolution for the recurring GUI/runtime/publish saga. Cite the CODE, not the first guess. Line anchors below are verified against live source (open-studio-gui.py is 827 lines; forge-sync.mjs is 336 lines; caps live in agentlas.cjs). Re-verify any anchor before quoting it — files move.

## 1. When to use

Trigger on any of these symptoms (do not re-investigate from scratch — jump to §3 triage):
- "명령어 쳐도 GUI 안 뜸" / "Startup Studio GUI won't open"
- "클릭해도 / Run 눌러도 생성 안 됨, 행" / "clicking Run does nothing, hangs"
- "옛/레거시 GUI 뜸" / "old/legacy GUI shows"
- "내 api 쓰지마 / BYOK" concerns about external API keys
- "재게시 / publish 안 됨" / "re-publish the package fails"

## 2. Architecture invariants (memorize — these are fixed)

1. **BYOK = the user's local subscription CLI IS the runtime.** Never an external/owner API key. `claude -p` / `codex exec` running in the session does the LLM work. An owner key baked into a public deploy = bankruptcy risk; the OpenAI-keyed Node server was a deleted mistake. No external API, no per-call cost, no Dockerfile/railway deploy (a public URL has no session).
2. **The launcher serves SPA + a dev bridge — no LLM in the bridge.** `scripts/open-studio-gui.py` serves `web/dist` (SPA) and three bridge endpoints: `GET /studio-data.json` (live working copy or `{}`, `no-store`; `:442-450`), `GET /__studio/manifest` (`{data:<mtime_ns>, idea, busy}`; `:451-460` / embedded `:540-549`), `POST /__studio/request` (appends one line to `.studio-runtime/requests.jsonl`; `:468-484`). The bridge handler has ZERO LLM calls — see its docstring (`open-studio-gui.py:412-419`).
3. **No embedded GUI fallback.** `web/dist` is still excluded from the published bundle because `dist` is a hardcoded packager skip-dir, but `.html` is included so `web/index.html` ships. A fresh Hub install must build the real React SPA on first launch (`cd web && npm install && npm run build`) and then serve `web/dist`. If build prerequisites are missing, the launcher must fail loudly with `gui_unavailable`; it must NOT fall back to `EMBEDDED_GUI_HTML` or any static-lite UI.
4. **StudioRunner auto-spawns the local CLI per queued request and atomically commits.** `class StudioRunner` (`open-studio-gui.py:222`); daemon thread started at `:264`; polls `requests.jsonl` every 0.8s (`:276`); cursor starts at current line count (`:236`) → skips stale pre-launch requests; serialized one-at-a-time. `init` = idea-stage-only; `run` = exactly one stage. CLI writes `.studio-runtime/studio-data.next.json`; Python validates then `os.replace` → GUI never sees a half-written file. `StudioRunner(...).start()` runs in BOTH `serve_dir` and `serve_embedded`. The runner spawns the CLI that MATCHES the host that launched the launcher (`_runner_cmd`): Codex host (`CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_CI`) → `codex`; Claude host (`CLAUDECODE=1`/`CLAUDE_CODE_ENTRYPOINT`) → `claude`; `STUDIO_RUNNER_CLI` overrides. It does NOT just pick `claude` first.
5. **The SPA derives all stage lock/done from verdict labels.** No backend. `stageDone[s]` = `content.stages[s].verdict.label` is NOT in the NOT-DONE set `{대기, 생성 중, 생성중, awaiting, 잠김, locked, "", —, -}` (`studio-context.tsx:78`; derived `:151-155`). `stageLocked[s]` = predecessor not done (`:158-165`); `idea` is never locked. A placeholder verdict → stage (and successors) stay LOCKED.

## 3. Diagnostic triage (SYMPTOM → FIRST CHECK → ROOT CAUSE → FIX)

### 3.1 "GUI 안 뜸"
- **FIRST CHECK (in this order — do NOT open launcher code first):**
  1. Entry-point wiring: does the SLASH command call `hep-network` (deterministic shortcut) or bare `route`? The installed `hep-network` command must either route to the packaged GUI shortcut or launch the GUI through its detached Popen block; verify the installed command surface for the current runtime instead of relying on source metadata alone.
  2. Zombie: `ps aux | grep open-studio-gui` — in `ps` but holding the port with NO LISTEN socket = zombie.
  3. curl-verify the URL (see §4). macOS has no `timeout`.
- **ROOT CAUSE (corrected before):** NOT the launcher (`--no-serve` probe returns `gui_ready`). It was the slash calling `route` and/or a zombie squatting port 4173. `entrypoints.gui_launcher` in the card is metadata read by the slash's own Popen block — the host never auto-runs it on its own.
- **FIX:** The slash captures the `route` JSON; if `action=="route"` + selected card has a local `gui_launcher` + `source` is a real dir → `subprocess.Popen([sys.executable, launcher], cwd=source, start_new_session=True, std*=DEVNULL)` (detached; `serve_forever()` blocks so detach is mandatory). Disable via `HEPHAESTUS_GUI_AUTOLAUNCH=0` (`hep-network.md:51`). Always curl after — `{"gui_autolaunch":"opened"}` (`hep-network.md:79`) is Popen-success only, NOT a serving guarantee. Kill zombies: `pkill -9 -f open-studio-gui.py`, re-run with explicit `--port`, curl.

### 3.2 "레거시 / 옛 GUI 뜸"
- **FIRST CHECK:** Is the install serving anything other than the built React SPA? Published bundles exclude `web/dist`, so the launcher should build it on first launch. If it cannot, the correct state is `gui_unavailable`, not a downgraded UI.
- **ROOT CAUSE:** A fallback/static/embedded path was allowed to mask a failed SPA build.
- **FIX:** Remove the fallback path. `resolve_tier` must return `spa` only when `web/dist/index.html` exists or `ensure_build()` created it. Otherwise it returns `unavailable` and exits non-zero. Verify `scripts/verify-package.sh` includes the no-fallback guard.

### 3.3 "클릭해도 / Run 눌러도 생성 안 됨"
- **FIRST CHECK:**
  1. Auto-consumer running? `StudioRunner` daemon (class `:222`, thread `:264`) — read `.studio-runtime/runner.log` (`LOG_NAME` `:115`).
  2. `claude`/`codex` on PATH? Runner logs `no local CLI (claude/codex) on PATH — auto-generation OFF` (`:262`) and stays off (`shutil.which` `:187-188`).
  3. Autorun on? `STUDIO_AUTORUN=0` disables it (`:258-259`).
  4. RIGHT CLI? `runner.log` prints the choice at start: `runner started … (CLI: codex, selection: host-detected)`. In a Codex session it MUST be `codex`, in a Claude session `claude`. Wrong CLI = `_runner_cmd` host-detection regressed (see §6.9) → it may spawn an unauthenticated/other-subscription CLI that silently fails or hangs.
- **ROOT CAUSE:** `POST /__studio/request` appends to `requests.jsonl` fine (transmission works) but historically NOTHING consumed it. The missing auto-consumer was THE bug. A second, subtler cause: the auto-consumer ran but spawned the WRONG CLI (Claude in a Codex session) — see §6.9.
- **FIX:** `StudioRunner` polls (0.8s `:276`, cursor-skips stale `:236`) and per request spawns the user's OWN CLI headless: `claude -p "<prompt>" --permission-mode acceptEdits --allowedTools "Read Edit Write Glob Grep"` (`:194-201`), codex fallback `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` (`:203-207`). Spawn has a 900s timeout (`:343`/`:349`). Atomic: CLI writes `studio-data.next.json` → `_commit` validates (`en` + `ideaSpine.oneLiner` + all 6 stages present; `_validate` `:382-398`) → `os.replace` (`:377`; `_commit` `:359-381`). Also confirm the runner bumps `manifest.data` strictly higher after each write, or the SPA never re-fetches and the stage never flips `running→complete` (clears only via the 180s `generating` fallback, `studio-context.tsx:338`). Regression-guarded by `scripts/verify-package.sh:143` (needles: `class StudioRunner`, `studio-data.next.json`, `os.replace`, `STUDIO_AUTORUN`, `"-p"`, `StudioRunner(root, state_dir).start()`).

### 3.4 "내 api 쓰지마 / BYOK"
- **FIRST CHECK:** grep the package for `OPENAI_API_KEY`, any external API key, standalone LLM server, Dockerfile, railway.json. There must be NONE.
- **ROOT CAUSE / RULE:** BYOK = the user's running subscription CLI is the runtime (§2.1). Runner only spawns local CLIs (`_runner_cmd` `:170-219`).
- **FIX:** Local dev bridge + session-as-runtime. No external API.

### 3.5 "재게시 / publish 안 됨"
- **FIRST CHECK:** `agentlas cloud package <path> --json` and read the finding (DIFFERENT scanner than `security scan`). The message is almost always **"Package exceeds 3145728 bytes."** (3MB / 400-file cap; `agentlas.cjs:1023`), NOT a secret issue.
- **ROOT CAUSE:** Hard caps (no env override): 400 files, 512KB/file, ~3MB bundle. The live over-cap driver is `Startup/` (HQ bundle, 694 files) rsync'd in. Historically `.playwright-mcp/` snapshots also bloated it (not present in the current source, but exclude it defensively).
- **FIX:** Exclude those when syncing to Paid; see §5.

## 4. Verification protocol

Run in order; never trust `gui_autolaunch:opened`.

```bash
ROOT=/path/to/agentlas-startup-founder-studio

# 1. Tier PROBE only (no serve, no build, no port bind) — expect {"status":"gui_ready","tier":"spa",...}
python3 "$ROOT/scripts/open-studio-gui.py" --no-serve

# 2. Confirm SERVING (the only real proof). --no-serve above does NOT bind a port,
#    so curl a SEPARATELY-running server (the agent.md `python3 … &` launch or the
#    slash auto-launch). macOS has no `timeout`.
( sleep 5; kill -9 $$ ) & C=$!; curl -s http://127.0.0.1:4173/ | grep -o '<title>[^<]*</title>'; kill "$C" 2>/dev/null
# expect: <title>Startup Studio — founder operating board</title>

# 3. Auto-consumer health
tail -40 "$ROOT/.studio-runtime/runner.log"

# 4. Find the REAL PID's LISTEN socket — lsof defaults to OR, so use -a (AND)
PID=$(pgrep -f open-studio-gui.py | head -1)
lsof -a -iTCP -sTCP:LISTEN -p "$PID"          # WITHOUT -a it OR-matches a wrong proc (e.g. rapportd)

# 5. Kill zombies (in ps, holding port, NO LISTEN socket)
pkill -9 -f open-studio-gui.py
```

**Stub-CLI E2E (proves the whole chain with ZERO LLM tokens):** point the runner at a stub that writes a valid `studio-data.next.json`, then POST a request and watch `os.replace` land it. `STUDIO_RUNNER_CLI` is invoked as `<exe> <prompt>` (`:182-185`).

```bash
cat > /tmp/stub-cli.sh <<'EOF'
#!/usr/bin/env bash
# StudioRunner invokes a custom CLI as: [exe, prompt]. Ignore $1, write valid next.json.
cat > "$PWD/.studio-runtime/studio-data.next.json" <<'JSON'
{"en":{"ideaSpine":{"oneLiner":"stub idea","customer":"x","problem":"y","stage":"idea"},
"stages":{"idea":{"verdict":{"label":"GO","tone":"positive"},"runSteps":["ok"]},
"market":{"verdict":{"label":"대기","tone":"neutral"},"runSteps":[]},
"business":{"verdict":{"label":"대기","tone":"neutral"},"runSteps":[]},
"prd":{"verdict":{"label":"대기","tone":"neutral"},"runSteps":[]},
"build":{"verdict":{"label":"대기","tone":"neutral"},"runSteps":[]},
"deck":{"verdict":{"label":"대기","tone":"neutral"},"runSteps":[]}}},"ko":null}
JSON
EOF
chmod +x /tmp/stub-cli.sh
STUDIO_RUNNER_CLI=/tmp/stub-cli.sh python3 "$ROOT/scripts/open-studio-gui.py" --no-open &
curl -s -XPOST http://127.0.0.1:4173/__studio/request -d '{"kind":"init","idea":"stub idea"}'
# then poll /studio-data.json until idea.verdict.label == "GO" (runner validated + os.replace'd)
```

**Package gate before/after publish:**
```bash
bash "$ROOT/scripts/verify-package.sh"     # asserts StudioRunner/os.replace/STUDIO_AUTORUN needles (:143)
```

## 5. Re-publish protocol

Two steps: (1) copy-only rsync github → Paid; (2) `forge-sync.mjs --publish` runs `agentlas cloud publish <folder>` on the folder you pass via `--path` (resolved relative to the forge ROOT, must stay inside it — `:104-110`, `:279`). It operates ONLY on that folder — edit github but skip the rsync and you ship a stale copy.

```bash
# 1. SYNC github -> Paid (copy-only; NO --delete, rm/--delete are sandbox-blocked)
rsync -a \
  --exclude 'Startup/' --exclude '.playwright-mcp/' --exclude '.studio-runtime/' \
  --exclude 'output/' --exclude 'dist/' --exclude 'node_modules/' \
  --exclude '.git/' --exclude '*.png' --exclude '.DS_Store' --exclude '__pycache__/' \
  <source-agentlas-startup-founder-studio>/ \
  <forge-root>/Paid/agentlas-startup-founder-studio/

# 2. (optional) pre-flight cap diagnosis with the SAME scanner publish uses.
#    No --publish => mode=package (dry-run); same agentlas cloud scanner.
node <forge-root>/scripts/forge-sync.mjs \
  --path Paid/agentlas-startup-founder-studio --json

# 3. PUBLISH from forge root (non-interactive; hep-upload fails in non-TTY)
cd <forge-root>
node scripts/forge-sync.mjs --path Paid/agentlas-startup-founder-studio --publish --json
```

- **Success signal:** in the `--json` summary, `result.status:"registered"` plus the `--json` manifest/review fields (`summarizeCloudResult` `:169-195`): `manifest.security`, `manifest.fileCount`/`includedFileCount`/`totalBytes` (`:181-184`), `review.verdict`, `registration`. Read those for the actual shipped file count + bytes — do NOT assume fixed numbers. A ledger row is appended to `.agentlas/forge-sync-ledger.jsonl` (`writeLedger` `:272-275`, append loop `:285-299`); the ledger row carries only `{ts,mode,scope,folder,ok,exitCode,status,slug,routingStatus,summary}` (`:288-299`) — NOT cloudId/security/review. Live ledger confirms `status:"registered"`, `routingStatus:"routing_ready"`. URL https://agentlas.cloud/p/agentlas-startup-founder-studio.
- **Caps (hard, no env override, `agentlas.cjs`):** 400 files (`CLOUD_MAX_FILES` `:769`), 512KB/file (`CLOUD_MAX_FILE_BYTES` `:768`), 3MB / 3145728-byte bundle (`CLOUD_MAX_TOTAL_BYTES = 3*1024*1024` `:767`). Over total = `blocker` `package-size-limit` (`:1023`); over per-file = `high` `large-file` (`:1000`).
- **Allowlist (`CLOUD_TEXT_EXTS`):** keeps `.html` along with `.cjs .css .csv .js .json .jsonl .md .mjs .py .sh .toml .ts .tsx .txt .yaml .yml`. This is required so `web/index.html` ships and installed users can build the real SPA.
- **Skip-dirs by NAME (NOT gitignore) (`CLOUD_SKIP_DIRS` `:772`):** `.git .next .turbo build coverage dist node_modules out release`. `web/dist`/`web/node_modules` drop because the leaf name matches — a build dir named anything else would NOT auto-exclude.
- **Verify the decoded bundle:** each included file is `contentBase64` in the package bundle. Confirm `scripts/open-studio-gui.py` contains the no-fallback guard, `web/index.html` is present, and `web/dist/` remains absent.

## 6. Anti-patterns / do-not-repeat (corrected truths)

1. **"GUI 안 뜸 = launcher is broken."** WRONG. Launcher is fine (`--no-serve` = `gui_ready`). Cause = slash `route`-vs-`hep-network` wiring OR a zombie squatting the port. Check wiring + zombie + curl BEFORE reading launcher code.
2. **"`{"gui_autolaunch":"opened"}` means it's serving."** WRONG — Popen-call success only (`hep-network.md:79`). Always curl for the `<title>` and check `ps`/LISTEN.
3. **"The packager strips `.html` AND `.css` via runtime.py."** WRONG for the publish path. Publish uses `agentlas.cjs` (forge-sync `repoCli`): `CLOUD_TEXT_EXTS` KEEPS `.css`, drops `.html`. Conclusion is the same: keep `EMBEDDED_GUI_HTML` current.
4. **"Run does nothing = request transmission / GUI bug."** WRONG. `requests.jsonl` appends correctly; the defect was NO auto-consumer. Check `StudioRunner` running + CLI on PATH + `STUDIO_AUTORUN!=0`, not the POST path.
5. **"BYOK = wire in an API key (default owner OpenAI key)."** WRONG and dangerous. BYOK = the user's local subscription CLI is the runtime. NEVER bake an external/owner key into a public deploy.
6. **"Publish blocked = security/secret problem."** Usually WRONG. It's the 3MB/400-file cap, with `Startup/` (694 files) the live driver. Read `cloud package --json` first; exclude that dir.
7. **"Markdown wiring in agent.md makes `/hep-network startup` open the GUI."** OVER-CLAIM. That markdown drives the in-session orchestrator path (`agent.md:11-13` `python3 scripts/open-studio-gui.py &`), NOT the slash path. The slash GUI lever is its own `route`-capture + Popen-detached launch in `hep-network.md`.
8. **"Cite 524 / 662 Startup files / `.gitignore` excludes web/dist."** Both wrong. `Startup/` currently has 694 files (over cap — exclude regardless). The packager does NOT parse `.gitignore`; `dist` excludes only because it's a hardcoded `CLOUD_SKIP_DIRS` name (`agentlas.cjs:772`).
9. **"The runner just spawns `claude` (it's first on PATH)."** WRONG, and a real shipped bug: opened from a **Codex** session, the runner spawned **Claude** — the wrong (and possibly unauthenticated) subscription, so generation silently failed/hung. FIX: `_runner_cmd` spawns the CLI that matches the **host** that launched the launcher (it inherits the host env): Codex host = `CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_CI` → `codex`; Claude host = `CLAUDECODE=1`/`CLAUDE_CODE_ENTRYPOINT` → `claude`; `STUDIO_RUNNER_CLI=claude|codex|<path>` always overrides. **`CODEX_COMPANION_SESSION_ID` is the Claude-side codex plugin, NOT a Codex host — never treat it as a Codex marker** (it is set in ordinary Claude sessions). `runner.log` prints the chosen CLI at start; verify-package needles include `codex_host`/`CODEX_THREAD_ID` to guard the regression.
