# Changelog

## 0.9.84 — 2026-08-11

Binds the same Agentlas OS v1.1.109 at
610d2ce2dff4d5e15b8adba05b5115c992cbb376.

- Dashboard project, task, team, confirmation, active-run, and readiness views
  keep bounded renderer snapshots across navigation. Store-change receipts
  invalidate only affected data, so returning to Dashboard paints immediately
  without leaving changed records stale.
- Work shows live partial output and the concrete file or command target while
  a model is operating. Sending another instruction keeps the active model turn
  alive, displays the instruction immediately, and starts it after settlement.
- One's quiet home is now a flat white durable-memory topology. It groups the
  real renderer-safe memory projection, scales continuously as memories grow,
  and exposes bounded metadata on hover without displaying memory content.
- Mobile Bridge now mirrors the project chat roster, exact owned Cloud-agent
  availability, automation topology, One memory-map metadata, and verified
  image previews through the same authenticated Desktop authority. Mobile does
  not receive local file paths or infer a team, release, or memory payload.
- These source gates do not themselves publish a release; the Releases page
  stays the authority for what is actually downloadable.

## 0.9.83 — 2026-08-11

Binds the same Agentlas OS v1.1.109 at
610d2ce2dff4d5e15b8adba05b5115c992cbb376.

- Memory curation reads the shared curator ruleset (curator-ruleset.json via
  curator-rules.ts) instead of hardcoded judgment, matching the OS executor;
  a fixture conformance gate checks both surfaces against the same cases.
- One import recognizes Korean and English evidence alike (isolated measure:
  168 imported where 33 had been) and a five-minute scheduler keeps the
  drawer caught up after boot.
- Dreaming dedup defaults on at boot unless a person explicitly chose
  otherwise; dedup records superseded_at instead of deleting.
- These source gates do not themselves publish a release; the Releases page
  stays the authority for what is actually downloadable.

## 0.9.82 — 2026-08-11

Binds the same Agentlas OS v1.1.108 at
088d7311261b803efa4bdb9b1a7397f4b5f20b9a.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- A test run no longer opens your real database. The gates in scripts/ opened
  the live store directly, and running them while the app was open corrupted
  the run-receipt table badly enough that the app stopped starting. Nothing was
  lost, but a script run now gets its own temporary store and says so.
- Codex rows show their effort again. Codex reports reasoning levels per model
  and they differ between models, but the picker only read the runtime-wide
  list, which Codex never sets — so the cell sat empty while six levels existed
  underneath. Each row now asks for its own model.
- The candidate badges no longer carry their meaning in color alone. Which row
  actually runs reads at a glance.

## 0.9.81 — 2026-08-11

Binds the same Agentlas OS v1.1.108 at
088d7311261b803efa4bdb9b1a7397f4b5f20b9a.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- A file the agent wrote counts as an artifact even when the answer never names
  it. The panel used to find files by scanning the answer's prose, so a reply
  that wrote a file and then discussed the result — without repeating the path —
  left the panel empty. Tool calls already carry the path, so it reads those
  too, through the same normalizer the tool rows use.
- An app the agent just started is something you can look at. A local address in
  the answer opens in the panel's browser viewer. Local addresses only:
  automatically opening any URL an answer contains would turn prompt injection
  into an outbound request from your machine.

## 0.9.80 — 2026-08-11

This release binds Agentlas OS v1.1.108 at
088d7311261b803efa4bdb9b1a7397f4b5f20b9a.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Running an automation no longer stops to ask. A step that reaches outside
  used to wait for a person to click approve, which meant automations died
  quietly at the first outbound step — they run when nobody is watching, so
  that wait had no end. The defenses that do not need a person are unchanged:
  a simulation still never sends anything, a mutation without an idempotency
  key is still never retried, and an unverified side effect still stops the
  run.
- Files the agent produces now open by themselves in the right panel. Opening
  a file from the file list used to show its name and an empty body, because
  the list handed the viewer a placeholder that carried no content; it now
  reads the file. Only images opened automatically before, so documents,
  tables, and data files stayed invisible. PDFs render at all now — they were
  loaded over a scheme the window blocks.
- A goal survives the session that started it. Goal mode used to be a sentence
  added to one prompt; it now creates a durable goal with its own tasks, cycle
  accounting, and budget, and the loop continues from that state rather than
  from whether the model remembered to ask for another pass. A goal that
  stalls pauses and calls for help, and real progress lifts that pause — a
  goal meant to run for months would otherwise die the first quiet week.
- `hep-build` reports anonymous counters so build failures are visible to us
  without anyone filing a report. No paths, names, prompts, or error text ever
  leave the machine, and `AGENTLAS_TELEMETRY=0` or `DO_NOT_TRACK=1` stops it.

## 0.9.79 — 2026-08-10

This release binds Agentlas OS v1.1.107 at
1f590f74e28244ab1ed1996cc61c6d5b0f2b5553.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Steering a running Work task now keeps the conversation visible while the
  current direction stops and the new instruction is queued. Returning from
  another screen is no longer required to repaint the answer.
- Long-running conversations avoid repeated full-history scans and preserve a
  lightweight view snapshot when leaving the task, reducing blank reloads and
  progressively slower streaming.
- The right rail now shows the project instruction and durable memory status
  beside the agents doing the work. Each attached agent row explains its
  purpose, while live activity takes precedence during execution.
- Renderer reads share bounded, invalidated IPC results. Store change events
  refresh the affected surface, and a replaced preload bridge cannot reuse a
  method bound to the previous bridge.
- Task and run-event hot paths avoid unchanged write transactions and table
  scans, including an indexed latest-run lookup and throttled reconciliation.
- The bundled Agentlas OS v1.1.107 adds working One checkpoints for OpenCode,
  OpenClaw, Goose, and Cursor and correctly wires checkpoints when One is
  switched on, independent of status-line ownership.

## 0.9.78 — 2026-08-10

This release binds Agentlas OS v1.1.106 at
20decf4d5e8f0164ce5ad3e7de5349638c417dd8.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- The Work right rail now names its primary surface Agents, not Tools or Team.
  A project still owns the work, while the people-like execution identities
  attached to it remain visible as agents.
- During a run, the agent responsible for the latest event and that event's
  actual activity appear first. Connected agents no longer crowd out live
  execution: three remain visible for recognition and the rest fold into one
  bounded disclosure.
- Project Memory now reads the existing project timeline contract instead of
  showing a static promise. It distinguishes saved PM Soul, sitemap, and code
  map state from missing, unreadable, or disconnected storage and shows recent
  durable work records with links back to their tasks.
- Project detail and task mentions use agent and agent-team terminology while
  preserving the project-first execution and memory ownership model.

## 0.9.77 — 2026-08-10

This release binds Agentlas OS v1.1.106 at
20decf4d5e8f0164ce5ad3e7de5349638c417dd8.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Update recovery no longer mistakes a valid journal without an optional
  continuity backup for corruption. A temporary disk or SQLite backup failure
  therefore cannot silently pause automatic installs.
- A persisted recovery hold now keeps its original detection time across app
  restarts. Its six-hour safety window can expire for ordinary users instead
  of restarting forever each time the app opens.
- Packaged runtime dependencies are refreshed to remove the six high-severity
  audit findings present after v0.9.76, with no major dependency upgrade.
- The bundled Agentlas OS moves to v1.1.106, adding the persistent Agentlas One
  workspace and portable Claude Code and Codex host adapters to every Desktop
  installer built from this release.

## 0.9.76 — 2026-08-10

This release binds Agentlas OS v1.1.105 at
90e5cfa081637ec3ea5a701e67d29b100b88ea67.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Work is project-owned from end to end. Project conversations use the Work
  orchestrator, while Agentlas One keeps its own identity, recovery flow, and
  runtime session instead of appearing inside a project task.
- New task now asks how to begin: start a new conversation or import a safe,
  project-matched Claude Code or Codex CLI transcript. Imported history stays
  attached to the selected project and leaves the original CLI session intact.
- Agent Toolbox now treats teams and individual agents as reusable project
  tools. It separates team identity from the controller agent, shows exact
  source and release binding, blocks ambiguous remote attachments, and keeps
  project memory separate from portable Experience Chips.
- Steering a running task now stops the current direction and resumes with the
  new instruction without requiring a trip to another screen. The composer and
  task controls have clearer active states and larger interaction targets.
- Project navigation no longer rescans up to 200 unrelated chats whenever a
  screen opens. Project detail uses the indexed project task ledger, and shared
  navigation reads already-materialized Tasks directly.
- Update cards show the target version, a bounded in-app changelog, a link to
  the full public release record, and one explicit update-and-restart action.
  The layout remains usable when the sidebar or window is narrow.
- Decision sheets now emphasize the concrete choice and consequence instead of
  a fixed metadata grid. Labels state whether a choice executes work, closes
  the sheet, or reminds you in 24 hours.

## 0.9.75 — 2026-08-10

This release binds Agentlas OS v1.1.105 at
90e5cfa081637ec3ea5a701e67d29b100b88ea67.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Bundled Agentlas OS runtime moves v1.1.99 -> v1.1.104: upload no longer blocks
  on repairable structure/market gaps, five new host adapters, plugin-mirror sync.
- Team org chart: an imported team keeps its CEO -> division -> agent hierarchy
  instead of flattening every member under the CEO, and each level binds its real
  agent id so per-agent experience is reachable at every tier. Korean role and
  agent ids are preserved (they were being erased to empty keys).

## 0.9.74 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Steps that fetch things can reach the internet again. Reading a page changes
  nothing, so such a step is written as a read step — and read steps had their
  network cut off, which killed most first steps outright. Writing files and
  reading secrets are still fenced off.
- An automation built from a description can now do what it described. It was
  created read-only even when its own plan said a step would post, send or
  save, so the model refused its own work. What a graph may do now follows
  from what the graph says it does.
- Automations made before the approval change no longer stop for approvals
  nobody asked for.
- A notice that needs your attention can always be closed, and closing it
  works. Some notices had no way to dismiss them at all.
- Pressing something now tells you when it did not work, instead of leaving
  you to press again. Notices are also no longer assembled by reading
  sentences — a three-day-old note once became an approval request sitting on
  a run that had already succeeded.

## 0.9.73 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Runs no longer stop to ask for approval. A step that reaches outside used to
  be locked automatically, so most automations halted on their first run and
  waited for someone who was not there. You decide when you build the graph;
  it runs when it runs.
- The review screen before you save now marks every step that goes outside
  without asking, in red. That screen is where the decision is made.
- A step can still be set to ask, and that setting is honoured.
- Simulate still refuses to call steps that change anything outside, and a
  step with no idempotency key is still never retried.

## 0.9.72 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Details is a panel on the right again. What you decide while looking at the
  canvas belongs beside it; the log and the chat, which fill up over time,
  stay underneath. The bottom now holds those two only.
- The card that says a run is waiting on you offers the approval itself. It
  used to offer only Run again, which reaches the same stop, and it called a
  pending decision a failure.
- Approving no longer brings the card back. The screen re-read the run a
  moment before the kernel had written the resume, so the decision you just
  made reappeared as still pending.
- The log writes down what actually happens: each step starting and finishing,
  every tool call, the model in use, and the gap between events.

## 0.9.71 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- The automation list shows which automations are waiting on you. A run
  stopped for a decision looked exactly like one running fine, so Run now was
  the obvious thing to press — and it stops at the same place. The row now
  offers the decision instead.
- Schedules read as schedules in the list. It printed the raw `daily-09:00`.
- Watching a run live now tells you why it stopped. The step turned red and
  nothing said anything until you reloaded the screen.

## 0.9.70 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- A graph screen now tells you, in one line above the canvas, what just
  happened and what to press. When a run is paused for approval it names the
  step it stopped before and says that approving continues from there.
- Run again now says what it will do. When a stopped run can be picked up
  where it left off, the button reads Continue run instead of Run now, and
  finished steps are not repeated.
- A run waiting on you is no longer listed as a failure. Nothing failed; it
  was waiting.
- The panel below the canvas uses its full width. The step palette and step
  settings were still sized for the old right-hand column, so two thirds of
  the sheet sat empty.
- Add step works while editing. With no validation problems open, the panel
  that holds the palette was not on screen at all, so the button appeared to
  do nothing.
- Small controls are easier to hit, and the duplicate Details heading inside
  the Details tab is gone.
- Stopping a local model run reports why it stopped. It said "This operation
  was aborted" in English; briefly it would also have called a watchdog or
  timeout a cancellation you made.

## 0.9.69 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- A run stopped for approval no longer offers to start over. That button could
  only reach the same approval again, so pressing it repeatedly looked like
  approval that never took. The card now points at the step waiting for a
  decision and says plainly that running again stops at the same place.
- Stopping a run says so in your own language. Cancelling a local model run
  surfaced the browser's own "This operation was aborted" text.

## 0.9.68 — 2026-08-09

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Approving a step now approves it. The button people were pressing sat on a
  run-history card that has no step attached, so it could only start the run
  over — which stopped at the same approval again, however many times it was
  pressed. The approval that carries the step is now the one on screen.
- The graph's lower area is one panel with three tabs — Chat, Log, Details —
  the way a terminal keeps its tabs. The separate right-hand column is gone and
  the canvas has its full width back. The same run used to be explained in
  three places at once, in three different wordings, with no way to tell which
  one to act on.
- Details calls for you when a step is waiting on a decision: the tab carries a
  count, and the panel opens on that tab instead of leaving you to find it.
- The button beside the graph's message box sends the message. It used to
  propose a graph change instead, which is not what a button next to a text
  field means.
- The graph's bottom panel uses its full width. Its conversation was still
  sized as the narrow side column it used to be, so text was squeezed into
  300px while the rest of the panel stayed blank.

## 0.9.67 — 2026-08-08

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- The project task screen no longer replaces itself with a recovery message.
  One list arriving empty from the app's own internals was enough to throw
  during render and hand the whole chat to the error boundary; a caught
  rejection was guarded but an empty result was not. Lists are now normalized
  where they enter the screen, so a missing roster empties one section instead
  of the page.
- File paths in tool rows are relative to the folder you are working in again.
  The shortening existed and was tested, but the screen never passed it the
  working folder, so it printed the full path from the disk root.
- The graph's bottom panel says what it is. Its guidance line was in the page
  but sized for a taller panel, so it was clipped away and left a bare white
  box between two dividers; a session that cannot be loaded now says so instead
  of showing an empty box with a dead input.
- The graph composer asks in Korean. Its placeholder read "Chat anything" in
  the Korean interface.
- Context compaction is visible in the conversation. When earlier turns are
  folded into a summary, the transcript now shows that boundary instead of a
  status line that scrolls past — the reason a long conversation could seem to
  forget what you said.
- A plan the agent writes renders as a checklist, and a long conversation has
  an outline rail: one tick per request, click to jump back to it.

## 0.9.66 — 2026-08-08

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Tool calls finally say what they did. Every runtime's tool call is normalized
  into one semantic shape before it reaches the screen, so a row can show the
  file that changed with `+23 −1`, the command with its exit code, or the search
  with its file and match counts. Before this the renderer only had opaque JSON
  strings, tool names from one runtime were the only ones it recognized — every
  other runtime's calls fell into "other" — and a shell call had its actual
  command replaced with the words "verification step".
- The host no longer speaks in the agent's voice. Automation summaries and
  "something went wrong while preparing this result" were appended to, or
  assigned over, the answer text, so they read as if the agent had said them.
  Host notices are now their own row with their own severity, and their machine
  detail is folded away.
- Chat spacing comes from what sits next to what. A single uniform gap made a
  person's two consecutive messages as far apart as a change of speaker, and
  scattered twenty tool calls into twenty separate cards. Neighbours now decide:
  consecutive tool calls close up into one block, a reply opens wider than a
  follow-up.
- The turn status line stops twitching. Elapsed time and token counts use
  tabular figures so their width does not change as the numbers do, and the row
  keeps its height when a turn finishes.
- A phone that cannot connect now says why. Relay tunnels were being refused by
  this Desktop with a bare 401 and no log line at all — thirteen in a hundred
  seconds with nothing to read. Every refusal path now records a reason
  (no credential, malformed credential, or unknown/revoked device), every
  revocation records who did it and why, and a refusal that only re-pairing can
  fix stops the retry loop instead of hammering.

## 0.9.65 — 2026-08-08

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- An answer is an answer, not the protocol behind it. A team chat could end by
  printing the hidden `<<agentlas-surface>>` block verbatim — raw JSON on
  screen and in the saved transcript — because the step that strips it lived
  on the single-agent path only, and every orchestrated path returns earlier.
  Stripping now happens at the one place every run passes through, so a valid
  surface is shown as the view it was meant to be instead of being pasted as
  text, and an invalid one is never shown at all.
- A local model that breaks down says so as a failure, not as your answer.
  After a tool round-trip collapsed, Ollama replied "The system encountered a
  timeout error … no further function calls are required", and that sentence
  was stored as the result. Local runtimes (Ollama, LM Studio, MLX, and custom
  OpenAI-compatible endpoints) now report empty replies, unconverged tool
  loops, and refusal notices through the same failure marker the CLI runtimes
  use, and cancelling a run is no longer reported as "server unreachable".
- The project chat's opening screen has its design back. Its markup referenced
  styles that did not exist, so it rendered as bare HTML — a heading and a
  list with no card, spacing, or grid. The copy button, the jump-to-latest
  button, the streaming caret, and the stop button were missing styles for the
  same reason and are fixed with it.
- Saving privately to your own Agent Cloud no longer dead-ends. The automatic
  repair pass ran only for public Hub publishing, so the same folder that
  published fine could be refused outright as a private save. Private saves
  now take the same repair path, and the costly model pass runs only when the
  package is actually blocked.
- Work in progress survives leaving the screen. Upload and Telegram connection
  progress lived in the page's own state, so switching menus during a run
  erased the phase, log, and result while the work kept going in the
  background. Both now keep their state outside the view, the way the build
  screen already did.
- The Telegram ports panel stacks instead of crushing itself: the selection,
  the bot name field, and the create button were three columns in a narrow
  side panel and overlapped; they are rows now.
- "Skill injection" is removed from the agent detail screen.
- Releases can be published again. 0.9.64 never shipped: the pre-publish gate
  demanded `desktop-release-assets.json`, a document the publisher itself
  writes later in the same job, so the release failed on evidence that cannot
  exist yet. Build outputs and publisher-derived evidence are separate
  contracts now, each checked in the phase where it exists.

## 0.9.64 — 2026-08-08

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- Approving a step actually ends the question. Deciding on an approval used to
  leave the APPROVAL_REQUIRED record in the run snapshot, so live polling
  resurrected the approval card seconds after you answered it — an endless
  loop of the same question. A decision now clears that node's failure from
  the snapshot, and "Approve and continue" does what it says: the run resumes
  immediately from the same checkpoint, so a one-time approval matches too.
- The canvas speaks from one place. Floating status banners ("Saved" and
  friends) covered the canvas and blocked clicks; they are gone. Status,
  errors, action cards (start value, approval, verdict correction, dependency
  repair), and the session conversation now all live in the bottom panel,
  terminal style, with a single input: Enter talks to the session, and the
  button beside it drafts a graph change. The separate session column is gone.
- An edge can be deleted again: select it and press the delete button in its
  panel (or the Delete key). The loop-bound panel that rendered as unstyled
  skeleton HTML now has its real styling.
- Saving no longer rearranges your nodes. The post-save rehydration ran the
  overlap heuristic over the layout you just placed by hand; the canvas is now
  the source of truth right after a save.

## 0.9.63 — 2026-08-07

- Engine completes a package's contract from its own declarations before verify;
  `agent.md`, work brief, sitemap, routing benchmarks, capability eval plan,
  builder interview, research sources, and output example are derived, never invented.
- packageHash is stable across repeat uploads: identity is recorded after the
  package is finished, not before.
- Borrowed agents receive a write command for their own experience store, so
  memory accumulates instead of only being read.

This release binds Agentlas OS v1.1.99 at
7524f206532c5c509be316d497781b240be3d487.
These source gates do not themselves publish a public installer or update
feed; the Releases page stays the authority for what is actually downloadable.

## 0.9.62 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Clicking a trigger node no longer rewrites its schedule.** A graph built by
  the interview stores its schedule as a raw cron line; the inspector could not
  read that form, so opening the trigger fell back to a daily-09:00 default —
  the canvas flagged unsaved changes from a mere click, and saving silently
  turned a 20-minute schedule into once a day. The raw form is now read back
  exactly, and a regression gate keeps it that way.
- **The list page reacts the moment you press it.** Turning an automation on
  from the list showed nothing while the activation check ran, and a refusal
  (a missing connection) was swallowed into a generic "status did not change".
  The list now behaves like the canvas: immediate feedback, and the real
  reason when it refuses.

## 0.9.61 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Published graphs now have their own shelf in Agent Hub.** A published
  automation graph used to be filed as a 3-credit callable agent whose install
  link was dead — the Hub index dropped the declared "graph" kind, and the
  desktop client folded it the same way. The Hub now shows a Graphs tab; a
  graph card advertises no per-call price, and its one primary action is
  installing it into Agentlas Graph, where it arrives switched off for review.
- **Republishing a graph updates it instead of failing.** Publishing the same
  graph twice died with a revision conflict because the client only knew how to
  create. When the slug already exists and you own it, the publish now targets
  the server's current generation and updates it in place.
- **A quiet model no longer looks dead.** The host now reports "session alive,
  waiting for output" for every CLI runtime while its process is alive — not
  just one of them. A step that thought silently for eight minutes was being
  aborted by the inactivity watchdog even though its runtime was healthy;
  the heartbeat stops the moment the process actually exits, so a hung child
  is still cut exactly as before.
- **A stale "needs attention" card can finally be dismissed.** An old run's
  demand (for example, a re-login notice from a runtime you no longer use)
  stayed on screen with no way to resolve it. Dismissing closes every demand up
  to that point while the runs themselves stay in the history list; a run that
  fails after you dismissed still raises a fresh card, and an unconfirmed
  side-effect can never be dismissed — that one needs your decision.
- **One failure, one surface.** The canvas keeps a top card only for failures
  that carry a human action (approval, judgment correction, dependency repair).
  Informational failures live in the bottom log panel, which now also hosts the
  chat input — no more floating sheet covering the graph.

## 0.9.60 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **A model saying "I can't answer" is no longer treated as the answer.** When a
  runtime hit its usage limit it replied with a human notice, and because success
  was judged by "some text came back", that notice became the model's answer: the
  healthy runtime behind it was never tried, the notice could become a step's
  output or a chat reply, and the screen told you to rewrite a sentence that was
  never the problem. Runtime results now carry a machine-readable failure; every
  consumer judges by that marker, falls back to the next connected runtime, and
  when everything is exhausted you are shown the runtime's own words — including
  when it resets.
- **An automation's tool mode comes from what its steps declare, not from its
  name.** A drafting graph whose steps only searched the web and saved a file was
  forced onto the screen-driving path because its name mentioned a social site,
  and then could not run without an OS permission it never needed. A graph's
  vocabulary cannot declare screen driving, so a graph is never guessed onto
  that path; name-based judgment remains only for legacy single-prompt
  automations.
- **A built-in ability counts.** A step needing web search demanded a Brave API
  key even though the connected runtime can search the web natively. A
  capability the runtime itself provides now satisfies the requirement; no
  single connector holds activation hostage. Providers that carry your data
  (calendars, sheets) are never silently substituted.
- **Search rank does not hire.** Hub staffing used to install the top search
  result; a Korean word-processor agent ended up assigned to "save a draft
  file". Candidates are now judged for fit against the role's own wording, and
  a slot is left empty rather than filled with the wrong specialist.

## 0.9.59 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Saving an automation was failing on every existing install.** A column added
  to the database in an old migration step never reached anyone who had already
  passed that step, so saving died on a missing column. Worse, it died *after*
  the automation had been written: the screen said it could not be saved while
  the automation was left switched **on**, so a schedule you believed had never
  been created would start running. A version-independent check now restores any
  missing column at startup, and an automation that is meant to be off is created
  off rather than created on and switched off a moment later.
- **You can try an automation before turning it on.** It is saved switched off so
  you can look it over — but Run now and Simulate were refused for exactly that
  reason, so the only way to test one was to arm its schedule first. A run you
  start yourself is no longer treated like a queued request from another surface.
- **A stopped run says what actually stopped it.** The run card was replacing the
  recorded reason with a generic sentence, and told you the automation was still
  on even when it was off. When the record already reads as a sentence — "turn on
  Accessibility for Agentlas" — that is what you see.
- **Publishing a graph to the Hub, and installing one, are reachable.** Both paths
  existed but were never exposed to the app, so neither could be done from the
  product. Publish sits on the graph toolbar; install sits above the automation
  list. An installed graph arrives switched off and says so.
- **A graph written in English no longer gets Korean branch labels.** The label a
  branch shows was always built in Korean regardless of language, and that text
  ended up in the public listing, which made publishing to the Hub fail outright.
- **When the model cannot answer, you are told why.** A runtime replying "you've
  hit your weekly limit" was reported as "could not read what to build — describe
  it in one sentence", so people rewrote a sentence that was never the problem,
  and every answer already given was thrown away. The runtime's own message now
  reaches you, and a genuine format error retries instead of ending the interview.

## 0.9.58 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **A save you can walk back.** Saving a graph only overwrote it, so one bad
  edit while talking it through could take a working automation with it. Every
  save now keeps the version before it, and an earlier version can be restored
  from the graph's toolbar. Restoring is itself a save, so the version you were
  on stays in the list and you can go forward again. A save that changes nothing
  does not add a version.
- **A step that hands over nothing now says so.** A code step that promised a
  value to the next step but returned nothing passed as a success — the run was
  green while the result was empty, the hardest kind of failure to notice. It
  now stops with a reason and offers to have the AI fix the script. A step that
  never promised a value is untouched.
- **What a run costs.** Token usage was counted all along but never read back,
  so an automation running every morning could not tell you what it spends. The
  run card shows it.
- **An automation can call another one by describing it.** Calling a saved
  automation as a step was only possible by drawing it; now it can be asked for
  in words. Only automations that actually exist are accepted, and a graph
  cannot call itself.
- **The Hub publish review reports what it read.** It was returning a verdict it
  never computed — always a pass, never a remark. It now reports only facts:
  what each script imports, what it declared, and whether a step that goes
  outside asks first. The review still runs once, at publish.

## 0.9.57 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **The canvas reads top to bottom.** Steps flow downward — the direction people
  read an order — and fold into a new column when a chain gets long. A
  fourteen-step graph now fits in 1120×600 instead of trailing off the right
  edge. Connections attach on any of a node's four sides, and a branch splits
  down-left and down-right so both outcomes read in the direction the eye is
  already travelling.

- **Two ports nobody ever used are gone.** Every node carried a failure exit and
  a cleanup exit. Across every saved graph on this machine, not one was ever
  connected — and for good reason: telling you a run failed is already what the
  app does, and clearing a step's temporary files is already automatic. They
  were asking you to draw a line for something that already happens. The kernel
  still runs those paths, so a graph that has them keeps working.

- **You are no longer asked for a pip name.** When a step's code imports a
  Python package that is not installed, the product used to tell you to declare
  the correct pip name — but there is no way for you to know that PIL installs
  as Pillow or sklearn as scikit-learn. The failure now offers to have the AI
  fix that step, since the AI wrote the code.

- **You see the steps as they are decided.** While an automation is being
  written for you, each step appears as soon as it is settled instead of the
  whole plan arriving at the end after a silent wait.

- **The node settings panel follows your language.** Seventy-eight strings were
  Korean regardless of the setting, so half the panel read in one language and
  half in the other. Flow blocks (check, condition, code, output) also moved
  above the agent list in the palette — they were buried under twenty agents.

## 0.9.56 — 2026-08-06

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **An unattended run cannot ship a result nobody checked.** A weekly sales
  summary computed every week-over-week change as empty and was one approval
  away from writing that into the report. Verification steps were only required
  when a branch repeated, so this graph had none. Now any step that changes
  something outside must be preceded by a check on the value it is about to
  send — unless that value came straight from you, or the graph never leaves
  the machine. Rebuilt from the same request, the automation grades itself on
  seven items, two aimed squarely at that failure.

- **Verification steps are named in your language, and not cut mid-word.** The
  prefix was always Korean, and the text was truncated at a fixed length.

- **A wide graph stays readable.** Fitting the canvas shrank a fourteen-step
  graph until its labels could not be read. Three separate places each fit the
  view with their own settings and the last one won; there is now one rule, and
  it stops shrinking at a readable size and lets you pan.

- **Terminal: `--help` reaches the real help.** `agentlas graph --help` printed
  a two-line stub while the command's own eight-line help was unreachable.

- **Terminal: `graph install --name` works.** The documented flag had never
  worked — its value was appended to the file path.

- **Terminal: `graph show` stops indenting a straight chain.** Fourteen steps
  meant twenty-eight columns of indentation. Depth now marks real branches.

- **Terminal: building a graph follows your language setting.** One Korean word
  in the request flipped the interview to Korean while every other screen
  stayed English.

## 0.9.55 — 2026-08-05

This release binds Agentlas OS v1.1.98 at
b8fc76d44dadd2933216ce669d9f53425a606392.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Automatic updates stop refusing themselves.** The updater compared the
  local database schema against the release and held the install permanently
  when it fell outside the declared range — and that code was not retryable, so
  the hold never cleared on its own. Neither direction was reachable in normal
  use: migrations run before the updater reads `user_version`, and they cover
  every version from 1 upward, so the number it sees is always this build's own.
  Across 45 release tags the migration target and the advertised range never
  once disagreed. The only value that ever reached the check came from a
  development build sharing the profile — data newer than the release means a
  newer app is needed, not a blocked one. Desktop apps that version SQLite the
  same way do not gate their updater on it.
- **Hub plugins install by clicking.** The marketplace card's only button copied
  a shell command, so a Desktop user had to open a terminal to install a plugin
  the agent had just recommended; of the Hub catalogue only the handful that
  also shipped in the bundled catalogue could be installed by clicking. Install
  now shows the exact command that will run on this machine, and what still has
  to be filled in afterwards, before anything is registered — a stdio server is
  a local process, and an approval given without seeing the command is not an
  approval. Nothing is installed until that screen is answered, and a plugin
  that ships no connectable server says so instead of quietly succeeding.
- **A tool waiting for approval says so until it is answered.** Attaching a Hub
  plugin during a run leaves a local server registered but switched off, and
  that fact went by once as a line of run output. It is now asked for directly
  from stored state, so it survives a restart and a new conversation, and the
  card carries the command that will run alongside the button that runs it.
- **The same tool under two names counts once.** The Hub and the bundled
  catalogue name several tools differently (`brave-search-mcp` against
  `brave-search`), so an already installed tool was still advertised as
  installable. Neither side's identifiers were changed — renaming either breaks
  installed rows or outbound links — only the comparison is normalised.

- **Code steps now receive every value they read.** A graph step written as code
  asks for the values it needs, but only the one value declared as its input
  ever arrived. The kernel recognised `vars.x` and `vars["x"]` and missed
  `vars.get("x")` — the ordinary way to read a dictionary in Python, and
  therefore the way these scripts are written. Every other value silently became
  an empty string, so the script did not fail; it produced a weaker result, and
  the checklist that grades the run then passed it on that weaker evidence.
  Values read only from code were invisible in the same way when deciding what a
  graph must be given at start, so a graph could run with a hole in it and never
  ask. Both paths now derive from one shared rule, and a gate refuses any second
  copy of it.

- **A graph can be handed to someone else.** Graphs publish to the Hub and
  install from it. Fields named as credentials are replaced with vault
  placeholders; a credential-shaped value in a field we cannot name blocks the
  export rather than being quietly stripped. Model pins become tier hints so the
  graph runs on the recipient's own models, and local user paths are removed.
  Installing lists what is still empty — vault keys, agent slots, MCP servers —
  instead of reporting success.

- **An installed graph carries no approvals.** Approvals belong to the machine
  that granted them, so a graph someone hands you cannot arrive already
  permitted to post, send, or write on your behalf. Outward steps stay locked
  until you approve them here.

- **Hourly schedules stay hourly.** A schedule written as a bare cron expression
  was not recognised and silently degraded to daily.

## 0.9.54 — 2026-08-04

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Updates stop re-downloading the whole app.** Differential updates have never
  engaged on macOS: every release pulled the full ~340MB, for every user, and
  the cause was ours. electron-updater computes a differential download against
  a fixed name at the cache root, and our stale-artifact sweep deleted that file
  along with the payload — including on the success path, so every completed
  update destroyed the baseline the next one needed. The log said so three times
  running. The sweep still discards everything it cannot trust; only an accepted
  install now keeps the baseline it just proved.

## 0.9.53 — 2026-08-04

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **A second launch says why no window appeared.** Failing to take the
  single-instance lock exited with code 0 and no output at all. That is right
  only when a live first instance raises its window; when the lock is held by a
  dead process or a different build, launching the app looks like it did
  nothing, and the exit code reports success.

## 0.9.52 — 2026-08-03

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **The on-call pool has no rank and no lead.** The orchestrator is the session
  LLM designated on the dashboard; it is not pinned to the project and calls
  whichever project agents it needs. The org chart asserted the opposite three
  ways at once: the first member was drawn as a controller with the others
  indented beneath it as children, later members were labelled "1순위 / 2순위
  선호 인력", and every row carried buttons to reorder that rank. Only the
  empty state told the truth, and it is the one part a user with agents never
  sees. Members are now equal siblings and the reorder buttons are gone.
- **Standalone agents stop reading as the last team's members.** The roster
  library rendered them in a container with no style of its own, right after
  the team blocks, so they inherited the team members' indentation and appeared
  to hang off whichever team was last.

## 0.9.51 — 2026-08-03

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Hub search says which query is running.** Hub search takes ten to fifteen
  seconds, and only the fallback path had a loading state. Typing a new query
  left the previous query's cards on screen, unchanged and unmarked, for the
  whole wait — not merely silence, but the wrong result set presented as the
  answer. The results panel now names the query being run and says the cards
  below are still the previous ones.
- **Open Work no longer reads as a setting.** The control that leaves the One
  conversation for the team, files, tools, and run history sat unmarked as the
  last button of the utilities nav, sharing exact styling with the language
  toggle. It now carries the weight of a destination.

## 0.9.50 — 2026-08-03

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Your phone stays paired.** Measured on a real machine before this release:
  39 paired devices, 0 of them still usable. Five paths revoked every paired
  phone, and four of them fired during entirely normal operation — a plain
  30-day session expiry with no renewal path, any sign-in including the same
  account signing back in, every boot while signed out, and any transient
  failure of the account check that runs on every phone connection. One relay
  hiccup destroyed a pairing permanently and the only cure was scanning a new
  QR. The cause was treating "we could not prove who this Desktop is" as "this
  Desktop belongs to someone else". Revocation now requires proof: only a
  workspace that is provably different loses its credentials. Signing out stops
  serving phones instead of deleting them, so signing back in brings every
  pairing back exactly as it was.
- **A refused phone says which problem it hit.** Every refusal used to be the
  same bare 401, so a phone that simply needed re-pairing looked identical to
  one hitting a cloud outage, a closed account, or a signed-out Desktop — and
  it retried forever instead of telling anyone. Each case now travels with its
  own reason, and pairings created before account binding shipped ask to be set
  up again instead of failing silently.
- **Remote access failures leave evidence.** The Cloud Relay tunnel logged
  nothing at all, so a command from your phone that never arrived left no trace
  on either machine. Every tunnel close now names its cause and whether the
  local hop was reached, and rejected connections report their status.
- **The MCP tools screen stops claiming nothing is connected.** The empty state
  and the first 10-15 seconds of loading were pixel-identical, so opening the
  screen to check plugin status showed "no tools connected" and then silently
  swapped in five real tool cards. First load now has its own wording.
- **The first-run button stays reachable.** Pressing Get Started relabelled the
  button and then nothing moved for nine to eleven seconds, with no spinner and
  no cancel. It also carried `disabled`, which removed it from the tab order, so
  a keyboard-only user could not operate the only control on the first screen.

## 0.9.49 — 2026-08-03

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **The Dashboard and Settings stop disagreeing about the same engine.** The
  run-readiness row for Agentlas OS sat on "update verification is in progress"
  indefinitely — through a 30-minute session and after pressing Run checks —
  while Settings said that exact engine version was current. A bundled engine is
  pinned to the app and has no update journal by design, and the absence of one
  was being read as a check still running, so nothing would ever arrive to
  resolve it. Absence now reports the settled truth: the engine is pinned to
  this app.
- **The version panel says which thing is up to date.** "최신 버전입니다" sat
  directly beneath a warning about the bundled engine with no scope on either,
  so the block read as an error. The app line now names the app, and the engine
  note points at the Update engine control already sitting above it instead of
  warning that features may quietly disappear with no action attached.

## 0.9.48 — 2026-08-03

This release binds Agentlas OS v1.1.97 at
17c2d127c39d45927d8743ceb945516ae89a7f76.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **A failed update stops being a dead end.** A native handoff that ended
  without replacing the app was journalled as `install-not-applied`, a state
  with no retry deadline and no branch that could reach it — so the app settled
  on "업데이트가 적용되지 않았습니다", re-downloaded the full package on every
  launch, and waited for a manual reinstall. It now ages out on a bounded
  backoff and heals itself, while still refusing to re-pull a failed target on
  the very next check. Updates also no longer pause writers or abandon a pending
  install because a convenience backup went missing: automations and sessions
  keep running through an update, and the local database is trusted.
- **Answers appear without leaving the screen.** Reconciliation was gated on
  runs this window started itself, so a reply produced by an automation, a
  schedule, the phone, another window, or a run already in flight sat in the
  database until the user navigated away and back.
- **A past failure stops claiming the present.** An automation that has since
  completed three times kept showing "확인 필요" from an older partial run.
  Only failures after the most recent success count as the current state; the
  older run stays in the history.
- **A project has an on-call pool, not a controller.** The first agent was
  labelled "책임자 · 프로젝트 컨트롤러" and the rest ranked "N순위 선호 인력"
  with reorder controls, and the copy asserted that this controller splits up
  every task. There is no controller agent: the orchestrator LLM chosen on the
  dashboard does that, drawing on the project's agents first and borrowing only
  for what they cannot cover. Those agents carry no ranking.
- **Switching models hands the conversation over.** The session fingerprint left
  the model out, so a BYOK model change resumed the previous model's session — a
  false resume. A model change now starts a fresh session seeded with the
  compacted conversation, so the thread continues instead of being replayed into
  a session that cannot own it.
- **Imported teams stop disclosing themselves,** single agents stop appearing as
  members of the last expanded team, and packaged builds stop logging a dock
  icon warning for a path that cannot exist in a packaged build.

## 0.9.47 — 2026-08-02

This release binds Agentlas OS v1.1.95 at
1e94a67558734f42a93c0353fa0ceddb57996d83.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Automatic recovery closes on the original outcome.** A successful process
  exit is no longer enough: Main binds the original failure, the recovery run,
  and the actual assistant result, then asks One for a semantic outcome
  assessment and records the decision before retrying or stopping.
- **Mobile pairing follows live account authority.** Each authenticated bridge
  connection revalidates the paired Agentlas account and revokes stale device
  authority when that account is no longer active.
- **Mobile One preserves explicit orchestration choices.** Goal, Plan, Network,
  and Live travel as structured turn options; leaving them untouched continues
  to mean that One decides rather than turning capabilities off.

## 0.9.46 — 2026-08-02

This release binds Agentlas OS v1.1.95 at
1e94a67558734f42a93c0353fa0ceddb57996d83.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **One results stay in One unless a real Project owns the work.** Projectless
  One tasks can no longer reopen as global Work chats with no source, team, or
  project identity. Old deep links return to the exact One task instead.
- **Results end with useful next steps, not dismissal buttons.** The fixed
  `Finish here`, `View original`, and fallback details actions are removed.
  Controller-authored follow-ups continue the same task only when they are
  concrete and supported by the result; research and strategy results require
  an actionable recommendation, comparison, launch checklist, and next steps.
- **Antigravity exposes its real model menu.** Dashboard detection reads
  `agy models`, preserves the selected model, and shows the available Gemini,
  Claude, and other Antigravity-hosted model names instead of only
  `Subscription default`.

## 0.9.45 — 2026-08-02

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Antigravity is treated as the working Gemini runtime, not an error.** When
  `agy` is installed Agentlas selects it before the retired Gemini CLI, labels
  the Dashboard card Antigravity, and shows a normal connected state. The
  legacy Gemini usage adapter's unsupported-client receipt no longer paints a
  working Antigravity connection red; usage remains available in Antigravity.

## 0.9.44 — 2026-08-02

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Completed Work shows the result, not the machinery.** Legacy conversations
  that persisted internal progress now open at their final completion section;
  shell launch blocks, localhost links, and absolute user paths no longer leak
  into the novice-facing transcript.
- Restored project-folder notices show only the folder name, and their close
  control has an accurate accessible label instead of appearing as a new-chat
  action.
- Existing project task titles remain concise summaries after restart while the
  original request, run evidence, and local paths stay available to the runtime
  without becoming UI chrome.

## 0.9.43 — 2026-08-02

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
These source gates do not themselves publish a release; the Releases page
stays the authority for what is actually downloadable.

- **Project staffing now reads as an organization, not a system-agent dump.**
  The complete callable Local, owner Cloud, and bookmarked Hub roster is grouped
  by team; internal role cells stay behind their controller; the first saved
  member owns the project while later members remain preferences for automatic
  WorkOrder staffing and Network gap filling.
- **Work labels and controls match the orchestration model.** The first request
  immediately replaces the `New task` placeholder with its concise task title,
  project Work exposes no manual app/swarm/live/Stormbreaker toggles, and `@`
  remains an optional one-turn override without changing session ownership.
- **Role defaults are one controller to many workers.** Dashboard rows are
  ordered model fallbacks shared by one Orchestrator and N Worker executions;
  candidate rows no longer imply that a single worker slot is currently in use.
- Project conversations suppress raw runtime payloads and internal agent status
  strings, completed runs use their latest verified result, and observed task
  participants are projected from actual run evidence.

## 0.9.42 — 2026-08-01

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **One and Work keep one durable owner.** The retired chat-level hired-agent
  roster and session agent-switch bridge are removed. One remains the sole One
  controller, while Work remains owned by the first ordered project agent.
- **Additional agents are turn-scoped.** Explicit `@` selections and validated
  task-force targets apply only to the current turn and are not silently saved
  or reinjected into later requests.
- **Upgrade and Mobile projections match the same contract.** Legacy hired
  roster data is cleared during schema 86 migration, Mobile no longer projects
  that retired state, and updater compatibility now advertises schema 86.
- **One no longer invents semantic decisions.** Recovery, request intent,
  memory intent, decision risk, completion claims, team need, and result-layout
  selection now require a connected-model verdict. Unavailable judgment is an
  explicit fail-closed state rather than a keyword, regex, or fixed-label guess.
- **Observed failures do not rewrite an agent.** Automation still records
  recovery evidence and promotes verified experience, but deterministic error
  strings and counters no longer author or auto-apply prompt changes. Earlier
  auto-applied entries are identified as legacy records with an undo action.
- **Startup and readiness facts stay honest.** The selected runtime has a
  credential-free continuity mirror for tool-free recovery when the operational
  store cannot open, and Dashboard distinguishes checking, connected, and
  user-installed plugin states without blaming Desktop-owned capabilities.
- **Recovery stays inside the product flow.** Consequential One decisions open
  in a model-owned bottom sheet, customer-facing failures stay free of raw
  runtime details, and transient update handoff failures retry without leaving
  an installed user stranded between versions.
- **Project navigation and runtime priorities are easier to recover.** Project
  detail and Work provide a direct Dashboard return, project folders restore
  with their project identity, and Dashboard's high-contrast Auto control keeps
  the ordered orchestrator and worker priorities after restart.
- Production dependencies were refreshed without changing the model ownership
  contract, and the shipped dependency tree now has no known audit findings.
- Project-first Work, exact pointer drag-and-drop, controller binding, completed
  run receipts, and the absence of internal agent slugs were rechecked in an
  isolated production Electron profile.

## 0.9.41 — 2026-08-01

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Mobile Work preserves project ownership.** A created task returns its
  resolved controller, an existing project task cannot be moved to another
  project, and its project connection cannot be cleared through the generic
  workspace action.
- Retired Agent Group-era Cloud combination projections and adapters are gone
  from the Mobile Bridge contract instead of remaining as unreachable product
  vocabulary.

## 0.9.40 — 2026-08-01

This release binds Agentlas OS v1.1.92 at
2eb39adf572bc3e235866002b3143936240f76bc.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Work now starts from a project.** Workspace opens the project list, and
  each project keeps its source, instructions, ordered team, tasks, and memory
  together. Retired global chat and Agent Group entries are no longer product
  routes.
- **Team ownership is explicit.** People add and order project agents
  themselves; the first agent controls project tasks and later agents join as
  turn-scoped helpers. Dashboard orchestrator and worker priorities can be
  reordered and persist across restarts.
- **One remains the single conversation controller.** Calling several agents
  with `@` adds them for one turn without replacing One, and optional run
  controls clearly leave the decision to One when untouched.
- **Automations keep their own sessions.** The automation workspace presents
  sessions, conversation, graph, and inspector as one flow, requires an
  explicit target, and does not create an unrelated global conversation.
- **The redesigned flows survive real desktop use.** Pointer drag-and-drop,
  project creation drafts, immediate task-sidebar refresh, narrow-window
  inspectors, saved-project compatibility, and customer-safe run receipts were
  verified in the packaged Electron surface.

## 0.9.39 — 2026-08-01

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **The automatic post-update repair keeps working.** 0.9.38 added a repair that
  restarts Agentlas once if the first boot after an update fails, guarded by a
  marker file so it cannot loop. Clearing that marker on a healthy start was
  missing, so the repair would have run once and then disabled itself for good.

## 0.9.38 — 2026-08-01

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Updates recover on their own instead of stranding you.** The pre-install
  recovery copy was a precondition for updating, so a transient disk error
  while copying it cancelled the update outright — four times in a row on a
  real machine. The copy, the writer pause, and the install journal are now
  best effort: any of them can fail and the update still installs.
- **A failed update no longer freezes your version.** Startup used to skip
  arming the update timer whenever a hold was active, and nothing re-armed it,
  so one failed install meant no further updates were ever seen. Holds now
  expire and the next check resumes from a clean state.
- **A failed first boot after an update repairs itself.** Instead of a dialog
  asking you to go find a database copy and then quitting, Agentlas discards
  the pending install and restarts once on its own.
- **The "check the preserved local recovery copy" dead end is gone.** Its
  banner, settings row, and status chip were removed; no update state asks you
  to open a database file.

What actually protects your data during a schema change is unchanged: every
migration runs inside a transaction, and the previous app version is retained
by the native updater.

## 0.9.37 — 2026-07-31

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

0.9.36 built these changes but stopped at the update-feed promotion step, so
they were never delivered as a complete release. 0.9.37 carries the same work
and publishes it properly.

- **One finishes the job instead of reporting that it stopped.** A run that
  ends early is now diagnosed and retried by One itself with a changed
  approach, up to two automatic attempts, and the person is involved only
  when retrying cannot help or would be unsafe. A run that may already have
  acted outside the app is never repeated automatically, because there is no
  idempotency key that could collapse a duplicate send.
- **The judgment engine reaches the model again on CLI runtimes.** It asked
  for a boundary that every CLI refuses, so on Claude Code, Codex, Gemini,
  and Grok every verdict silently fell back to its conservative default —
  indistinguishable from a real decision. Judgment now requests tool-free
  isolation, which is the stricter boundary, and uses any connected runtime
  that can prove it.
- **One no longer quotes its own words back as yours.** Prompts One sends on
  the user's behalf are recorded as system turns, so reopening a conversation
  cannot show product wording as something the person typed, and such a
  prompt never becomes the conversation title.
- **Creating a site shows what is actually happening.** Progress from the
  design team now reaches the home view for the whole run instead of being
  discarded until the first screen lands, live stage names replace a fixed
  sentence, and a failed create keeps its reason and a retry on screen rather
  than flashing a toast that disappears.
- **Build refuses to reuse a stale package.** Package reuse is blocked when
  the captured build no longer matches the session it belongs to.

## 0.9.36 — 2026-07-31

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Build asks before it allocates or connects.** The first user-visible turn
  now confirms the outcome, inputs, operating context, and authority boundary.
  Runtime selection and MCP review begin only after the user answers.
- **Build's visible pipeline matches what the product is actually doing.**
  Customer copy distinguishes brief confirmation, model choice, MCP review,
  research, generation, verification, and delivery without exposing internal
  `hep-build` or terminal protocol text.
- **A completed build remains visible after navigation.** Cleanup tolerates an
  older or temporarily missing preload progress bridge, so leaving Build cannot
  crash Dashboard or make a newly registered agent appear to have vanished.
- **A disabled Build start action explains the real blocker.** Runtime quota or
  availability guidance now takes priority over an older success message such
  as “Output folder selected.”
- **Filtered engine events stay out of detailed progress.** Hidden tool and
  protocol events no longer reappear as repeated, meaningless “next stage”
  rows while the package is being generated.
- **Desktop no longer waits for local-model discovery before opening.** The
  launch-time Agentlas OS updater skips a resident-judge probe it never uses,
  while real OS task launches keep the same model-selection behavior.
- **Optional service restore no longer hides the Desktop window.** Mobile
  Bridge and Telegram restore independently after the local customer surface
  and core helpers are started, so an unavailable integration cannot look like
  an app that never launched or hold back another local feature.
- **One hides machine envelopes at the customer display boundary.** Proactive
  cards, task titles, and conversation titles extract a human title from valid
  structured data and replace unreadable system payloads with a localized
  neutral label.
- **One no longer quotes its own recovery prompts as the customer.** Automatic
  retry and connection-recovery turns remain in model context as system turns,
  use a short localized activity label in the transcript, and cannot become the
  conversation title.
- **One keeps failures useful without leaking machine output.** A short,
  customer-safe cause can be expanded when available; JSON envelopes, stack
  traces, terminal output, secrets, and local paths remain hidden.
- **Sites creation no longer looks frozen or silently fails.** The landing view
  follows the actual team phase and feedback during generation, preserves the
  failed brief and reason, and retries the same project instead of leaving an
  empty duplicate behind.
- The transient updater recovery added in 0.9.35 remains unchanged.

## 0.9.35 — 2026-07-31

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **A transient native updater failure can no longer strand later releases.**
  Localized or otherwise unfamiliar Squirrel/macOS handoff errors are retried
  instead of becoming a permanent target block.
- **Agentlas relaunches after a retryable late install failure.** If
  `quitAndInstall` has already begun shutting down the current process when the
  native helper fails, a fresh app process is armed before normal quit
  continues. The next startup clears stale payload state and resumes the signed
  update channel automatically.
- Official application identity and release-signature verification remain in
  place; the removed behavior is the permanent pause caused by one transient
  native error.

## 0.9.34 — 2026-07-31

This release binds Agentlas OS v1.1.91 at
791e69116ce58f867db47f2bb1bc896fcd46c62e.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Desktop embeds the exact Agentlas OS release that passed current Codex
  testing.** Real installed-plugin QA caught and corrected oversized
  `context.impact` and `context.slice` receipts; the visible working set now
  stays below the 16 KB UX bound with explicit omission counts.
- **The One and Build UX fixes remain unchanged.** Dialog sequencing, tour
  scroll restoration, localized starter briefs, correlated Cloud-save
  progress, and customer-safe runtime presentation continue from 0.9.32.

## 0.9.33 — 2026-07-31

This release binds Agentlas OS v1.1.89 at
40da1f0236bccf47ce86594edbbefb05123496bc.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **Desktop now embeds the same Agentlas OS release used by current Codex
  testing.** Context Map results keep the requested answer prominent instead of
  repeating local bootstrap diagnostics, and a stale verification map explains
  the exact `refresh=true` recovery.
- **The One and Build UX fixes from 0.9.32 remain the release baseline.** Dialog
  sequencing, tour scroll restoration, localized starter briefs, correlated
  Cloud-save progress, and customer-safe runtime presentation are unchanged.

## 0.9.32 — 2026-07-31

This release binds Agentlas OS v1.1.88 at
9b0248beb6f8728e58421b14f0c9b749bc24b66d.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **One no longer stacks two first-run dialogs.** The dashboard tour waits for
  the One feature introduction to finish, so navigation from One to Work has
  one clear decision at a time.
- **Guided tours return the user to where they started.** Opening a tour may
  bring its target into view, but Skip, close, and completion restore every
  affected scroll container instead of leaving the page displaced.
- **Build starters follow the interface language.** English starter cards write
  natural English briefs and Korean starter cards write Korean briefs.
- **Cloud save shows the real upload stage.** Build carries a correlated
  progress ID through the existing Main/preload contract and renders
  customer-safe upload, verification, and completion status.
- **The embedded engine and independent Terminal converge on current releases.**
  Desktop carries Agentlas OS 1.1.88, while the external `agentlas` command
  remains owned by Agentlas Terminal.

## 0.9.31 — 2026-07-31

This release binds Agentlas OS v1.1.84 at
0ed5dcd7bd4ac411c42aff64a7fb7ac7d16c6389.
Passing the source gates does not prove a GitHub release or installer; the
Releases page stays the authority for what is actually downloadable.

- **One says who was selected without pretending they already worked.** The
  prepared state names the selected local agents and roles; participation is
  claimed only after an attributed runtime event proves it.
- **Internal envelopes stay internal.** Raw JSON, tool, terminal, MCP, runtime,
  and partial-system output is filtered from customer-facing One and Build
  progress.
- **Agent Build asks before it acts.** Four plain-language questions establish
  the outcome, available input, intended use, and authority boundary before the
  first model turn.
- **A successful build registers once and opens the exact result.** Completed
  agents and teams are added automatically, the registration receipt identifies
  the created entity, and the final action opens My Agents or the organization
  chart without a duplicate import.
- **Failures give a next step.** Build errors are classified into actionable,
  customer-safe recovery guidance instead of exposing an internal engine
  message.

## 0.9.30 — 2026-07-30

This release binds Agentlas OS v1.1.83 at
3defe45b137fea36e7b04ae3087fd7e56990a365.
Passing the source gates does not prove a published release; the Releases page
stays the authority for what is actually downloadable.

- **One speaks like a product, not a terminal.** Raw JSON and internal system
  text are rendered as customer-safe results, Hub search refuses opaque
  low-confidence matches, and stopped work is shown as stopped rather than
  completed.
- **Agent Build asks before it builds and keeps the work.** The first turn
  gathers three product decisions, progress stays visible without exposing an
  internal shell, and a stopped or failed build can resume from its preserved
  workspace instead of starting over.
- **Built agents land where people expect.** Successful builds register into My
  Agents and the selected organization path, with an explicit recovery action
  when registration needs attention.
- **Navigation and confirmation flows are complete.** One task routes survive
  Work round-trips, collapsed navigation is keyboard-safe, ambiguous
  confirmations expose real choices, and the optional mobile guide explains
  its data boundary before opening Settings.

## 0.9.29 — 2026-07-29

This release binds Agentlas OS v1.1.83 at
3defe45b137fea36e7b04ae3087fd7e56990a365.
Passing the source gates does not prove a published release; the Releases page
stays the authority for what is actually downloadable.

- **Agent Cloud conflicts now explain the real next step.** A first save from a
  folder with no local receipt is distinguished from a genuinely stale saved
  revision, so the app no longer blames another machine for every `412`.
  Conflict messages include the server asset identity and tell the owner
  whether to restore once or compare a newer copy.
- **The bundled engine moves to v1.1.83.** Project recall can regenerate a stale
  local corpus from every supported Agentlas surface while keeping the
  immutable runtime pin aligned across macOS, Windows, and Linux release jobs.
  Build, upload, and Workforce fallback paths now use the same routing-card and
  normalized WorkOrder contract as the current Agentlas OS release.

## 0.9.28 — 2026-07-29

This release binds Agentlas OS v1.1.76 at e3d3a9085d087af504964fb5e11f09652e582161.

Passing the source gates does not prove a published release; the Releases page
stays the authority for what is actually downloadable.

- **Bundled engine moves to v1.1.76.** A credential is now identified by where it
  lives rather than by a word in its filename, so a package stops being blocked
  for shipping its own design tokens, and upload widens `allowRead` to the
  context its agent cards declare as required — measured across 143 live
  packages, 82 card-declared files had been unreachable.
- **Carries v1.1.75 as well:** upload corrects an entity type its package
  contradicts, so a team is no longer published and billed as a single agent, and
  Codex regains an upload entrypoint through the `hephaestus-upload` skill.

## 0.9.27 — 2026-07-28

This release binds Agentlas OS v1.1.76 at e3d3a9085d087af504964fb5e11f09652e582161.
This changelog entry describes source readiness and does not prove a published
release.

- **A Workforce preflight failure no longer takes every other engine feature
  with it.** A rejected engine disappeared from runtime resolution itself, so
  one capability check killed Build, security scan, publish, context slice,
  career graph, project bootstrap, the ontology runtime and doctor for the rest
  of the process, with no way back. Rejection is opt-in now and only the check
  that recorded it acts on it — an engine missing five Workforce tools builds
  and scans perfectly well.
- **An engine release no longer stops a deployed Desktop.** The protocol check
  blocks on capability only: missing required tools still refuse, value drift is
  logged and allowed, added tools are fine. Release preflight stays strict, so
  a real contract change is found at build time instead of on a user's machine.
- **One's briefing actions do something.** The reserve/claim/fail lifecycle was
  complete but the renderer never called `startAction`, so the button only
  navigated. It now prepares, asks, then starts — reading only, and asking
  first, because the contract requires explicit confirmation.
- **Hub agent calls survive a prompt that starts with `-`.** The prompt went as
  a positional argument and argparse ate it; it goes through the engine's own
  `--context` now.
- **Publish and security scan stop going silent.** Both could run for minutes
  with no signal at all — the progress callbacks existed with zero callers.
  Publish also no longer opens its own browser mid-run; Settings shows the
  engine account state and signs in once, deliberately.
- **Workforce flags survive One's prompt round-trip.** `--benchmark` and
  `--legacy` were dropped and `--stormbreaker` leaked into the goal string and
  reached search literally.
- **Allocation receipts carry real token usage.** The adapter read output tokens
  and discarded input and cache tokens, so cost telemetry was always empty.
- **A cloned repository's `.env` can no longer redirect a child CLI's provider
  endpoint.** The Terminal fix from 2026-07-27 had never been ported here.
- Settings shows which Agentlas OS is attached and can update it; the bundled
  engine advances to v1.1.73 and `npm run bump:engine` keeps its five hand-copied
  pins in step.
- `targetSchemaVersion` catches up to migration target 81. Shipping 81 while
  declaring 79 would have blocked every update after first launch.

## 0.9.26 — 2026-07-27

This release binds Agentlas OS v1.1.73 at e36f4829f908e15dd64286cf5808d8941c0f54ef.
This changelog entry describes source readiness and does not prove a published
release.

### Fixed

- Build no longer goes silent for minutes at a time. Liveness is now owned by
  the host instead of the model: while a builder turn is in flight, Desktop
  emits its own heartbeat carrying the elapsed time, the last thing the engine
  actually did, and how long the engine itself has been quiet. Previously the
  Build Log stopped dead at "Calling Codex CLI…" and a healthy build was
  indistinguishable from a hang.
- Codex reasoning is reported again. codex 0.145 emits no `reasoning` item
  events at all, so the "Thinking…" signal and its 20-second heartbeat never
  started on that runtime. The turn's own start now opens the reasoning span,
  and the first message or tool call closes it.
- Codex warnings and errors reach the user. `error` items (hook trust, skills
  context budget, tool failures) were dropped on the floor by the event router
  and never appeared anywhere in the app.
- A running Build now has a status bar that stays on screen. It is pinned above
  the scroll, so scrolling to the log no longer hides the only proof the build
  is alive, and it says whose turn it is — the engine's or yours.
- The Build stage clock no longer counts from when the page was opened. It was
  seeded at mount, so a build started later claimed however many minutes the
  window had been sitting idle.
- Uploading to Agent Cloud or the public Hub shows what it is doing. The
  packager already computed every phase — cleaning, routing card, auto-fixing
  blockers, scanning, packaging, review, upload, receipt — and offered them
  through an `onStage` callback that had no callers at all. Those phases are now
  wired to the upload screen as a live timeline with an elapsed clock.
- A pending update whose recovery copies cannot be verified no longer bricks the
  app. Startup threw at the same line on every launch, so the app could not be
  opened again without deleting a file by hand; the blocked install is now
  abandoned and quarantined, and startup continues. Journal validity also no
  longer depends on user-facing wording — editing or translating any of the
  thirteen display strings used to invalidate every journal the previous release
  had written, making a pending install read as corrupt.

This release binds Agentlas OS v1.1.72 at aaadb2267e25b0fecb77d9d8c7f358c2b7aaeecf.
This changelog entry describes source readiness and does not prove a published
release.

### Changed

- One's English first-run headline now reads "Build a version of you that
  works. Then you rest." The Korean headline is unchanged.

### Fixed

- An automation stopped by `owner_only` or `insufficient_credits` no longer
  tells the person their sign-in expired. Neither refusal is recoverable by
  reconnecting, so the previous copy sent readers into repeated pointless
  reconnect attempts. Each now states its actual cause: a Cloud capability
  restricted to another owner's account, or exhausted Hub credits that need a
  top-up.
- An `owner_only` refusal no longer promises an automatic retry. It is a
  permanent refusal for this account, so the follow-up line now says the
  automation target or the signed-in account has to change instead.
- `owner_only` is described as a Cloud owner-account restriction rather than a
  Hub one; the public Hub has no per-owner lock.

## 0.9.24 — 2026-07-27

This release binds Agentlas OS v1.1.72 at aaadb2267e25b0fecb77d9d8c7f358c2b7aaeecf.
This changelog entry describes source readiness and does not prove a published
release.

### Changed

- Binds Agentlas OS v1.1.72: the workforce résumé (workforce card block)
  standard arrives across build, packaging, and upload. Card lint derives a
  deterministic minimal block for auto-built agents and warns instead of
  blocking; hub registration enforces the standard with a repair guide the
  submitter's own model uses to fix and resubmit. The upload flow surfaces
  that guide verbatim.

## 0.9.23 — 2026-07-27

### Fixed

- The project detail timeline now projects each completed task as at most two
  short outcome sentences instead of rendering a stored turn summary or chat
  reply nearly verbatim. Existing rows are compacted at the timeline read
  boundary, so PM Soul, Sitemap, Code Map, memory storage, and memory embeddings
  remain unchanged. Deleted chats retain their unavailable state, while live
  entries continue to open the exact conversation position.
- One's first-run screen now shows the Korean headline as two deliberate clauses
  without orphaning the final word, and the unsolicited explanatory paragraph
  below the headline has been removed.

This release binds Agentlas OS v1.1.67 at 04258b7541f604479dc04279146a506e363ad85e.
This changelog entry describes source readiness and does not prove a published
Desktop installer or update feed.

## 0.9.22 — 2026-07-26

### Fixed

- Project refresh now succeeds only after the installed Core command exits
  successfully and a canonical Code Map v2 with definition and reverse-reference
  indexes exists. Starting a background process is no longer treated as proof.
- The first writable turn refreshes Code Map and functional Sitemap together
  before either is summarized. Legacy fallback output is normalized to Code Map
  v2, while read-only turns continue to avoid creating project-local state.
- Runtime injection is receipted independently for Context Slice, Code Map, and
  Sitemap, so product telemetry can distinguish an artifact on disk from
  context actually supplied to a runner.

This release binds Agentlas OS v1.1.67 at 04258b7541f604479dc04279146a506e363ad85e.
This changelog entry describes source readiness and does not prove a published
Desktop installer or update feed.

## 0.9.21 — 2026-07-26

### Fixed

- Public Hub cards no longer claim more than the server said. The public-catalog
  mapper hardcoded `cloud-callable`, `callable: true`, `routingReady: true` and
  `Security scan A` for every row, so a package the server had marked
  unrunnable still rendered as callable with a passing scan. Delivery state,
  security grade, and invocation counts now come from the response and fail
  closed when absent; borrow volume is no longer reported as verified
  invocations, and an absent team member count stays unknown instead of
  defaulting to 1 and under-quoting credits.
- Local Workforce teams can be prepared again. Locally registered team bundles
  shipped without an execution graph, so preparation rejected them with
  `team_execution_graph_missing` while the surface reported a goal-binding
  problem instead. Team packages now project their own organization (entrypoint
  as manager, member directives as workers) and a rejected preparation returns
  its real issues rather than `preparedButUnbound`.
- Routing's semantic signal is actually semantic. The card router used a token
  hashing adapter that scored equivalent Korean and English requests at 0.0;
  it now uses the verified local sentence model, with hashing kept only as an
  explicitly degraded fallback.

### Added

- Project timeline snapshot: a project's chats, soul, and sitemap project into
  a redacted timeline surfaced on the project detail page and in chat.

This release binds Agentlas OS v1.1.66 at e76d8cd729c8c7f4a7d69be02c9e2c82ff5a97c5.

This changelog entry describes source readiness and does not prove a published
release, a signed installer, or a live automatic update.

## 0.9.20 — 2026-07-26

### Fixed

- Normal chat, Stormbreaker workers, and final synthesis now receive the same
  bounded, dependency-selected Context Slice after a task is concrete. A local
  Core fingerprint refresh keeps definitions and reverse references current;
  Desktop no longer reduces the AI sitemap to one file-count sentence or lets a
  Storm run bypass project structure.
- Context Map source and paths stay local. Desktop calls the installed Core
  through stdin with a bounded timeout, and Hub/Cloud discovery receives no
  project map payload. If the new Core is unavailable, a turn fails open and
  the existing Desktop memory path remains usable.

This release binds Agentlas OS v1.1.66 at e76d8cd729c8c7f4a7d69be02c9e2c82ff5a97c5.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.19 — 2026-07-26

### Fixed

- Agentlas no longer starts with no window when the display is asleep. The main
  window is created hidden and revealed on its first painted frame, but a
  machine that is asleep or locked at launch — a login item, the relaunch after
  an update, a lid closed mid-install — never paints that frame, so the reveal
  event never arrived and the app kept running with no window to click. Waking
  the screen afterwards did not help, because the one-shot event was already
  gone. The window is now revealed on first paint as before, again when the
  interface finishes loading, and finally after a bounded wait, so it always
  becomes reachable.

- Agents staffed for a goal now stay on it across later turns. Staffing a task
  force ran per turn, so the next message re-ran discovery and could return a
  different roster — or none — while the same goal was still open. Desktop now
  binds a durable goal, reuses the bound roster while its lease holds, and only
  releases it when the goal is explicitly completed.

This release binds Agentlas OS v1.1.65 at 89a1a770b46e19e77b291d6af78c884f827671ec.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.18 — 2026-07-26

### Fixed

- Updates no longer stall behind a false "some local Agentlas state could not be
  verified" recovery notice. After installing, Agentlas compared every protected
  database row against a snapshot taken before the install, so ordinary activity
  failed the check: on a real machine all ten violations were benign — nine were
  Hub bookmark sync timestamps written minutes after the snapshot, and one was a
  built-in agent prompt reseeded by the very release being installed. Row counts
  and the schema version matched exactly. The check now no longer runs after an
  install and can no longer hold one, and a recovery hold left by an earlier
  version is released on the next launch. No code path can raise that notice
  anymore — including a journal file that cannot be deleted, which is a disk
  problem rather than a continuity verdict and no longer keeps the hold alive.
  The preserved recovery copy is still written at install time and stays on
  disk, so restoring it by hand remains possible.

This release binds Agentlas OS v1.1.62 at 19b75025e5e252e90d93015a839c55d08fcb8061.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.17 — 2026-07-26

### Fixed

- Agentlas no longer leaves its private per-project state exposed to git. The
  sitemap, code map, project soul memory, memory log, curator decisions, skill
  trials, and the local credential index are outputs of features each user runs
  against their own files — they describe that machine's working tree and are
  never consumed by anyone else — so they are now added to the project
  .gitignore alongside the runtime databases that were already there. Projects
  provisioned before this release pick the entries up automatically without
  losing existing .gitignore content. A project that already committed one of
  these files keeps tracking it until its owner untracks it.

This release binds Agentlas OS v1.1.62 at 19b75025e5e252e90d93015a839c55d08fcb8061.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.16 — 2026-07-25

### Fixed

- The AI sitemap is refreshed on the run path again. The generator worked all
  along, but nothing outside ontology provisioning ever called it, so a project
  could sit on an empty skeleton — or a months-stale map — indefinitely while
  every turn quietly logged that the sitemap was missing or unreadable. The code
  map already repaired itself this way; the sitemap now does too, once per
  project per session and off the turn's critical path.
- A sitemap refresh no longer discards operator-maintained nodes. One map holds
  two kinds of node by design: the walker owns the file tree, while ui-route,
  interaction-surface, runtime-flow and release-gate nodes are maintained by
  hand under the same schema. Those carry no relative_path, so the annotation
  merge could not match them and a refresh replaced them with a directory
  listing. They are now carried through untouched and lead the map.

### Removed

- The Dashboard "project memory status" panel, along with its IPC surface. Its
  sitemap "Generate" button could never do anything — the handler returned a
  constant failure — and an auto-maintained sitemap should not need a button.

This release binds Agentlas OS v1.1.62 at 19b75025e5e252e90d93015a839c55d08fcb8061.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.15 — 2026-07-25

### Changed

- The connected model, not a keyword list, makes every judged decision: approval
  and risk classification, chat-vs-task intent, which agent to route to, which
  tools a task needs, task class, surface and design-style inference, and
  completion-claim gating. Wordlists are demoted to reference hints handed to the
  model — they no longer decide anything on their own, so a request in any
  language, dialect, or phrasing is judged by meaning.
- No more silent keyword fallback. When no connected model can reach a verdict,
  classification and routing return an explicit "undecided" and say a model is
  needed instead of guessing by keyword, and approval/risk/completion gates fail
  closed. A model that timed out or errored is distinguished from a genuinely
  missing model, so a transient hiccup isn't reported as "no model connected".
- The embedded Agentlas OS runtime's own resident judge (content-guard, pipeline
  stages, research loadout, privacy adjudication) now decides by meaning using
  this app's connected model through a universal host bridge — previously it was
  wired to nothing and silently fell back to keywords in every case. No model is
  hardcoded; provider, CLI, and local-model runtimes are all supported.

This release binds Agentlas OS v1.1.62 at 19b75025e5e252e90d93015a839c55d08fcb8061.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.14 — 2026-07-25

### Changed

- Publish auto-fix now converges to an uploadable package instead of dead-ending
  on a blocker. Publishing to the public Hub runs a generic remediation loop
  against the real gate: every blocking finding is handed to your connected model
  to fix in a throwaway copy — a real secret value is redacted to a placeholder,
  a documentation example that merely looks like a key is neutralised, a
  remote-shell installer is defanged — escalating to deterministic secret
  redaction and, only as a last resort, excluding a file, until zero blockers
  remain. A missing routing card is auto-generated from the agent's own identity.
  The result summary lists exactly what was auto-fixed. Your original folder is
  never modified; a real secret is never published — it is redacted, not shipped.
  This closes the case where a keyword scanner blocked publish on a placeholder
  like `sk-ant-...` inside a reference document with no way to proceed.

This release binds Agentlas OS v1.1.60 at 2430d2806782576177002a96f5e792e0439962e5.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.13 — 2026-07-25

### Added

- Publish auto-fix. Publishing an agent to the public Hub now runs a cleanup
  pass first, so a locally-built agent publishes cleanly without hand-editing
  files: virtualenvs, caches, and build artifacts are excluded; secret files
  (`.env`, private keys) are dropped while their `.example`/`.sample` siblings
  are kept; symlinks are stripped; and missing bilingual listing metadata is
  translated by your connected model, grounded in the agent's real name,
  tagline, and definition so the listing stays faithful rather than generic. A
  deterministic safety backstop still catches never-publish files and inline
  secrets even when no model is connected — and a real secret embedded inside a
  kept file blocks the publish rather than being silently shipped.

### Changed

- Security and language judgment moved from keyword lists to a resident LLM
  judgment service; the wordlists are now hints, not verdicts, and the judged
  verdict decides even for synchronous callers. This removes the false
  positives where declarative Korean security copy, ordinary words (for example
  "eyeliner" or "one surface"), or a money/destruction phrase with a qualifier
  ("without deleting…") were mis-flagged. Language detection now uses
  dominant-script analysis instead of flipping on a single Hangul character.
- An unrecognized scan severity is now treated as unsafe rather than "safe".
- Org-node team members preserve their real agent binding during member-cell
  materialization.

This release binds Agentlas OS v1.1.60 at 2430d2806782576177002a96f5e792e0439962e5.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.12 — 2026-07-25

### Changed

- Borrowed agents now keep an owner-scoped memory nest. Genuinely portable
  skills a borrowed agent learns (for example a retry-with-backoff habit) carry
  between your projects, while project-identifying details stay quarantined to
  the project they came from — a borrowed agent never leaks one project's
  specifics into another.
- Schema upgrade to v78, extending the team-member and borrowed-agent memory
  partitioning introduced in v0.9.11. The upgrade is additive and idempotent;
  existing memory is preserved in place.

This release binds Agentlas OS v1.1.58 at 47e2368e5c775d6345118c6409850872ec647738.
This changelog entry describes source readiness and does not prove a published
Desktop release, installer, or update feed.

## 0.9.11 — 2026-07-24

### Added

- Memory architecture rework. Team members are now first-class memory/experience
  owners: on upgrade (schema v75), every local team's org-chart members become
  first-class agents (id preserved from their slug, so existing member memory
  links automatically). Experience and chips can now accrue per member, not only
  to the team orchestrator. Existing orchestrator experience is not moved.
- Import existing memory: an "Import existing memory" action in the agent/team
  detail (My Agents) and an `agentlas memory import <path>` terminal command turn
  legacy markdown notes into Agentlas memory (embedded, idempotent, secret-redacted).
- Self-evolution now fires on normal runs (repeated failure, accumulated
  experience, repeated steering), not only scheduled-automation recovery.
  Trust-tiered: low-risk proposals auto-apply with an undo entry; high-risk
  proposals ask for approval — surfaced on the Dashboard, One, and the terminal
  (`agentlas evolve`).
- Memory relation graph densifies with deterministic `similar_to` edges on every
  memory insert path.
- Project memory status: the Dashboard shows whether PM soul, code map, and
  sitemap are present and were recently used, with a generate action when missing;
  content-free source-usage markers make "did this run use the code map?"
  answerable.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.10 — 2026-07-24

### Changed

- Dashboard LLM connections/usage is now a responsive grid of provider cards
  grouped into collapsible sections (Subscription/CLI, API key, Local). Each
  card keeps its logo, shows a connected chip, two-line status, usage bars, and
  a bottom action row — the number of cards per row adapts to width.
- Hub agent cards dropped the meaningless first-letter identity tile; cards are
  text- and button-focused.

### Fixed

- Experience intake no longer throws a FOREIGN KEY constraint when a memory's
  owner is a team org-chart member (bound by slug, with no installed_agents
  row); it now skips accrual for non-installed owners instead of aborting the
  caller's curation.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.9 — 2026-07-24

### Fixed

- Experience map: the map failed to load for every agent because the graph
  snapshot query referenced a `taste_draft_candidates.statement` column that
  does not exist, throwing a SqliteError. The map now renders its clustered
  nodes for all agents.
- Agent library: the roster (left) and detail (right) panes now scroll
  independently instead of scrolling the whole page as one unit.
- My Agents now surfaces bookmarked and recently-borrowed Hub agents and teams
  that are not yet installed, in a "Hub bookmarks · recently used" shelf
  (previously only agents borrowed 5+ times appeared).
- LLM connections/usage: provider status text (connected · usage · version)
  clamps to two lines instead of breaking the card; connect actions moved below
  the name row; a connected provider shows a green connected chip.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.8 — 2026-07-24

### Experience

- Experience intake now redacts privacy spans (local paths, URLs, emails,
  phone-like numbers, opaque IDs) and admits the memory instead of discarding
  it. Hard blocks remain for secrets and confidential material, and a
  post-redaction rescan fails closed. Receipts record redaction counts, and
  skip/block reasons are visible in the new profile-card diagnostics.
- Long-number privacy detection no longer misfires on git SHAs, UUIDs, or
  timestamps.
- Successful interactive runs with a durable run receipt now auto-promote
  their experience candidates (previously only scheduled-automation
  recoveries promoted).
- Builtin agents accrue local experience via stable base fingerprints; exact
  Hub bindings are required only for public upload and marketplace listing.
- Owner-reviewed public unseal for operational experience chips (explicit
  consent + clean privacy scan + verification receipt) — public chips can now
  actually be created.
- Schema v74: per-agent usage ledger (first/last use, use counts, backfilled
  from run history), local agent bookmarks, and intake diagnostics IPC.

### Experience Map

- The 3D map now clusters by task type with deterministic assignment, cluster
  hulls, and human-readable cluster labels. Zoom-dependent label density,
  neighborhood highlight, cluster fly-to, and session-stable coordinates via
  a layout cache. Local nodes show real titles; Hub-sourced nodes keep safe
  labels, and nothing from the map is exported. The unmounted legacy 2D graph
  view was removed, and the map is front-and-center in both the agent and
  firm Experience tabs.

### Terminology & UX

- One concept, one name: Experience / Experience Chip / Equip. The
  "온톨로지 칩" tab is now "경험" (Experience); internal jargon no longer
  appears in user-facing copy (contract-tested).
- New Experience profile card: accrual funnel, recent experiences, equipped
  chips, and "why nothing accrued" diagnostics.
- Library roster: bookmark and frequently-used sections, per-agent usage
  badges, and team member usage rollups.

### One

- Work/One surface separation (schema v73): One only sees conversations it
  started; Work items no longer leak into the One home.
- One home now presents actionable use-case chips (build an agent,
  find/manage agents, create an automation, review experience) with a
  deterministic resume/rotation slot; chips deep-link into real capabilities.
- One persona directive in oneMode runs, and in-One direct automation
  creation with explicit success/error surfaces.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.7 — 2026-07-23

### Added

- Runtime API-key elicitation: when an interactive chat run's matched tool is
  blocked on a missing credential, a bottom sheet now asks for the key in-app
  (password inputs with catalog labels and a setup link). Saving stores the
  value in the existing Keychain env vault and the run reconnects the tool
  immediately; declining or timing out proceeds without it plus an honest
  instruction to substitute an available alternative. Automations, agent
  apps, site studio, Telegram, and mobile runs never pause on this gate.
  The event and IPC carry key names and an outcome only — secret values
  travel exclusively through the pre-existing vault channel.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.6 — 2026-07-23

### Fixed

- Restored the autonomous automation recovery/evolution pipeline that 0.9.5
  removed outright, closing the two gaps 0.9.5 named instead of deleting the
  feature: failure text is redacted (API keys, tokens, passwords, bearer
  headers, private-key blocks, and full URLs reduced to host-only) before it
  can reach a model prompt, agent memory, or an Experience record, and the
  Hub plug-in bridge only ever registers connection metadata — it never
  reads or writes a credential value, so remote MCP connections still need a
  person to enter the key in MCP settings before the vault is populated.
- A failed automation still forbids repeating the same approach after two
  consecutive failures, demands an auditable "Strategy change" declaration,
  and reports BLOCKED honestly when every alternative is exhausted — approved
  as auto-apply + notify + one-click rollback, unchanged from what shipped
  before 0.9.5's revert.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.5 — 2026-07-23

### Security

- Hub plug-in discovery is advisory only. A Hub listing cannot fetch a manifest,
  register or enable an MCP server, or attach Keychain values to a remote
  request. Remote MCP connections remain an explicit Settings action.
- Automation retries can require a changed approach after repeated failures,
  but pass only the failure count to the next run. Failure bodies are not
  copied into model prompts, agent prompts, memories, or Experience records,
  and no recovery path can autonomously mutate an agent prompt.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.4 — 2026-07-23

### Fixed

- Official macOS installs now repair only unsigned generated Python bytecode,
  re-verify the exact Developer ID requirement and Gatekeeper assessment, and
  seal the embedded Hephaestus and Python runtime trees read-only before any
  Python process can start. Clean installs take the same idempotent seal path;
  any unrelated signature or containment failure stops startup instead of
  weakening trust.
- The updater ZIP remains owner-writable for Squirrel's quarantine handoff,
  while the installed copy becomes immutable on first launch. Native ShipIt
  replacement is verified from a sealed old app to a writable new candidate.
- A background update relaunch now restores the existing encrypted account via
  Electron's asynchronous safeStorage path. Only temporary Keychain startup
  delay is retried without a recovery card; missing, expired, or invalid auth
  and every database, agent, and route violation remain fail-closed.
- Deferred account recovery now resynchronizes the mounted account and Hub
  state in the same process. Mobile Bridge waits during temporary auth recovery
  and no longer deletes paired-device credentials because Keychain was briefly
  unavailable.
- Opening Dashboard no longer performs a real connection probe for on-demand
  browser MCPs. On Windows this had launched a detached Chrome or Edge window
  at `about:blank` on every Dashboard visit; browser sessions now start only
  for an explicit browser test or a real browser task.

### Runtime

- This release binds Agentlas OS v1.1.58, pinned at
  `47e2368e5c775d6345118c6409850872ec647738`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.3 — 2026-07-23

### Fixed

- macOS automatic updates once again install through Squirrel. The final update
  ZIP keeps both `Hephaestus` and `python-runtime` owner-writable while ShipIt
  clears quarantine, without granting group or other users write access.
  Embedded Python still forces bytecode caches outside signed Resources, so
  installability no longer weakens the existing cache boundary.
- The release packager now rejects a macOS updater ZIP whose runtime entries
  cannot accept and remove extended attributes. It also verifies the exact
  signed ZIP bytes, protected Python cache routing, and code-signing requirement
  after packaging, preventing the read-only archive regression from returning.
- Existing v0.8.65/v0.8.66 installations can recover without downloading a
  replacement installer. Agentlas OS v1.1.57 quarantines only the exact stale
  ShipIt payload tied to the known `app.asar/dist` cleanup failure; the existing
  app and local Agentlas data remain in place so, once this corrected Desktop
  release is present on the feed, Retry or the next restart can resume the
  signed update channel.

### Runtime

- This release binds Agentlas OS v1.1.57, pinned at
  `db4b8a2a788f885b51962c5274bf625da2526ff9`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.2 — 2026-07-22

### Fixed

- Release metadata now keeps the public README, package version, and Linux
  package maintainer contract aligned without restoring private developer
  metadata to the packaged application.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.9.1 — 2026-07-22

### Fixed

- Linux `.deb` packaging now uses the public Agentlas support contact instead of
  depending on private developer metadata in the packaged application manifest.

## 0.9.0 — 2026-07-22

### Changed

- Work and One task runs now start with full local execution permission so an
  agent can complete the requested shell and browser work without inventing a
  second approval boundary. The mobile-facing permission normalizer remains
  fail-closed, and read-only conversations keep tools disabled.
- Write/full runs now carry an explicit completion contract: investigate the
  cause, apply the fix, verify the result, and then report it. When execution is
  genuinely impossible, the runtime must name the exact missing permission,
  folder, tool, or connection and give the concrete next step.
- Ordinary browser navigation, clicking, typing, and reading can proceed without
  a hidden approval sheet. Payments, unsafe browser code, and an explicitly
  stored per-site denial still require or enforce the existing user boundary.

### Fixed

- macOS updater recovery no longer walks into Electron's virtual `app.asar`
  filesystem while removing a stale ShipIt payload. A failed native handoff can
  now clear the old payload and resume the signed update channel instead of
  pausing indefinitely with `legacy-cleanup-failed`.
- Codex write-mode and resumed write-mode runs now enable workspace-sandbox
  network access, allowing automations and acting chats to reach the dedicated
  loopback browser/CDP port and HTTP services while preserving the filesystem
  sandbox. Full mode remains the explicit sandbox bypass.
- A ready dedicated browser port no longer hard-fails only because its listener
  ownership cannot be re-verified; the launcher records a warning and continues.
- Dedicated automation and login Chrome processes disable background component
  updates and renderer/timer throttling so a long-running browser is not replaced,
  suspended, or killed underneath an active agent.
- The floating browser/computer-use panel retains its last good image through a
  transient capture failure instead of flickering back to an empty waiting state.
- Automation attention messages no longer expose internal reason codes such as
  `ambiguous_side_effect` or `partial_reconciliation_required`. Users receive
  plain completion, connection, input, retry, or safety-pause guidance while the
  raw reason remains internal to scheduling logic.

### Included

- Includes v0.8.66's restored light One interface and visible Work / One switch,
  seven exact integer-scaled poses from the supplied orange pixel-dog sheet,
  bundled pinned Playwright MCP runtime, and atomic pause for ambiguous external
  actions.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.66 — 2026-07-22

### Fixed

- Restored Agentlas One's original light background and high-contrast card,
  menu, onboarding, and result surfaces after a dark palette made the product
  logo and navigation difficult to see.
- The One desktop sidebar now starts expanded, keeping the Agentlas One / Work
  product switch visible at the top left. Narrow windows retain the existing
  hamburger-controlled sidebar.
- Replaced the generated mint and orange mascot artwork with seven exact
  pixel-art dog poses cut from the supplied source sheet. The onboarding now
  uses those original pixels at integer scale and removes the generated
  firewall composite.
- Agentlas Browser now ships its exact Playwright MCP host inside Desktop and
  starts it with the signed app runtime. Clean installs no longer depend on a
  system Node/npm installation or an `npx` download, and the first-run browser
  readiness window now allows Chrome/CDP startup to complete.
- An ambiguous browser or external-action occurrence now clears its next due
  slot in the same database transaction that records the failed run. The
  automation stays enabled for explicit reconciliation without repeating the
  uncertain action every 15 minutes.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.65 — 2026-07-22

### Security

- Pinned `sharp` to `>=0.35.0` (libvips CVE-2026-33327/33328/35590/35591) and
  `fast-uri` to `>=3.1.4` (GHSA-v2hh-gcrm-f6hx) via `overrides`, without changing
  the pinned Next.js major. This clears the high-severity `npm audit` advisories
  that were failing the release security preflight. Three moderate advisories
  remain and do not gate the release.

### Included

- Carries the previously unreleased v0.8.62 customer-safe One surface, v0.8.63
  on-device semantic agent routing, and v0.8.64 automation retry fix.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.64 — 2026-07-22

### Fixed

- A scheduled automation that failed before any external tool ran (e.g. a
  transient LLM error) was misclassified as an ambiguous side effect and silently
  suspended — its `next_run_at` was cleared instead of retrying. A failure with no
  observed tool receipt and no prepared action never reached an external side
  effect, so `electron/workflow/run-graph.ts` now treats it as replay-safe and it
  retries on the next slot. This also unblocks the desktop release gate, which the
  regression had been failing.
- A scheduled run now records its run through the injected fire time
  (`electron/automation-scheduler.ts`), so `last_run_at` and the schedule advance
  share one clock and `next_run_at` never lands before `last_run_at`.

### Included

- Carries the previously unreleased v0.8.62 customer-safe One surface and v0.8.63
  on-device semantic agent routing work.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.63 — 2026-07-21

### Fixed

- One's local specialist routing (`electron/agents/auto-router.ts`) no longer
  mis-routes on incidental keyword overlap — the cause of a café restock note
  being pulled into a "Meme Shorts Studio" team run. `selectAutoRoutedAgent` now
  applies the verified on-device multilingual model (potion-multilingual-128M) as
  a precision veto: a lexically-matched candidate is recruited only if the local
  model is semantically confident it fits the request; otherwise One stays solo.

### Changed

- Local agent routing gains the same semantic-vs-incidental discrimination the
  Hub/Cloud ontology provides, computed fully on-device (no prompt leaves the
  machine). Explicitly named agents, curated route hints, and machines without
  the embedding asset keep their existing behavior. `scoreAgent` now reports a
  `highPrecision` signal so explicit intent overrides the semantic gate.

### Tests

- New `verify-agent-route-semantic-gate` injects a deterministic semantic verdict
  to prove the café mis-route is vetoed, an eligible specialist still routes, an
  explicitly named agent overrides the veto, and machines without the model fall
  back to the legacy lexical path.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.62 — 2026-07-21

### Fixed

- One now renders every progress, result, and error surface through a single
  shared customer-safe boundary (`shared/one-customer-safe.ts`). Internal
  runtime, CLI, borrowed-agent, session, and result-schema vocabulary — for
  example `Calling Codex CLI...`, a cross-domain studio name, `runtime-session`,
  or "structured result / exactly one safe One Surface" — is stripped before it
  can reach a customer. Progress shows the calm five-stage label and a specialist
  count instead of internal agent names.
- Result and error copy that previously exposed developer-schema terms (disabled
  "workbench", "structured result", "safe One Surface") in
  `electron/mcp/client.ts`, `electron/mcp/borrowed-task-force.ts`, and
  `electron/invocation/service.ts` now reads as plain, honest retry copy. A run
  that could not finish or validate a result says so instead of claiming success.

### Changed

- The task-force synthesis answer is pinned to the run locale, so an English run
  never ends in Korean product copy regardless of a borrowed agent's default
  language.

### Tests

- New `verify-one-customer-safe-copy` regression combines a behavioral test of
  the customer-safe boundary against the exact leaks captured in the official v2
  beta cut with a source guard over the One display paths. The One suite is
  realigned to assert the new customer-safe copy.

### Runtime

- This release binds Agentlas OS v1.1.56, pinned at
  `3061292495b08d513dd5fcf2025a96d85813b627`. This source note does not prove a
  Desktop Git tag, public installer, GitHub release, or update feed.

## 0.8.61 — 2026-07-21

### Changed

- One onboarding now uses only charcoal and mint surfaces, a clearly dog-shaped
  flat 2D mascot, and a flat local-device illustration. Paper, cream, red, and pseudo-3D Pac-Man
  styling are excluded from the One tutorial.
- Subscription, provider, starter-team, concept, and first-request selections
  are saved with serialized compare-and-swap writes. The AI brain connection
  action now waits for the latest saved provider state instead of racing a
  pending selection write.
- Provider membership links use the providers' official pricing or membership
  pages, and starter-team provisioning receives the active Korean or English
  locale.

### Fixed

- The tutorial can be closed immediately with its close control or Escape,
  including while provider detection is still running. Dismissal persists and
  reset clears every onboarding choice before starting again.
- macOS updater recovery repairs the narrowly scoped generated Python cache
  mutation inside the signed app, re-verifies the exact official identity
  `Developer ID Application: Jeongmin Kim (F469CGM7T5)`, Team ID
  `F469CGM7T5`, and bundle ID `com.agentlas.desktop`, then continues the normal
  automatic update. It never sends the user to a website to redownload or
  reinstall the app.
- Agentlas OS v1.1.56 provides the digest-verified in-app recovery bridge for
  affected installed Desktop v0.8.58 and v0.8.59 clients and retries that bridge
  even when the OS runtime is already current. Runtime update caches may take
  up to 24 hours to refresh; no installer download is required.

Agentlas OS v1.1.56 is pinned at
`3061292495b08d513dd5fcf2025a96d85813b627`. Source readiness does not prove
that a public Desktop Git tag, installer, GitHub release, or update feed exists.

## 0.8.60 — 2026-07-21

### Added

- One onboarding can now be closed at any step without losing the current
  scene, subscription choice, provider choice, starter-team selection, or
  first request. The Las helper reopens a dismissed guide from the exact saved
  point, while existing users keep the guide off until they opt in.
- Added an explicit path to explore One before an AI provider is fully ready,
  plus visible busy and connection-check states for every provider action.

### Changed

- One and its onboarding now use a charcoal-and-mint surface contract instead
  of paper, cream, or red presentation. Las is a flat 2D mint sprite, and the
  local-device explanation uses a matching flat illustration.
- Subscription and provider cards respond during tutorial replay as well as
  first run, so a migrated user can select a brain and advance instead of
  hitting a silent no-op.
- Agentlas OS v1.1.50 remains pinned at
  `5fc22464c1db33dabc0d4de2170053d1584b5682`. Source readiness does not prove
  that a public Desktop Git tag, installer, GitHub release, or update feed
  exists.

### Fixed

- macOS packages make the bundled Hephaestus and Python runtime resources
  read-only immediately after app signing and re-verify the pinned designated
  requirement before packaging. Python can no longer write `__pycache__` bytecode
  into `Agentlas.app` after installation and invalidate the signed bundle seal.
- Updater recovery now distinguishes a mutated source-app seal from a genuine
  Developer ID designated-requirement mismatch. The official `Developer ID
  Application: Jeongmin Kim (F469CGM7T5)` lineage remains unchanged.
- Closing, resuming, brain selection, brain connection, starter-team creation,
  concept review, and first-request entry were rechecked through the live
  Electron renderer and Main-process bridge.

## 0.8.59 — 2026-07-20

### Added

- Added a seven-scene One first-run tutorial with beginner, CLI-familiar, and
  expert paths, restart recovery, and a direct first-request handoff.
- Added a mint Las character treatment and a local-device/firewall illustration
  that explains the boundary between a web chat and work performed on the Mac.
- Added an exact pinned starter organization with frontend, backend,
  infrastructure, bug/security, and copy specialists.

### Changed

- AI-provider readiness and limited mode are now owned and revalidated by the
  Desktop main process instead of renderer state.
- Starter-team execution fails closed if a slug, package hash, provider, or
  saved group no longer matches the completed onboarding state.
- The exact onboarding starter releases are checked against the signed-in
  account and local library before execution. The tutorial does not claim an
  invented credit grant or route the user through GitHub payment.
- Keyboard focus, screen-reader status, contrast, localization, sound controls,
  and reduced-motion behavior now cover the complete tutorial flow.
- Agentlas OS v1.1.50 remains pinned at
  `5fc22464c1db33dabc0d4de2170053d1584b5682`. Source readiness does not prove
  that a public Desktop release or update-feed entry exists.

## 0.8.58 — 2026-07-20

### Added

- Agentlas One is now a first-class Desktop experience: one simple conversation
  can turn a request into a structured result while One quietly chooses,
  assembles, and coordinates the smallest useful agent team.
- One keeps approved preferences, reusable experience, measured improvements,
  project knowledge, task logs, and generated-result references in an organized
  local `~/.agentlas/one` workspace without exposing raw private transcripts.
- Proactive briefings surface useful risks, unfinished work, and ready results
  before the user has to know which agent, tool, or workflow to choose.
- Windows packages include a private pinned Node.js runtime so CLI providers can
  be installed from the Connect action even on a new PC without Node or npm.

### Changed

- One results adapt to the work: comparisons, plans, timelines, documents,
  files, media, and evidence render as compact, responsive interfaces instead
  of a developer-oriented event stream.
- The composer starts as a single line, grows naturally through ten lines, and
  then scrolls. System messages, failures, approvals, and follow-up guidance use
  the conversation language and everyday wording.
- One can suggest creating a reusable agent, keeping a recurring team, or
  preparing a privacy-safe Hub derivative only after real repeated use. Nothing
  is published, purchased, or sent outside the device without confirmation.
- Mobile-facing One projections are scoped to the selected paired Desktop so
  conversations and briefings from different computers never mix. This release
  publishes Desktop installers only; mobile store builds are unchanged.

### Fixed

- Hidden implementation details, raw provider errors, internal IDs, risk codes,
  and orchestration vocabulary no longer leak into beginner-facing One screens.
- Sidebar navigation keeps unfinished experimental agent apps out of the public
  surface and gives One a minimal full-width workspace.
- Agent Hub credit metadata no longer competes with agent titles for horizontal
  space.
- One keeps its automatic team policy while preserving the mobile read-boundary
  release check across saved agent-group routes.
- Replies to ordinary in-progress questions remain valid without requiring the
  Task-bound decision fields used only by One approval cards.

Agentlas OS v1.1.50 remains pinned at
5fc22464c1db33dabc0d4de2170053d1584b5682.
These source changes do not themselves publish a Git tag, installer, GitHub
release, or update feed.

## 0.8.55 — 2026-07-17

### Added

- A durable trigger outbox and graph reconciliation store preserve every
  scheduled occurrence, chain event, node checkpoint, and external-effect
  receipt across process restarts.
- Signed packages carry a pinned standalone CPython 3.12 runtime on macOS,
  Windows, and Linux. The release gate launches the packaged binary in an
  isolated environment and verifies the exact Workforce MCP inventory and
  protocol metadata before an installer can be published.

### Changed

- Hub Workforce preparation uses the exact Agentlas OS protocol, immutable
  source commit, complete tool schemas, source scope, account identity, and
  prepared-attempt receipt. Runtime or schema drift is a typed incompatibility,
  never a hidden local or alternate-source fallback.
- Automation outcomes distinguish completed, blocked, awaiting input, partial,
  refused, and failed states. A non-successful run remains enabled and visible;
  repeated errors no longer silently disable the schedule.

### Fixed

- A successful external action such as posting a comment is checkpointed before
  the next node starts. If a later Hub call, verification step, app shutdown, or
  network interruption fails, recovery skips the completed action and resumes
  from the durable receipt instead of posting it again.
- Trigger claims, stale-run recovery, and result commits use transactional
  compare-and-swap state so two schedulers cannot both replay one occurrence.
- Ambiguous external effects fail closed into a visible reconciliation state;
  users can inspect and resolve the exact occurrence without losing the
  automation or its selected session agent.

Agentlas OS v1.1.50 is pinned at
5fc22464c1db33dabc0d4de2170053d1584b5682. These source changes do not themselves publish a Git tag, installer, GitHub release, or update feed.

## 0.8.54 — 2026-07-17

### Changed

- LLM usage snapshots now include each installed CLI's detected and latest
  version. Claude Code, Codex, Gemini CLI, Antigravity, and Grok check their
  authoritative release source and update in the background only while the
  shared execution queue is completely idle. The post-update binary version
  must be re-detected before the update is reported as complete.

### Fixed

- Default `hub-allowed` automations, Site Studio, Telegram, TREX, and existing
  chat sessions no longer get replaced by a fresh global Workforce route.
  Only an explicit `hub-first` policy may pre-empt the selected target.
- CLI maintenance never interrupts an active or queued chat, automation, or
  Workforce run. Pinned unattended read automations also no longer switch to a
  different provider as a hidden fallback.
- Narrow Agent Hub cards move the credit badge below the identity block based
  on the card's own width, preventing long Korean or English names from being
  squeezed or pushed outside the card.
- Codex remains excluded from isolated Workforce leadership until its
  delegation authority can be removed by a measured runtime capability; error
  copy no longer hard-codes an already stale CLI version.

Agentlas OS v1.1.48 remains pinned at
98adf6d1bb0bdad5a919884c3916274d5a3e813f.
These source changes do not themselves publish a Git tag, installer, GitHub
release, or update feed.

## 0.8.53 — 2026-07-17

### Added

- Agent Hub is now a first-class destination in the main navigation, using a
  people-style job-market information architecture. Agents, Teams, and callable
  Hub plugins share one semantic search surface with real
  entity filters, availability state, and a reusable candidate pool.
- MiniMax, xAI, and OpenRouter join the API-provider set. Every BYOK provider
  now discovers model IDs from its live catalog and retains a manual model-ID
  path, so future model generations do not require a Desktop code change.

### Changed

- Session routing keeps the Agents already attached to the conversation. It
  recruits the minimum extra role from Agent Hub or Cloud only when the active
  model identifies a real capability or tool gap; it no longer runs a global
  candidate search for every message.
- The context chip reports the logical size of the history loaded on screen,
  not a fabricated percentage against a fixed 100,000-token denominator.
- Near-white canvas tokens and shared subtle elevation make recessed surfaces
  lighter while keeping the existing Agentlas design system.

### Fixed

- Composer menus, account and credit popovers, project and agent pickers,
  document menus, chat-row actions, file context menus, and the help menu now
  share one outside-pointer and Escape dismissal contract with keyboard focus
  restoration.
- Kimi and DeepSeek now use their OpenAI-compatible chat endpoints instead of
  being sent to obsolete Anthropic-compatible routes. Unknown model capability
  metadata stays unknown instead of being guessed from version-shaped names.

Agentlas OS v1.1.48 is pinned at
98adf6d1bb0bdad5a919884c3916274d5a3e813f. These source changes do not
themselves publish a Git tag, installer, update feed, or GitHub release.

## 0.8.52 — 2026-07-17

### Changed

- The hidden, currently unused Startup Founder Studio UI contract no longer
  blocks signed Desktop releases. Its feature-specific regression remains
  available to run independently while the release gate stays focused on
  shipped, user-visible Desktop surfaces and protocol compatibility.

### Fixed

- Mobile and unattended read-only runs now fall back visibly to an available
  BYOK or Ollama runtime when the Desktop's active CLI runtime lacks the verified
  restricted-read boundary. They still fail closed when no safe runtime is
  connected.

## 0.8.51 — 2026-07-17

### Fixed

- A new Startup Founder Studio idea now queues directly through the already
  authenticated local request bridge. A transient slow manifest response no
  longer tears down a healthy Studio server and loses the idea during a cold
  replacement startup.
- `New Idea` remains unavailable unless the Studio has a live bridge URL, and
  reuse health checks require repeated failure before restarting the server.

## 0.8.50 — 2026-07-17

### Added

- Dashboard Hub search now accepts a natural-language outcome and preserves the
  Hub semantic ranking across public descriptions, capabilities, trigger
  examples, lexical evidence, and embeddings. Recommendation cards show their
  rank and public fit context instead of pretending the agent name was the only
  search signal.

### Fixed

- Compact semantic search rows are enriched from the matching public catalog
  entry before identity deduplication. This removes the duplicate generic
  `Callable Hub agent` / install-only card that appeared beside the real Team or
  Agent card, while preserving legitimate Agent and Team namespaces that share
  a slug.
- Hub usage badges wrap within narrow cards, the Site prompt focus ring is no
  longer clipped by its rounded container, and the Site window header reserves
  the macOS traffic-light region at compact widths.
- The ambiguous `바이브코딩으로` action is now `Build에서 이어서 구현`, with
  an explicit tooltip explaining that the selected project folder receives the
  design revision before Desktop continues in Build.
- Startup Founder Studio now waits until its authenticated local request bridge
  is ready before enabling `New Idea`, preventing a cold-start submission from
  racing the launcher and disappearing before `requests.jsonl` is created.

## 0.8.49 — 2026-07-17

### Added

- A paired Agentlas Mobile client can now preview and privately save a
  registered local Agent or Team to Agent Cloud, preserve local-receipt recovery
  state, distinguish owner-private hard delete from Hub soft unpublish, and list,
  create, or numeric-revision CAS-update owner Cloud combinations from exact Hub
  release references. Cloud refusals retain retry/revision/partial-commit detail.
- A paired Mobile client may request one remote Hephaestus build, but the full
  runner cannot start until the local user approves a native Desktop warning for
  that exact run. Accepted starts are non-replayable, and interview output becomes
  structured `awaiting-input` / `resumable: false` rather than a false success.
  Build events continue to omit local paths, provider sessions, and raw results.

### Fixed

- Desktop now speaks the pinned Agentlas OS v1.1.48 Workforce federation
  contract end to end: every search declares the network scope, the signed
  federation result and source receipts remain intact, and selection plus
  execution are rejected if their lineage no longer matches. The model still
  chooses the team; deterministic code only preserves and verifies evidence.
- The reusable sitemap walker keeps a conservative 5,000-node default while
  Desktop explicitly requests its complete 25,000-node project budget. The
  resulting 13.2MB representative map remains below the dedicated 24MB read
  cap, so release compatibility no longer requires truncating the real map.
- Memory identity classification, background project-ontology ingest, empty
  layer warnings, and the multilingual 256-dimensional embedding fixes from
  0.8.48 are included in this release candidate.
- Firm-backed Teams resolve through their opaque local firm identity for Cloud
  upload, malformed Cloud-combination replies fail closed, and Mobile-triggered
  full-authority builds are single-flight per Desktop behind the local approval
  gate.

Agentlas OS v1.1.48 remains pinned at 98adf6d1bb0bdad5a919884c3916274d5a3e813f.
These sources do not themselves publish a Git tag, installer, or update feed.

## 0.8.48 — 2026-07-16

### Fixed

- Recall layers that were wired but silently accumulating nothing. A stated
  preference or identity fact now loads the schema block that instructs the
  model to file it as user_identity with high confidence (it was being demoted
  to a session note, leaving user_identity at 0 rows). A write-authority chat
  turn now kicks off a background folder-ontology ingest, so the ontology DB
  fills instead of staying empty across projects. The sitemap keeps its complete
  25,000-node default ceiling and injection reads through a dedicated 24MB cap,
  so a large repo's sitemap (13MB here) is injected rather than dropped by the
  2MB text cap. Each layer warns once when it injects nothing.
- Retrieval quality was measured on 468 real memories (79% Korean): Top-1 58.1%
  → 69.4% with the multilingual embedding, and cross-lingual recall went from
  -0.03 (worse than random) to reachable.

Agentlas OS v1.1.48 is pinned at 98adf6d1bb0bdad5a919884c3916274d5a3e813f.
These sources do not themselves publish a Git tag, installer, or update feed release.

## 0.8.47 — 2026-07-16

### Added

- Every completed, failed, or cancelled user turn now records exactly one
  compact Memory Ticket episode. A separate no-tools Curator may propose durable
  candidates, while deterministic privacy, permission, owner, and scope gates
  retain final authority.
- User-global, team, agent, and project memory share one chronological episode
  ledger without allowing one project's local memory into another. Project
  ontology now ingests bounded working-folder files, `.agentlas/ontology-inbox`,
  sitemap structure, and bounded `.agentlas/pm` material through one auditable
  lifecycle.
- Promoted, attested experience relations can influence pre-route agent choice
  only for the exact provider environment or its attested Agentlas Desktop host
  envelope, plus the exact project, content hash, and canonical relation. Graph
  centrality is never treated as query-independent authority.
- Browser now shows a live Agentlas Chrome frame and a read-only Mac screen
  preview with explicit permission state. Click and typing remain disabled until
  an Agentlas-owned signed native driver is available.
- Build mode now scaffolds and verifies the Agentlas OS package contract, then
  offers up to two blocker-targeted repair turns instead of accepting incomplete
  packages as routing-ready.

### Fixed

- Read-only turns keep their central receipt but do not materialize project
  files or durable memory. Firm and task-force planner/worker/synthesis turns
  receive distinct idempotent ticket identities, and global/project timeline
  recall requires the exact canonical project pair.
- Korean and cross-lingual memory recall uses the verified multilingual
  Model2Vec asset with calibrated lexical/vector fusion. The packaged runtime
  rejects missing, reordered, or hash-mismatched tensor parts.
- Browser approval capabilities are isolated per app instance, and the browser
  MCP host is pinned to the reviewed Playwright MCP release instead of resolving
  `latest` at every run. Agentlas no longer borrows another app's private
  Computer Use executable.

Agentlas OS v1.1.48 is pinned at
98adf6d1bb0bdad5a919884c3916274d5a3e813f.
These source changes do not themselves publish a Git tag, installer, update
feed, or GitHub release.

## 0.8.46 — 2026-07-16

### Fixed

- The Mobile pairing QR did not scan unless the camera was perfectly focused.
  The payload carried the full DER certificate — 796 of its 1228 characters —
  which forced a ~101x101 symbol into the pairing card at under half a
  millimetre per module, below what a slightly blurred camera resolves. The
  certificate proved nothing extra: the SHA-256 fingerprint is the complete pin,
  since Mobile hashes the certificate the TLS handshake presents and compares
  it. The payload is now 410 characters, the QR renders at error-correction
  level M rather than the level-L floor it was pinned to only to fit, and the
  bitmap and pairing card are larger. Mobile pins from the fingerprint alone
  with no trust anchor and still cross-checks a certificate when one is sent, so
  the trust model does not change. The certificate remains in the endpoint
  manifest, where the relay uses it as its CA. A contract test asserts the
  certificate cannot return to the QR and that the payload stays under the
  density ceiling; it fails when the certificate is restored.

Agentlas OS v1.1.45 is pinned at 49752a783e944c898ea023705104661b3beb87b2.
These sources do not themselves publish a Git tag, installer, or update feed
release.

## 0.8.45 — 2026-07-16

### Added

- **Structured Workforce decisions get one bounded same-model repair.** If the
  leader omits a required WorkOrder or Selection field, or the frozen-roster
  planner emits an invalid packet/allocation shape, Desktop returns a sanitized
  validation result, the exact schema, and a bounded/redacted prior answer
  marked as untrusted transient data to the same pinned model. A second invalid
  answer fails closed; persistent audit records retain digests and byte counts,
  never raw model output.
- **Hard gaps get at most two LLM-authored job-analysis refinements.** If a
  required slot has fewer eligible candidates than its authored cardinality,
  the same leader may replace the complete WorkOrder using only the previous
  validated redacted order and a candidate-free gap summary. One valid
  `requestExpansionForSlots` decision can use the remaining shared budget and
  re-search; repeated expansion, exhausted budget, or a final shortage fails
  closed before selection validation or execution.
- **Hub attempts and the authoritative chain are receipt-backed.** Exact
  request/response digests, retry decisions, superseded pre-refinement search,
  schema attempts, provisional-selection supersession, and the final immutable
  release chain remain observable through explicit durable transition records.
- **Prepared execution is cryptographically and operationally bound.** Desktop
  accepts only `agentlas.workforce-execution-plan.v5`, recomputes the Core v4
  runtime-bundle digest over the exact selected release, directive bundle,
  permission policy, and direct-agent or nested-team graph, and blocks a
  missing marker, legacy plan, unsupported group, or byte change before the
  planner or workers can start. A row is executable only when its top-level
  bundle contains a nonblank `systemPrompt`, `instructions`, or `agentMd`.
  The shared cross-language domain rejects numbers, non-ASCII object keys,
  recursive `__proto__`/`prototype`/`constructor` keys, lone Unicode surrogates,
  excessive depth, and excessive node counts instead of hashing ambiguous or
  prototype-sensitive JSON.
- **JIT tools are selected semantically and enforced per worker.** Desktop
  inventories only enabled, configuration-valid MCP servers allowed by the
  prepared policy, presents a private slot/release/runtime-scoped menu to the
  top host LLM, and requires exact capability coverage. It never sends that
  inventory to Hub and never reuses lexical auto-routing, wildcard grants, or
  execution history. Each runtime must return its own grant-enforcement proof;
  missing evidence fails closed.
- **Direct and nested execution share a Core v2 receipt.** Direct agents, team
  manager planning, declared graph workers, team synthesis, top synthesis, and
  the structural verifier receive unique invocation identities. Team manager
  plans get one same-model shape repair with no fallback, and the public receipt
  includes only the host-authored capability binding plan plus the private
  inventory digest.

### Changed

- **Leader outputs are direct, closed contracts.** WorkOrder and Selection use
  exact top-level and nested keys. Legacy leader-call envelopes—including the
  observed shape with `name` nested under `arguments`—are rejected as
  `work_order_invalid` or `selection_invalid`; Desktop never moves fields or
  turns model text into an MCP call.
- **Job-family constraints preserve recall without inventing an inverse
  taxonomy.** `requiredRoles` defaults empty, while title/task,
  `optionalCommunities`, and `optionalSkills` carry desired fit. Global and
  per-slot community exclusions are only explicit prohibitions or inherent
  incompatibilities. Exact same-ID positive/negative conflicts are rejected
  without host mutation or hardcoded ontology lineage.
- **Only ambiguous candidate search is replayable.** The read-only,
  deterministic selection-session replace/upsert may repeat the exact request
  once after a post-dispatch outer transport ambiguity. Pre-request setup
  failure, an explicit MCP protocol error, a received malformed tool payload,
  semantic validation failure, `validate_selection`, and `prepare_execution`
  are never retried.
- **Content-only input is closed at the Desktop trust boundary.** CandidateSet
  root, slot, candidate, semantic, operational, and evidence objects must match
  the pinned Core exact-key schema and ontology version. Candidate text is
  explicitly marked untrusted evidence rather than instructions, so injected
  ranking/history fields or agent-authored prompt commands never become valid
  selection inputs.
- **Frozen-roster allocations are exact model decisions.** `schema`, live
  runtime/model IDs, requirements, and at most eight reason codes are required;
  Desktop rejects rather than inserting defaults, trimming, or truncating the
  planner's allocation.
- **Local-model allocation now reflects executable host facts.** Ollama,
  LM Studio, and MLX advertise their detected model IDs with the runner's
  conservative 32k context, no unproved tools or image support, and exact
  `effort=none`. This removes the live Qwen dead end where model detection
  exposed a model but omitted the profile required by the strict planner. A
  duplicate Cursor inventory row was removed as part of the same live-runtime
  audit.
- **Codex 0.144.4 is fail-closed for untrusted and Workforce execution.** An
  actual harmless probe emitted a collaboration tool call even after
  `--disable multi_agent` and every other configurable tool feature was
  disabled. Desktop therefore blocks Codex Agent App, borrowed-package, and
  Workforce turns before CLI discovery or process spawn, excludes Codex from
  the Workforce planner inventory, and never emits the former false
  no-authority enforcement receipt. Ordinary explicitly trusted Codex use is
  unchanged.
- The bundled Core is Agentlas OS v1.1.45 at immutable commit
  49752a783e944c898ea023705104661b3beb87b2. Desktop now consumes Core's exact
  finite coverage-gap enum and shared accepted/rejected vectors, so live Hub
  exclusion classes cross the boundary while unknown or identity-bearing codes
  fail closed. The Workforce ontology remains
  `awo:2026-07-15.2`, raw JSON SHA-256
  `d6d30d45fe8d35fb785e165d1e80c6471a72436f0160c3933c21d4a31bf2fb32`.
- WorkOrder refinements now host-bind only the five already validated immutable
  transaction-envelope fields. The active LLM still authors every staffing,
  handoff, exclusion, and policy decision; envelope echo drift is recorded as
  `hostMutationApplied` plus the exact field-name list and immutable-envelope
  digest instead of consuming a semantic repair attempt.
- Strict Workforce planner prompts now show a parser-valid literal allocation
  from the live runtime inventory instead of pipe-delimited pseudo-values that
  the validator must reject. The model still authors every allocation and
  packet; Desktop never inserts a fallback packet. Benchmark failures retain
  bounded/redacted planner outputs, digests, partial selection artifacts, and
  blocked receipts so routing evidence remains scoreable.
- Independent assurance is encoded by the existing `reviews` relation. The
  leader is instructed to use it for verification/audit separation, and a
  selection that assigns the same immutable release to both ends fails repair
  instead of being deterministically reassigned.

### Verification

- Direct-object and legacy-envelope repair/exhaustion, two hard-gap WorkOrder
  refinements, selection expansion/repeat/exhaustion, shared Core/Desktop
  multilingual digest-v4 vectors and rejected-domain corpus, exact-request search replay and mutation
  no-retry boundaries, strict frozen-roster planning, 79 nested task-force
  checks, release foundation, fresh/stored/corrupt settings migration, top-turn
  auto-routing, TypeScript, production build, actionlint, and updater/release
  contracts pass locally.
- The opt-in live harness records a fixed reasoning benchmark without local
  project data. Terra/Codex proves the pre-spawn isolation block with zero Hub
  calls; Qwen proves same-model WorkOrder generation and authenticated
  `workforce.search_candidates` transport before any later contract gate.
- This source state does not prove a Desktop Git tag, installer, update feed, or
  GitHub release.

## 0.8.44 — 2026-07-16

### Fixed

- **Mobile read authority is now verified across every current execution route.**
  The release gate checks Workforce, exact temporary task forces, saved agent
  groups, Hub borrowed task forces, swarms, firms, and the direct runner as
  distinct source regions instead of relying on one stale occurrence count.
- v0.8.43 stopped in Linux OpenCrab preflight before packaging or public writes
  after the new Workforce route correctly added a seventh restricted-read
  boundary. The corrected contract and every command after that failure pass in
  the same Ubuntu 24.04 x64, Node 22, Electron/Xvfb environment.
- The bundled Core is Agentlas OS v1.1.39 at immutable commit
  cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source state does not prove a
  Git tag, installer, update feed, or GitHub release.

## 0.8.43 — 2026-07-16

### Fixed

- **Linux automation-store verification is now host-independent.** The test
  injects an exact Codex inventory before lazily loading the scheduler, so
  first-run runtime pinning cannot depend on a CLI installed on the runner.
- **The cached-parent deletion race reaches the real scheduler boundary.** Its
  `startGraphRun` interception is installed before the scheduler captures the
  export, proving a deleted automation creates no run, chat, or runtime side
  effect on slow Linux hosts as well as macOS.
- v0.8.41 stopped in Linux OpenCrab preflight before packaging or public writes.
  The failure was reproduced under Ubuntu 24.04 x64 with Node 22; the corrected
  failure point and all remaining Linux security commands passed there. The
  v0.8.42 Workforce source preparation is included in this release rather than
  being published separately.
- The bundled Core is Agentlas OS v1.1.39 at immutable commit
  cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source state does not prove a
  Git tag, installer, update feed, or GitHub release.

## 0.8.42 — 2026-07-16

### Added

- **Fresh installs now send ordinary complex first-turn requests through the
  host-LLM Agent Workforce Ontology path by default.** The top model writes the
  redacted work order, receives the Hub's hard-eligible immutable release menu,
  chooses the roster, and executes planner, distinct workers, synthesis, and a
  structural verifier. Explicit `/hep-network`, `/workforce`, and non-local Hub
  automations continue to enter the same path regardless of the dashboard toggle.
- **Selection and execution remain auditable.** Exact package/content hashes,
  handoffs, selection validation, execution receipts, and benchmark-only
  `agentlas.workforce.benchmark_selection_artifacts` are preserved end to end.

### Changed

- **Work-order hard constraints no longer erase useful legacy Hub profiles.**
  `required*` fields are reserved for non-negotiable catalog evidence. A broad
  required occupational community fixes the job boundary, clearly irrelevant
  communities such as travel are excluded, and title/task plus
  `optionalCommunities`/`optionalSkills` carry semantic fit for the host LLM.
  Controlled role IDs remain no-invention; an imprecise role is left empty.
- The pinned Core ontology is `awo:2026-07-15.2`, raw JSON SHA-256
  `d6d30d45fe8d35fb785e165d1e80c6471a72436f0160c3933c21d4a31bf2fb32`.
  Singular `payment` and general `security` now resolve to their canonical
  engineering communities.

### Safety and compatibility

- Existing stored `networkAuto:true` and `networkAuto:false` values remain
  authoritative. Only a new install or a valid older settings file with no
  Network field receives the ON default; a present corrupt or invalid file fails
  closed to OFF. Historical settings contain no per-field provenance, so this
  release does not rewrite ambiguous legacy `false` values.
- History, popularity, ratings, revenue, silent substitution, stale ontology
  versions, out-of-menu releases, and BYOM digest drift remain excluded or
  fail closed. The retired lexical route is explicit compatibility only.

### Verification

- Workforce selection/execution, 79 nested task-force checks, fresh/stored/corrupt
  settings migration, top-turn auto-routing, Dashboard opt-out UI, Core ontology
  snapshot, three-OS workflow, TypeScript, production build, and updater/release
  contracts pass locally.
- The bundled Core is Agentlas OS v1.1.39 at immutable commit
  cf71b8be1732f249b4d79d66246f7d3c0cd0790f. This source state does not prove
  a Git tag, installer, update feed, or GitHub release.

## 0.8.41 — 2026-07-15

### Fixed

- **Every test that means “current database schema” now reads the single package
  contract.** Twelve ontology, Experience, Memory, Taste, Firm, evolution, and
  bookmark tests no longer copy the old value 65. Historical fixture payloads
  remain 65 where the test intentionally proves upgrade compatibility.
- **Real-login browser failure isolation now matches the product's no-fallback
  rule.** A missing or failed Agentlas Browser is asserted as blocked; the test
  no longer dereferences a Playwright fallback that v0.8.38 deliberately removed.
- **Memory and local-route release tests now enforce the stronger current
  contracts.** Machine-specific agent memory without a bound project is proven
  session-only before Experience intake, and route reconciliation verifies its
  explicit `missing` count instead of comparing the obsolete result shape.
- v0.8.40 reached both macOS and Linux preflights but exposed those two stale
  contracts before packaging. The complete MCP resilience gate, current-schema
  suite, and both previously failing preflight paths now pass locally. No public
  package, feed, or production metadata was written for v0.8.40.
- Agentlas OS v1.1.37 remains pinned at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source does not prove a public
  installer; native updater, signing, and served-byte gates remain authoritative.

## 0.8.40 — 2026-07-15

### Fixed

- **Automation migration verification now follows the canonical package schema
  target instead of a stale literal.** The v64 permission replay still proves
  read/write authority preservation, and now also proves the v66 Hub package pin
  and v67 durable runtime pin columns while comparing `user_version` with
  `agentlasUpdateCompatibility.targetSchemaVersion`.
- v0.8.39 passed the corrected macOS scheduler guard but stopped in the Linux
  OpenCrab preflight because the migration fixture still asserted schema 65.
  No native packages, public release, feeds, or production metadata were
  written. The complete OpenCrab security command sequence now passes locally
  before the v0.8.40 tag.
- Agentlas OS v1.1.37 remains pinned at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source does not prove a public
  installer; native updater, signing, and served-byte gates remain authoritative.

## 0.8.39 — 2026-07-15

### Fixed

- **The release scheduler guard now declares the runtime pin required by the
  production contract.** Its invocation is intentionally mocked and has no host
  runtime inventory; the fixture now pins its test Codex runtime instead of
  accidentally testing the unrelated `pinned-runtime-unavailable` boundary.
- v0.8.38 stopped in macOS preflight before packaging because that stale fixture
  expected an unpinned automation to execute with no detectable runtime. No
  public release, update feed, signed artifact, or production API metadata was
  written. v0.8.39 carries the same product repair with the corrected gate.

### Verification

- Agentlas OS v1.1.37 remains pinned at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7. This source does not prove a public
  installer; native updater, signing, and served-byte gates remain authoritative.

## 0.8.38 — 2026-07-15

### Fixed

- **Scheduled automations now preserve one durable execution identity.** The first
  run pins the exact runtime kind, backend, model, source, long-context setting,
  and effort on the automation row. Later global runtime changes cannot silently
  move a Codex automation to Claude or create a separate provider session.
- **CLI session recovery is fail-closed for unattended work.** Codex and Claude
  emit lifecycle receipts for resume, create, fingerprint change, resume failure,
  and session-store failure. A failed resume no longer clears the record and
  quietly starts a fresh CLI conversation during an automation run. Every run
  also receives a bounded durable capsule containing the prior outcomes.
- **The other-computer `EPERM` loop is classified correctly and its Korean
  workspace instruction is honored.** `작업 루트는 /Users/...` now binds the
  hidden automation chat to that cwd. `EPERM`, `Operation not permitted`, halted
  execution, missing input, and failed tool results cannot be recorded as a
  successful run, so the existing three-failure pause can stop a broken loop.
- **Real-login browser automations cannot drift into a fresh browser profile.**
  Explicit `Agentlas Browser`, CDP, or port 9222 intent outranks the generic
  Reddit/social Computer Use heuristic. Browser mode exposes only the Agentlas
  Browser host and removes the fresh Playwright-profile fallback.
- **Pinned Hub packages now reach the actual single-agent call.** A stored Hub
  `packageHash` is passed to `hepCall --version`; mixed pinned targets are
  resolved independently so one hash is never applied to another package.
- **Nested orchestration keeps the three-level Agentlas hierarchy executable.**
  The top host LLM may compose local, Cloud, and Hub units; packaged Teams retain
  their manager/worker graph; user-created Groups retain their generated
  middle-manager planner. Failed worker packets and conflicting file claims are
  surfaced instead of synthesized as a successful final answer.
- **Release promotion now updates the live Desktop API.** The sole release writer
  overlays immutable current verification tooling and, after stable promotion,
  applies the verified production env through Railway. A separate bounded
  recovery workflow repairs already-published metadata without rebuilding apps.

### Verification

- Automation store, runtime resume, typed result, real-login browser selection,
  borrowed Team/Agent fail-closed, swarm engine, curator nest, task-force memory,
  updater/release contract, and TypeScript gates pass locally.
- The bundled Core remains Agentlas OS v1.1.37 at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7. Source verification does not prove
  a public installer; signed native updater gates and served bytes remain the
  release authority.

## 0.8.37 — 2026-07-15

### Fixed

- **Automatic routing now validates the exact orchestration target before it
  reaches the chat executor.** Local Agent, Team, and Group targets must carry
  their matching `agentId`, `firmId`, or `groupId`; Cloud and Hub Agent/Team
  targets must carry a non-empty slug. A malformed or stale IPC response can no
  longer crash the renderer while reading `entityKind`.
- **The macOS chat-routing QA and shared renderer bridge now implement the same
  required target contract as production.** Korean and English UI runs prove
  that an auto-routed local Agent reaches `invoke:run` as the exact
  `local/agent/agentId` temporary-TF member.

### Boundaries and edge cases

- v0.8.36 passed the Linux security preflight and produced a verified Windows
  artifact, but the stale macOS QA response omitted its required target and the
  atomic release barrier stopped promotion. No partial public release or feed
  update was written; v0.8.37 replaces that unpublished candidate without
  rewriting its immutable tag.
- The bundled Core remains Agentlas OS v1.1.37 at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7.
- This source commit and Core pin combination does not prove a Git tag,
  installer, update feed, or GitHub release. Stable/latest remains blocked
  until every native package, install-lifecycle, and served-byte gate passes.

## 0.8.36 — 2026-07-15

### Fixed

- **The Linux release preflight now recognizes all six restricted-read
  propagation paths.** The new exact temporary-TF path carries the same
  main-owned mobile read boundary as Group, borrowed, swarm, Firm, and direct
  execution; the release contract now verifies that sixth path instead of
  rejecting the secure expansion as an unexpected count.
- **The bundled Core remains Agentlas OS v1.1.37 at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7.** Its verified cross-platform
  Stormbreaker runtime and exact Agent/Team Hub-kind contract are unchanged.

### Boundaries and edge cases

- The source commit and Core pin combination does not prove a Git tag,
  installer, update feed, or GitHub release. All native and served-byte gates
  must pass before stable/latest promotion.
- v0.8.35 reached real CI jobs but its Linux security preflight rejected a
  stale five-path assertion before packaging. It was never promoted; v0.8.36
  supersedes it without mutating the immutable source tag.

## 0.8.35 — 2026-07-15

### Fixed

- **The signed release workflow is valid before any package job starts.** Job
  environment paths now use the workflow-safe workspace context, and the
  Windows/Linux updater identity shell check no longer contains escaped quotes
  that break Bash parsing. All three release workflow definitions pass
  `actionlint` before this source tag is created.
- **The bundled Core is Agentlas OS v1.1.37 at immutable commit
  c86aa86ccb3424e67be0b45ec253cc408af99df7.** Background Stormbreaker child
  runs preserve bounded replans even when a host supplies a reduced argument
  namespace, and promoted Hub stages retain their exact Agent/Team kind.

### Boundaries and edge cases

- The source commit and Core pin combination does not prove a Git tag,
  installer, update feed, or GitHub release. Stable promotion still requires
  every Windows, Linux, signed/notarized macOS, updater-lifecycle, and served
  asset byte gate to pass.
- v0.8.34 was source-tagged but its workflow definition failed before creating
  jobs, so it was never eligible for stable/latest promotion. v0.8.35 replaces
  that unpublished candidate rather than mutating its immutable tag.

## 0.8.34 — 2026-07-15

### Changed

- **Updater repair now begins with the running app's immutable macOS trust
  lineage.** Automatic update work refuses an app that does not satisfy the
  pinned Developer ID, bundle identity, designated requirement, notarization,
  and Gatekeeper checks. A local candidate has its own bundle ID, user-data
  namespace, Keychain service, and disabled update feed, so it cannot share an
  official install identity.
- **Public release promotion now has one writer and an all-platform byte
  barrier.** Windows/Linux package jobs emit only Actions artifacts. The signed
  macOS writer verifies every required artifact and feed locally, uploads the
  full set itself, downloads every staged public asset again, compares its
  bytes and source-bound macOS verification evidence, then and only then can
  set stable/latest. Windows/Linux feeds must also declare the exact generated
  SHA-512 and byte size for every auto-update artifact; a filename-only feed
  cannot pass the barrier.
- **Updater recovery UI is now a CI gate.** The production renderer explicitly
  tests the untrusted-install recovery action in Korean without changing the
  product's English default, and the shared preload mock models Mobile Bridge
  status instead of returning an undefined fallback that can hide UI defects.
- **The release embeds Agentlas OS v1.1.36 at one immutable commit.**
  Package metadata, updater contracts, release workflows, and the three-OS
  harness pin 0cb90fc354d065b9af6894d6570df3de82fb53f6. Exact
  `cloud|hub/agent|team/<slug>` references preserve both scope and entity kind,
  and a Team without a signed executable graph fails before model execution.
- **`/hep-storm` is an executable Desktop swarm boundary.** The chat route
  preserves the raw command, removes only the routing slug from the worker
  goal, binds the Desktop runtime inventory to model/effort allocation, and
  marks a packet failure as blocked rather than presenting synthesized text as
  a completed final gate. The Core harness and Desktop executor contract both
  run before Windows, Linux, and signed-macOS release packaging.
- **The top-level LLM now executes exact Agent, Team, and Group units without
  flattening them.** A temporary TF can mix Cloud, Hub, and Local targets.
  Local Groups run a generated group planner, distinct member turns, and group
  synthesis. Packaged Teams run their signed manager plan, separate worker
  turns, and manager synthesis before returning exactly one result to the
  parent TF. `/hep-network` enters this route-to-execution bridge directly.
- **Registered local Agents and Teams can be uploaded without finding their
  source folders again.** Agent Cloud resolves the selected local identity to
  its authoritative source path in the main process. My Agents manages a Team
  as one owned unit, keeps its orchestrator/member topology intact, and hides
  background eval/judge roles from the ordinary management surface.
- **Normal Desktop turns retain the mandatory, fully local Model2Vec hybrid.**
  No server embedding or per-user API cost is used. Retrieval ranks every
  eligible row before applying the adaptive all-relevant-or-top-k budget, and
  borrowed-agent semantic/governance relations survive projection rebuilds in
  per-agent SQLite nests.

### Boundaries and edge cases

- A local candidate, a source checkout, a package test pass, or a version bump
  cannot become an official macOS install through identity=null, an Apple
  Distribution signature, a QA environment variable, or a copied app bundle.
- The source commit and Core pin combination does not prove a Git tag,
  installer, update feed, or GitHub release. The official release is complete only after
  the reviewed `main` commit passes the native Windows/Linux install-update
  lifecycle, the signed/notarized macOS publication gate, and the served-byte
  update-feed verification.

## 0.8.33 — 2026-07-15

### Fixed

- **The auto-updater no longer quarantines healthy install journals after a
  release grows the protected-table list.** A continuity snapshot is written by
  the previous app version, so schemaVersion 2 validation now accepts the
  snapshot's own self-consistent protected-table set instead of requiring exact
  equality with the running build's `CONTINUITY_CORE_TABLES`. v0.8.32 grew that
  list from 31 to 32 tables, judged every inherited journal corrupt, exited once
  with "Update recovery required", and left automatic updates permanently
  paused behind a same-version corrupt-journal marker.
- **Continuity verification and recovery-copy checks iterate the snapshot's
  recorded tables.** Older journals verify exactly what their writer protected;
  freshly captured snapshots keep protecting the full current list.
  schemaVersion 1 journals keep their frozen historical table set, and
  inconsistent or empty protection maps still fail closed.

### Boundaries and edge cases

- Machines that already ran v0.8.32 hold a corrupt-journal marker stamped with
  that same version, so their updater does not check the feed again on its own.
  Removing `updater/install-journal-corrupt.v1.json` from the app's user-data
  directory and relaunching restores automatic updates without reinstalling.
- v0.8.33 was published as the stable/latest GitHub release after its complete
  Windows, Linux, and signed/notarized macOS asset set passed the release
  barrier. Source changes made after that tag are not part of v0.8.33.

## 0.8.32 — 2026-07-15

### Changed

- **Normal Desktop turns now recall governed context without a manual agent
  command.** `runMcpInvocation` passes the effective user task to owner-scoped
  Memory retrieval on every ordinary turn and automatically selects an eligible
  reviewed Experience overlay for the exact agent, package, project, and runtime
  environment. Restricted Agent App runs remain memory-free, and an exact
  Operational overlay takes precedence over the local Experience overlay.
- **Experience recall now uses a mandatory, fully local Model2Vec hybrid.**
  Desktop persists a 352-dimensional vector made from the verified
  `potion-base-8M` int8 semantic channel (256 dimensions) and deterministic hash
  channel (96 dimensions). It fuses vector and lexical evidence with RRF;
  Desktop uses bounded confidence/relation evidence while the Core nest reader
  keeps salience as a prior. No server embedding or per-user API cost is used.
- **Governed recall now ranks every eligible row before applying the token
  budget.** If all relevant memories fit they are loaded together; otherwise
  the vector/RRF top-k is selected. Privacy-unsafe source classes are rejected
  at curation/Experience capture; superseded, wrong-agent, wrong-project,
  wrong-package, and wrong-environment rows remain filtered before ranking.
- **Semantic and governance relations no longer share authority.**
  `similar_to` is derived from compatible local vectors within one Experience
  Pack. `supersedes` and `contradicts` require an explicit reviewed relation and
  are never inferred from similarity; a target with a valid promoted
  replacement is removed from retrieval before semantic ranking.
- **Borrowed-agent experience is projected into its per-agent SQLite nest.**
  Semantic `similar_to` links and reviewed `supersedes` / `contradicts` edges
  survive projection rebuilds without falling back to whole-file `cat` memory.
  Core queries the nest with its exact `hub:<slug>` identity and an adaptive
  all-relevant-or-top-k budget.
- **Packaged builds verify the model payload before signing or publication.**
  Both builder configurations run the same `afterPack` gate, which requires the
  pinned manifest, tokenizer, MIT license, int8 embeddings, scales, file sizes,
  and SHA-256 content identity to match the embedded Agentlas OS checkout.
- **Desktop now embeds Agentlas OS v1.1.31 at one immutable commit.** Package
  metadata, updater contracts, release workflows, and the three-OS harness pin
  `738b78f40b5efc9b2dd4cc66c94a3805e70c79f5`. The hotfix preserves verified
  Model2Vec bytes on Windows, installs the model during self-update, and repairs
  detected-host memory hooks.
- **The Linux release migration fixture now mirrors the complete v55
  relation-edge shape.** The v65 `similar_to` schema rebuild is therefore
  verified against the real legacy column contract rather than an invalid
  two-column stand-in.

### Boundaries and edge cases

- Embeddings remain local-only and in-process. Hash-96 is an explicit degraded
  fallback if the verified bundled model is absent or invalid, not the normal
  packaged quality path.
- A source checkout, local test pass, or package version does not prove that an
  installer is public. Windows/Linux first stage a prerelease; only the signed
  macOS publisher can verify the complete cross-platform asset set and promote
  it to stable/latest.
- This source version and Core pin do not themselves publish a Git tag,
  installer, update feed, or GitHub release.

## 0.8.30 — 2026-07-15

### Changed

- **Desktop now embeds Agentlas OS v1.1.29 at one immutable commit.** Package
  compatibility metadata, the updater contract, the three-OS Core harness, and
  both release workflows all pin
  `2d161b267c9516699d18d05afcc7ec05d2ba7f09`.
- **External host Builds now share the same post-build portability boundary as
  Desktop.** Claude Code, Codex, Gemini, and Antigravity ask whether to save the
  verified package owner-private in Agent Cloud or keep it only on this
  computer. No answer remains local-only, Cloud failure preserves the local
  result, and public Hub publication is never inferred.
- **Fresh Core interviews default consistently to English.** Korean remains an
  explicit locale and the synchronized host adapters use the same interview
  directive and scoring contract.

### Boundaries and edge cases

- Agent Cloud remains private package storage, not hosted model execution.
  Mobile can use a Cloud-restored package only through a Desktop that restored
  and installed it.
- Desktop v0.8.29 with its immutable Core v1.1.28 bundle remains a valid prior
  release; this patch updates new/offline packages to the current Core without
  rewriting existing local agents or ontology loadouts.

## 0.8.29 — 2026-07-15

### Fixed

- **Release UI checks now follow the language actually rendered by Desktop.**
  Team search, team selection, and hired-agent assertions cover both English
  and Korean instead of assuming a Korean first-run locale.
- **Provider-health visual QA now pins its intended locale explicitly.** Korean
  and English dashboard copy, recovery, provider actions, and retry behavior are
  each exercised in an isolated browser context after English became the
  product default.
- **Mobile relay pairing metadata is covered by the release contract.** The
  authenticated exchange must return the advertised relay endpoint and secret
  without weakening the existing local pairing boundary.
- **The Build Cloud consent contract is now a required release gate.** Signed
  macOS and cross-platform packaging verify that Cloud upload remains explicit,
  private, single-flight, and safely local-only when dismissed.
- **Build roster release QA now completes the new portability decision.** It
  explicitly keeps the verified package local before navigating to Dashboard
  and Agent Cloud, so the modal is tested without masking live roster updates.
- **The embedded runtime boundary remains Agentlas OS v1.1.28.** Canonical
  first-contact still completes before agent work starts, and workload routing
  still introduces no vendor model alias or guessed model table.

## 0.8.25 — 2026-07-15

### Added

- **A completed Build now asks one explicit portability question.** After the
  package passes security verification and is registered locally, Desktop asks
  `Cloud에 올리기` or `로컬에만 저장`. Private Cloud storage is never inferred,
  closing the dialog means local-only, repeated clicks cannot duplicate the
  upload, and public Hub publication remains a separate action. Another
  Desktop must restore and install the package before its paired Mobile can
  invoke it; Agent Cloud storage is not hosted model execution.
- **Agentlas Site can turn an owned agent, team, firm, or saved group into an
  isolated Agent App.** Astryx scaffolding, local preview, verified publishing,
  thumbnails, and local-project deletion now share one Main-owned contract.
  Deleting the local project never implies that a remote deployment was
  deleted; Desktop shows the retained deployment and requires acknowledgement.
- **Agent App creation now reviews system-wide MCPs before scaffolding.** The
  native review makes keyless/key-required state, readiness, and blocked
  declarations visible. Consent belongs to the exact app project and readiness
  snapshot; it is never inferred from an agent package or a stale card.
- **A minimal keyless System Time MCP proves the safe attachment path.** It is a
  Desktop-global MCP, not agent-owned state, and exposes only current-time and
  timezone-conversion tools. Its command, source digest, environment, tool set,
  generated config, and one-run binding are revalidated before dispatch.

### Fixed

- **Paired Mobile reconnects survive an ordinary Desktop restart.** Desktop
  reuses the last secure local endpoint when possible, falls back to a new port
  only when the retained port is already occupied, and can advertise the
  authenticated Cloud relay without weakening local TLS or pairing checks.
  Retry-safe RPC ordering, revocation, and snapshots remain Main-owned; raw
  streamed confirmation fences are no longer exposed as assistant text.
- **Fresh installs now default consistently to English.** Korean remains an
  explicit locale choice, while fallback labels across Build, Oberon, T-Rex,
  receipts, projects, and ownership no longer silently switch a Windows or
  Linux user back to Korean. Platform copy says `this computer` instead of
  naming the developer's Mac.
- **One broken MCP can no longer starve an Agent App.** Decline, missing keys,
  malformed legacy registry rows, connection/config/runtime failure, or
  readiness races remove the affected MCP and continue the app in stateless
  no-tool mode. Unpinned Brave Search remains visible as blocked and cannot
  receive a key or execute until installer provenance is cryptographically
  bound.
- **The built-in System Time MCP no longer executes a mutable file from the
  user profile.** Desktop launches a bounded gzip payload from exact audited
  argv, verifies its source digest before evaluation, and passes Agent Apps a
  compact canonical in-memory config. Legacy global rows migrate in place while
  preserving their id, enabled choice, install time, and bindings. Tampered
  command, payload, transport, URL, environment, wrapper, or config rows fail
  closed to the same no-tool path instead of opening a fallback transport.
- **Packaged Electron code now uses an explicit fuse contract.** Run-as-Node
  remains globally enabled for required workers, whose internal call sites
  exact-gate command and argv; the fuse itself is not path-scoped. Node option
  and inspector injection are disabled. The app entry is restricted to ASAR on
  all targets; Electron's embedded ASAR integrity validation additionally
  covers supported macOS and Windows packages. This does not change the
  existing signing boundary: macOS is signed and notarized; Windows and Linux
  artifacts remain unsigned.
  Moving every worker to a dedicated bundled Node or utility process is still
  required before Run-as-Node can be disabled completely.
- **MCP cards now reflect fresh Main-process state.** A check mark requires both
  durable consent and current readiness; blocked, changed, revoked, and offline
  states remain distinct. Launch respects an existing approval or decline and
  prompts again only after a relevant state change or explicit user review.
- **Active Desktop agents can read existing project memory without mutating it.**
  Canonical root and `.agentlas` identities are bound at activation, and stable
  descriptor reads reject symlinks, non-regular files, oversize inputs, and
  mid-read replacement. A project-identity failure drops only project memory;
  the agent's own global memory remains available. Site, Agent App, and Mobile
  restricted runs still receive no project memory.
- **Model allocation uses exact host evidence instead of guessed capacity.**
  Codex inventory parsing now binds per-model effective context, tool/image
  support, and supported reasoning levels; unsupported `max` requests clamp to
  the highest real level. Builder, task-force, firm, and swarm receipts are
  reconciled with the effort actually sent by Codex and contain no prompt,
  hidden rationale, path, account, or secret data.
- **Project Foundation promotion is fail-closed.** Agentlas OS v1.1.28
  first-contact must return the complete merge-only/privacy receipt before
  Desktop marks a folder active. This does not introduce a vendor model alias or
  deterministic model table. The fallback is limited to a genuinely
  absent Core/Python runtime; lock contention, partial receipts, and unsafe
  `.gitignore` state are not treated as success.

### Boundaries and edge cases

- Existing activated folders without the new filesystem identity stay safe but
  omit project-local memory until the next authorized writable contact or an
  explicit activation refreshes the binding.
- Agent App MCP execution is intentionally limited to the audited System Time
  server in this candidate. Other declarations remain visible but blocked.
- Internal plans, QA receipts, and private screenshots are now ignored; the
  public documentation allowlist remains tracked.
- A private Cloud save failure never rolls back the verified local package.
  Login, offline, security, quota, or revision errors remain visible and
  retryable; Desktop does not fall back to a public Hub upload.

## 0.8.24 — 2026-07-14

### Fixed

- **Desktop now embeds the same Agentlas OS v1.1.28 first-contact contract as
  Terminal and every plugin surface.** Codex, Claude Code, MCP, Network, owner
  Cloud, and Storm contacts synchronously install the Core-owned project soul,
  memory map, code map, ontology, Career Graph, and complete `.agentlas/`
  privacy block before agent work starts.
- **Existing project contracts remain merge-only.** Desktop never rewrites Git
  index state or removes intentionally tracked public `.agentlas` contracts;
  it reports those paths while keeping newly generated local memory ignored.
- **Workload allocation remains host-driven and non-deterministic.** No vendor
  model alias or tier-to-model mapping was added; the parent AI selects an exact
  live-advertised model ID and Desktop only validates the choice.

## 0.8.23 — 2026-07-14

### Fixed

- **The canonical first contact path now completes on Windows through
  Agentlas OS v1.1.27.** Windows ACLs no longer surface as false POSIX permission
  failures, so Desktop keeps the same Core-owned project soul, memory, code
  map, ontology, Career Graph, and privacy-first `.gitignore` contract on all
  three desktop operating systems.
- **The live-verified workload boundary still contains no vendor model aliases
  or tier-to-model mappings.** The parent AI supplies an exact advertised ID;
  Desktop validates inventory, capability, context, cost, and explicit pins.

## 0.8.22 — 2026-07-14

### Fixed

- **The release gate now verifies the new first contact contract instead of the
  retired visit threshold.** The first writable Desktop contact must create the
  canonical Agentlas OS v1.1.25 project architecture and privacy block
  immediately; later read-only turns must neither create a project nor record
  another writable visit.
- **The live-verified workload boundary remains enforced.** Parent AIs select
  exact model IDs from runtime inventory without vendor model aliases or
  tier-to-model mappings, while Desktop validates capabilities, context, cost,
  and explicit pins.

## 0.8.21 — 2026-07-14

### Added

- **Every writable folder gets the canonical Agentlas project architecture on
  first contact.** Desktop calls Agentlas OS v1.1.25 instead of maintaining a
  second initializer, so the project soul, memory map, code map, ontology,
  Career Graph, and privacy-first `.gitignore` are identical to Terminal,
  Claude Code, Codex, Network, Cloud, and Storm. Existing files remain
  merge-only and are never overwritten.

### Fixed

- **Workload allocation no longer embeds vendor model aliases or tier-to-model
  mappings.** The parent AI receives only live-verified model IDs and must pick
  an exact advertised ID. Desktop validates that choice and explicit pins,
  then preserves the active model when the choice is missing or stale.
- **Static picker catalogs are no longer treated as executable allocation
  inventory.** Claude Code and BYOK advertise only the active verified model;
  Codex, Grok, and Ollama expose models returned by their live discovery paths.

## 0.8.20 — 2026-07-14

### Fixed

- **Running the embedded Agentlas OS can no longer invalidate the signed app.**
  Every production Python launch now forces bytecode writes off after caller
  environment merging and points the defensive cache prefix at Agentlas
  `userData`, outside the signed `Resources` tree. The release gate executes a
  synthetic Agentlas OS package from a bundle-shaped fixture and fails if any
  `__pycache__` or `.pyc` appears below `Resources`. The signed macOS pipeline
  also imports the packaged bridge, runs the real embedded Stormbreaker harness,
  and repeats `codesign --verify --deep --strict` on that exact `.app` before
  notarized artifacts can publish.
- **The embedded Agentlas OS pin is current again.** Desktop compatibility,
  macOS signing, Windows/Linux packaging, and the embedded-runtime gates now
  agree on Agentlas OS v1.1.23. This includes the v1.1.22/v1.1.23 Windows
  Stormbreaker and native harness corrections instead of continuing to package
  v1.1.21. The mutable tag is also bound to exact commit `d121a703`, so a moved
  tag or a second-fetch mismatch fails before packaging. Ignored `.env`, key,
  signing, credential, local-memory, and ontology-runtime files can no longer
  bypass that Git pin: the source guard rejects them, both builder configs deny
  them, and `afterPack` fails closed if any reaches the public app Resources.

## 0.8.19 — 2026-07-14

### Included

- **The complete 0.8.18 Memory-boundary repair ships in this replacement
  release.** The 0.8.18 Linux candidate passed and staged correctly, but the
  Windows release runner remained alive after its new Mobile security tests.
  The prerelease was never promoted to stable/latest.

### Fixed

- **Windows Mobile security gates terminate deterministically.** Both new
  Electron fixtures close their native SQLite handle before deleting the temp
  store, retry Windows filesystem cleanup, and always call `app.exit` even when
  cleanup reports an error. This prevents a passing test from waiting until the
  release job timeout because Windows still owns `agentlas.sqlite`.
- **A future Windows gate hang now fails fast.** The runtime/Mobile contract
  step has a 15-minute ceiling inside the existing 45-minute package job, so a
  single leaked fixture cannot consume the entire release window or leave the
  signed macOS publisher waiting indefinitely for a missing Windows asset.

## 0.8.18 — 2026-07-14 (withdrawn Windows CI candidate; never stable)

### Included

- **The complete 0.8.17 security and provider-health changes ship in this
  replacement release.** The 0.8.17 source tag failed its Experience Ontology
  release gate before signing, notarization, packaging, or public publication,
  so the public stable channel remained on 0.8.15.

### Fixed

- **Interactive Desktop firm chats learn again in `read` mode.** The Mobile
  security work accidentally treated every firm `read` as an unattended
  restricted run and skipped the agent's private Memory/Experience curation.
  Desktop read chats now retain attributable agent experience in the private
  database, while project-local `.agentlas` files still require `write` or
  `full` permission.
- **Restricted and borrowed runs retain the intended privacy boundary.** Mobile
  and unattended read runs strip model-emitted Memory controls and write only
  content-free audit counts. Borrowed synthesis uses its effective runtime
  permission; read-only synthesis cannot create project memory files or claim
  a participant's experience, while write-capable project work keeps its
  existing scoped curation behavior.
- **The release gate now tests both sides of the boundary.** It requires normal
  Desktop firm reads to create attributable durable learning and restricted
  firm reads to remain ephemeral with Memory control blocks removed from UI
  output.

## 0.8.17 — 2026-07-14 (failed release candidate; never published)

### Security

- **Mobile remote execution is read-only in this replacement release.** A phone
  can start and steer chats, but `write` and `full` are rejected before a run is
  created. Write-capable work must be approved and started on Desktop.
- **The working folder is a main-process capability, not a Mobile parameter.**
  Desktop captures the existing chat folder's canonical path and filesystem
  identity, carries that immutable binding through start and queued steering,
  and revalidates it before every runner. Folder clearing, replacement, prompt
  path injection, and mutable chat/project races fail closed.
- **Mobile read runs use only runtimes with a proven non-mutating boundary.**
  BYOK and Ollama receive text/images over their model protocols and remain
  available. Codex, Claude Code, Gemini/Antigravity, and Grok fail closed for
  Mobile and unattended reads on every platform until a release-gated host-file
  denial proof exists for those local CLI runtimes.
- **Restricted read-mode is explicit about its current limit.** BYOK/Ollama can
  answer from the text, curated context, and images Agentlas sends, but cannot
  open arbitrary local project files. The system prompt forbids invented file
  inspection and asks for the needed content to be pasted or attached.
- **Restricted reads do not inherit local power.** User/project dotenv values,
  unrelated vault secrets, local CLI config, rules, skills, plugins, MCPs,
  CLI-owned memory, and browser/computer-use features are not injected into the
  runner or model context. A selected BYOK provider key is used only by Main as
  the HTTP transport credential and is never prompt content. Agentlas may supply
  its curated read context, but model-emitted memory blocks are stripped and no
  Memory, Experience, or Ontology mutation occurs; only content-free audit
  counts remain.
- **Automation authority is durable.** Schema 64 stores each Automation as
  `read` or `write`; the scheduler, workflow graph, and failure optimizer retain
  that exact permission. Legacy and normal Desktop-created Automations remain
  explicit `write`, while malformed or forbidden `full` values fail closed to
  `read`.

### Fixed

- **A complete usage-snapshot IPC failure is visible and recoverable.** The
  Dashboard shows a concise load error with an accessible retry action instead
  of silently leaving the LLM usage panel looking empty. Provider-specific
  contracts remain honest: Antigravity exposes no counter, and Grok exposes
  only a confirmed 402 exhaustion state rather than an invented percentage.
- **Gemini and Grok provider state no longer goes stale or races.** Gemini's
  retired official client switches once to the installed Antigravity CLI;
  Grok's real 402 balance exhaustion remains a provider error, not a fake usage
  window. Provider retry is allowlisted, single-flight, cooldown-bound, and
  guarded against out-of-order snapshots. A stale receipt cannot hide a newly
  installed CLI, and raw provider errors never cross into the renderer.
- **Creating a Mobile chat binds its selected project before the first run.**
  Desktop resolves and verifies the host-owned project folder immediately;
  unavailable or replaced folders fail before a chat row is created, while an
  explicitly global chat stays unbound.
- **Interactive agent-group chats keep the user's selected runtime.** The
  stronger restricted-read profile is derived only for Mobile and unattended
  read Automations, not from the chat's `division` shape alone.
- **Codex write mode now stays inside its workspace sandbox.** New and resumed
  Codex runs map `write` to `workspace-write` and reassert the sandbox on resume.
  Only an explicitly approved Desktop `full` run may bypass the sandbox.
- **A partial cross-platform upload can no longer become `latest`.** Windows and
  Linux assets stage as a prerelease; stable/latest promotion occurs only after
  the signed and notarized macOS publisher verifies the complete required asset
  set. Missing assets or timeout leave the release non-stable.

## 0.8.16 — 2026-07-13 (withdrawn security candidate; never stable)

- Windows and Linux candidate assets are retained only as audit evidence. The
  signed macOS workflow was cancelled before certificate restore, signing,
  notarization, packaging, or publication; no 0.8.16 Mac asset exists.
- The candidate was withdrawn after review found that a read chat could emit an
  Automation block which was persisted as an enabled write-capable scheduled
  run. 0.8.17 replaces the candidate with a read-only Mobile boundary and a
  durable per-Automation execution permission.

## 0.8.15 — 2026-07-13

### Included

- **The Mobile composer parity work from the unpublished 0.8.14 release
  candidate ships here.** The public 0.8.15 artifacts include its authenticated
  Desktop composer bridge, while keeping secrets and absolute paths inside the
  Desktop main-process boundary.

### Fixed

- **Packaged Stormbreaker now uses the same Agentlas OS contract as source and CI.**
  Desktop bundles Agentlas OS v1.1.21, derives the local engine default from the
  package compatibility contract, and executes the real embedded Goal + UltraCode
  harness before any release can package or publish.

- **Gemini chat recovers instead of dying on a retired client or a damaged OAuth file.**
  Agentlas safely backs up and repairs recoverable trailing bytes in Gemini credentials,
  recognizes Google's `UNSUPPORTED_CLIENT` response, and switches once to an installed
  Antigravity runtime using its real headless prompt contract. The Dashboard states
  plainly that Antigravity works while subscription usage is not exposed.
- **Grok balance exhaustion is no longer mislabeled as a healthy connection.** Actual
  HTTP 402 inference failures become a concise chat error and a red 100% exhausted
  Dashboard window with a link to Grok Settings. Agentlas does not invent a reset time
  or scrape private account pages when the CLI provides neither.

## 0.8.14 — 2026-07-13 (release candidate only; not published)

### Added

- **Agentlas Mobile can remotely use the complete Desktop chat composer.**
  Authenticated phones can select runtimes, models and effort, set run
  permissions, use Plan, Goal and Apps, attach images, switch agents, bind Hub
  agents, enable continuous or Swarm execution, preview automatic routing, and
  manage conversation context through the same main-process authority as the
  Desktop UI.
- **Existing chats can switch working location from Mobile.** A phone may bind
  a chat to an existing Desktop project folder or return it to global chat;
  only the folder basename crosses the bridge and absolute paths remain local.

### Security

- Mobile composer actions remain on the strict RPC allowlist with replay
  protection, bounded images, callable-Hub validation, active-run guards, and
  secret-free projections.

## 0.8.13 — 2026-07-13

### Added

- **Experience and Taste are agent-scoped assets instead of hidden chat
  history.** My Agents shows curated memory, candidate collection, privacy
  blocks, exact Experience/Taste releases, loadout state, and a 3D relation map
  for each installed agent.
- **Ontology Chips keep an independent ownership and attachment lifecycle.** A
  base agent and a chip retain separate release IDs and entitlements; purchase
  never auto-attaches, and an exact compatible release requires an explicit
  next-session decision.
- **Desktop, Terminal, Web/Hub, and Mobile share privacy-safe contracts.** Raw
  prompts, transcripts, credentials, local paths, private media, and base-agent
  package bytes are excluded from portable chip assets and Mobile projections.

### Changed

- Existing local memory and historical chat-linked activity are surfaced
  without retroactively claiming they were verified Experience or final-agent
  execution evidence.

## 0.8.5 — 2026-07-12

### Fixed

- **Oberon shows the real connection state for every image and video engine.**
  The main-process status API now probes the full provider catalog instead of
  returning only the three globally selected providers, so an OAuth-ready Grok
  image/video stack is labeled connected rather than login required.

## 0.8.4 — 2026-07-12

### Fixed

- **Oberon now uses Grok Imagine for the selected cut-image and video engines.**
  Grok-generated keyframes flow into image-to-video rendering and the existing
  clip assembly/delivery pipeline instead of being relabeled as Codex or blocked
  behind the Veo-only renderer.
- **Grok CLI 0.2.93 media jobs start reliably without widening host access.**
  The broken headless tool allowlist is replaced by the strict OS sandbox plus
  explicit shell/edit denials, while prompt files, session harvesting, cleanup,
  OAuth-only subscription billing, and unrelated-secret isolation remain gated.

## 0.8.3 — 2026-07-12

### Added

- **채팅 실행이 Claude Code 데스크탑처럼 살아 움직입니다.** ✳ 글리프 스피너
  상태줄이 경과 시간·라이브 토큰 수·생각 문구("생각 중…"→"아직 생각 중…"→
  "더 생각 중…"→"거의 다 생각했어요…", 종료 후 "N초 동안 생각함")를 실시간으로
  보여주고, 도구 실행은 본문 문단 사이에 "읽는 중 ›" 라이브 라벨 →
  "실행됨 명령 N개, 읽기 파일 N개 ›" 접힘 요약으로 끼워집니다. 행을 클릭하면
  읽은 파일이 우측 파일 뷰어로 열립니다.
- **질문 시트가 영상 UX로 다듬어졌습니다.** 제출 ↵ 버튼, 기타 숫자키 포커스,
  답변 후 질문+답 인용 카드(원문 스캐폴드 버블은 숨김, 재로드 시 질문별 답 복원).
- **메시지 호버 액션** — 복사 아이콘 + 읽어주기(TTS).

### Fixed

- **완료 순간 중간 해설이 사라지던 문제.** claude CLI의 result가 마지막 메시지만
  담아 스트리밍 전사본을 덮어쓰던 것을 전사본 우선으로 수정했습니다.
- codex 도구 행 중복(command_execution 완료 미인식), 모델 팝오버가 트리거
  반대편에 열리던 문제, 실행 중 채팅 재진입 시 경과 시간이 0초부터 다시 세던
  문제를 함께 수정했습니다.

## 0.8.1 — 2026-07-12

### Fixed

- **Grok Imagine is visible again in multimodal settings.** The image and
  video choices reuse the existing official Grok CLI/OAuth media boundary and
  remain explicit selections, so the automatic provider order is unchanged.
- **The catalog regression is release-gated.** OAuth readiness, provider
  round-tripping, and the built Settings UI now verify both Grok entries.

## 0.7.46 — 2026-07-12

### Fixed

- **The live Hub status regression gate is deterministic on hosted Linux.**
  Normal loopback catalog responses use a CI-safe deadline, while the dedicated
  slow-endpoint case still proves that production readiness checks remain
  bounded well below the 15-second catalog request timeout.

## 0.7.45 — 2026-07-12

### Fixed

- **The v0.7.44 mobile and studio work now ships with the full production
  stabilization line.** Browser scrolling/profile ownership, durable drafts,
  chat routing, updater continuity, Electron 43, and the signed-release gates
  from v0.7.43 are integrated instead of being silently rolled back by the
  parallel release history.
- **Dashboard readiness reports real evidence.** Agentlas OS reads the active
  runtime `RELEASE`/manifest version instead of showing Python, CLI versions are
  parsed across Claude/Codex/Gemini/Grok output formats, and an explicit full
  check bypasses stale runtime caches.
- **Hub status no longer treats a five-minute catalog cache as a live
  connection.** Bounded, single-flight catalog probes distinguish live,
  partial, cached, and offline states without unrelated Firm/Bundle failures
  overwriting the Dashboard result.
- **Unverified Grok media stays fail-closed.** The official Grok CLI remains a
  supported text runtime, while image/video options stay hidden until the CLI
  exposes a verifiable production capability.
- **Release identity is now atomic.** Tag, `package.json`, both package-lock
  version fields, embedded Agentlas OS, update compatibility, and
  `HEPHAESTUS_REF` must agree before any platform can publish.

## 0.7.44 — 2026-07-12

### Added

- **Desktop-to-mobile pairing foundations** add a local TLS bridge, scoped
  device authority, replay protection, sanitized projections, and Settings QR
  management without moving the LLM runtime to Agentlas Cloud.
- **T-rex and Oberon generation paths** gain stronger active-runtime routing
  and preserve the supported Grok text model stack.

## 0.7.43 — 2026-07-12

### Fixed

- **Chat routing QA is locale-independent.** Stable mode, stop-state, gate, and
  destination-page contracts now verify Find agent and cancellation flows in
  Korean and English without relying on translated button text.

## 0.7.42 — 2026-07-12

### Fixed

- **Chat routing QA matches clean-device inventory.** Keyboard-to-pointer
  autocomplete selection is verified with the agents actually present, rather
  than depending on an unrelated third local item.

## 0.7.41 — 2026-07-12

### Fixed

- **Prompts retry QA waits for the destination document.** The retained-prompt
  assertion now waits for the new chat execution context, removing a clean-mac
  navigation race without weakening the product contract.

## 0.7.40 — 2026-07-12

### Fixed

- **Cross-platform release gates follow Electron 43's install contract.** Linux
  CI installs the lazy Electron platform binary before configuring the SUID
  sandbox helper, and fails closed instead of bypassing Chromium's sandbox.
- **Startup Studio UI QA is locale-independent.** The new-idea handoff is
  verified on clean English CI runners as well as Korean dogfood machines.

## 0.7.39 — 2026-07-11

### Added

- **Oberon opens as a production console, not a marketing hero.** Seven real
  production gates, execution boundaries, saved local projects, and one clear
  start action replace the decorative demo surface. T-rex gains source-safe
  attachments, resilient AI content generation, and select-to-edit.
- **Official xAI Grok CLI is available as a text runtime.** Agentlas uses the
  official OAuth-capable CLI contract, keeps prompts out of process arguments,
  and parses streaming output without exposing private thought events.

### Fixed

- **Dashboard LLM connections stay visible above the fold.** A stale collapsed
  preference can no longer hide the connection and usage panel.
- **Browser explanations reflow and scroll correctly.** Long structured
  explanations remain readable in narrow windows, and the browser surface
  accepts normal wheel scrolling.
- **Draft and retry paths preserve user work.** Document Studio restores local
  drafts, Prompt Store retains failed starts for retry, Settings isolates
  partial provider failures, and Startup Studio receives the idea entered on
  launch.
- **Chat no longer waits on unrelated metadata.** A slow Hub, MCP, generated-App,
  or Keychain/env read cannot leave a valid local agent chat disabled, and a
  delayed agent switch cannot undo a newer auto-routing choice.
- **Telegram and updater transitions are bounded and recoverable.** Telegram
  requests have finite deadlines and binding creation compensates Keychain/DB
  failures; accepted Windows updates relaunch the app explicitly.
- **Grok media is fail-closed.** The installed official CLI does not expose a
  verifiable image/video capability, so T-rex, Oberon, and multimodal settings
  no longer advertise Grok Imagine as ready. Grok text chat remains available.
- **Desktop and Terminal keep an explicit product boundary.** Documentation and
  regression gates point to the independent Agentlas Terminal repository
  instead of the removed Desktop CLI mirror.
- **The packaged shell is back on a supported security line.** Electron moves
  from the end-of-life 33 line to 43.1.0, the packaging toolchain moves to
  26.15.6, the SQLite binding moves to its Node 24-compatible line, and PostCSS
  is pinned above the current escaping advisory.

## 0.7.34 — 2026-07-11

### Added

- **Hub bookmarks now follow the signed-in Agentlas workspace.** Desktop keeps an
  account-scoped local cache and offline outbox while the Web bookmark API remains
  canonical. Fresh snapshots propagate immediately to Dashboard, the organization
  tree, Marketplace, Agent Groups, and Chat without waiting for a remount or polling.

### Fixed

- **Hub calls fail closed against live authority.** A bookmark, stale registry row,
  refused bundle, empty response, or partial task force can no longer be presented or
  executed as a generic borrowed expert. Explicit borrowed agents and saved groups are
  revalidated on every invocation, and remote package instructions stay in user input
  rather than being promoted to a system prompt.
- **Long automations keep an owned, recoverable lease.** Active runs renew their lease,
  persist throttled progress, stop when ownership is lost, and recover only after more
  than four hours of real silence. Removing an automation now removes its run
  projections atomically; the v52 migration clears historical orphan rows and closes
  abandoned running snapshots without touching live work.
- **Updates capture continuity only after mutable background work settles.** New
  automation dispatch and Hub bookmark sync are fenced and drained before the updater
  snapshots the database. Cancelled or failed installs resume those writers; accepted
  installs keep them quiesced through restart.
- **Release jobs use exact tagged source and narrowly scoped credentials.** Manual and
  tag releases validate strict SemVer, require `HEAD` to match the tag commit, disable
  persisted checkout credentials, keep signing/Railway/publish secrets on only the
  steps that need them, and use the dedicated cross-repository release token.
- **Pre-mobile production regressions are executable gates.** v52/v53 migrations,
  bookmark account switching, automation lease loss, updater continuity, borrowed Hub
  refusal, child-process `EPIPE`, browser ownership/scroll, Build registration, and
  renderer roster readiness run before signed packaging.

## 0.7.33 — 2026-07-11

### Added

- **Site Studio now keeps a durable design conversation.** Generate, inspect,
  select, revise, and version screens with live user-facing feedback, then hand
  an immutable design revision into Build without overwriting an active build.
- **Agent Trust readiness is visible on Dashboard.** The runtime panel reports
  the actual local engine, host runtimes, Cloud session, and Hub callability
  boundaries without presenting package security grades as creator reputation.

### Fixed

- **A successful Build becomes a local asset immediately.** Registration no
  longer waits on a second unbounded LLM classification. A passed package is
  committed to the installed-agent registry and, for teams, its firm and org in
  one transaction; Dashboard, My Agents, and Chat reconcile without reload in
  both fast and delayed completion paths.
- **Agent names are not mistaken for hidden system workers.** User-owned agents
  named “Orchestrator”, “App Builder”, “Packager”, or “Governance” follow the
  explicit visibility field. Background built-ins remain hidden.
- **Re-import and security transitions stay consistent.** Concurrent automatic
  and manual imports are single-flight, stale Build completions cannot mutate a
  newer session, a passed re-scan resumes registration once, route rollback is
  atomic, and team-to-single changes remove obsolete organization projections.
- **Chat reset is an atomic context reset.** `/clear` removes messages and every
  local runtime resume pointer together, rejects active runs, invalidates stale
  recap/steering state, and keeps the approved working folder. Completed run
  receipts collapse while failed or interrupted receipts remain open.
- **Site and T-rex state survive real product transitions.** Site transcripts
  use atomic replacement and surface corruption instead of overwriting it;
  project operations remain locked across page remounts; T-rex labels and model
  choices follow the selected language.
- **Signed release gates cover the new contracts.** macOS release CI now blocks
  on local import, Build roster synchronization, Site Studio durability, Chat
  reset, T-rex locale, automation watchdog, browser ownership, Hub bookmark,
  and Runtime Readiness regressions.

## 0.7.32 — 2026-07-11

### Fixed

- **Automation timeouts distinguish a hang from a long tool.** An idle runner still
  stops after 480 seconds without events, while a known active tool gets a separate
  1,200-second silence budget. This keeps genuine hangs visible without aborting a
  healthy build, render, or browser action merely because the tool emits no interim
  semantic events.
- **Closed child pipes no longer crash the Electron main process.** Runtime prompt
  delivery, Document Studio, T-rex, and the generated Browser MCP launcher now guard
  early child exit and late stdin/stdout writes, including asynchronous `EPIPE`.
- **Hub bookmarks stay callable in Chat immediately.** A delayed mount-time bookmark
  snapshot or transient IPC read failure can no longer erase a bookmark event from
  the `@` autocomplete list.

## 0.7.31 — 2026-07-11

### Fixed

- **Reliable dedicated-browser login handoff.** Agentlas now settles transient
  macOS process snapshots before classifying CDP port 9222, shares concurrent
  ownership checks, serializes login-window requests, and only calls a listener
  “external” after a persistent verified mismatch. Uncertain and foreign states
  remain fail-closed; the immediate local error keeps the precise failure while
  durable activity logs store only credential-safe reason codes. Legacy browser
  rows containing URL userinfo are removed or redacted before they reach the UI.
- **Browser screen interaction.** Sign-in buttons expose a pending state and
  reject duplicate clicks. The add-site dialog owns its scroll area on short or
  zoomed windows, while the main Browser screen keeps native wheel behavior.
- **Compatible dependency security patches.** Updates the locked Hono, Next.js,
  form-data, shell-quote, js-yaml, and temporary-file packages within their
  existing supported ranges, removing the critical audit findings without a
  forced Electron or packaging-stack major upgrade.

## 0.7.28 — 2026-07-10

### Added

- **Current Codex/GPT model discovery.** Desktop reads the models exposed by the
  signed-in Codex runtime—including current GPT family previews—then preserves
  the chosen model and provider across refreshes without inventing unavailable
  choices.
- **Durable agent and project boundaries.** New run identities, project-scoped
  memory selection, filesystem capabilities, and recovery metadata keep agent
  work portable without leaking one project, task force, or secret into another.

### Fixed

- **Browser actions fail closed.** Payment and unsafe-code actions can no longer
  bypass explicit approval when the approval surface is unavailable. Browser
  passwords are never captured, personal Chrome profiles are never copied, and
  failed legacy Keychain cleanup stays visible and retryable.
- **Safe file access.** File reads require a picker, drop, project, or workspace
  grant; real-path containment blocks traversal and symlink escapes, including
  local media URLs.
- **Data-preserving database repair.** Orphaned chats with messages, run history,
  custom titles, or prior use are recovered under private placeholder agents;
  only truly empty generated shells are removed. Foreign-key integrity remains
  clean after migration and restart.
- **Reliable updates and automation.** SemVer precedence, signed DMG continuity,
  staged replacement/rollback, bounded downloads, finite scheduler settings,
  leases, watchdogs, and visible failure feedback replace silent or unsafe paths.
- **Chat and generated-app UX.** Empty-state guidance, attachment errors, drag
  feedback, copy confirmation, scroll handoff, IME-safe submission, steering,
  single-stop behavior, and generated-app routing now match the actual desktop
  bridge on light, dark, desktop, and compact layouts.
- **Build and borrow continuity.** Builder interviews survive cancel/failure,
  borrowed task-force memory stays scoped, generated apps remain callable from
  chat, and the mock bridge is checked against all 288 preload methods.
- **Hephaestus v1.1.12 embedded.** Desktop release jobs pin the digest-verified,
  rollback-safe Agent OS runtime used by Codex, Claude Code, Gemini, and other
  supported hosts.

## 0.7.27 — 2026-07-10

### Added

- **Current CLI model choices.** Adds friendly labels for Claude Fable 5,
  GPT-5.6 Sol/Terra/Luna previews, and Grok 4.5 when the corresponding runtime
  makes those models available.

### Fixed

- **Model pickers follow the signed-in CLI.** A non-empty discovered model list
  is now the source of truth; the built-in catalog supplies labels and tags, and
  is used as a fallback only when discovery is unavailable. This prevents a
  model such as Grok 4.5 from appearing before the installed CLI advertises it.
- **Codex model selection survives runtime refresh.** The saved Codex model is
  restored into runtime state and its choices remain available after detection.

## 0.7.22 — 2026-07-08

### Fixed

- **Stall watchdog for automations.** Runs that hang mid-way (process alive, no runner
  events) previously showed nothing until the 30-minute node timeout. Both the legacy and
  graph paths now auto-abort after 8 minutes of event silence (configurable via
  `AGENTLAS_AUTOMATION_STALL_MS`), which routes the run into the failure feedback +
  Runtime Doctor path immediately.
- **Teams actually appear in the agent picker.** 0.7.20 fixed the page-level filter but
  the picker component re-filtered teams out internally — team entries were still missing
  from the top-left picker and its search. The internal re-filter now keeps teams;
  callers decide inclusion.
- **Teams appear in the sidebar agent list.** The left sidebar filtered out team
  (multi-agent) entities entirely, leaving users who mostly install teams with an
  empty-looking agent list.

## 0.7.21 — 2026-07-08

### Fixed

- **Automations no longer fail silently or retry forever.** Every failed run now posts
  the failure reason into the automation's chat as a system message. Three consecutive
  failures auto-pause the automation (with an OS notification) instead of re-running the
  same prompt on every schedule tick.
- **Runtime Doctor: poisoned runtime plugin configs are auto-repaired.** A codex CLI
  update silently auto-enabled curated plugins (e.g. Notion) whose unauthenticated OAuth
  remote MCP servers made every codex run die with `AuthRequired` fatals / exit 1 —
  killing all automations for users who never touched those services. The new
  deterministic Runtime Doctor matches the failing host from stderr against the plugin
  cache and disables exactly that plugin (with a config backup), then the automation
  retries on its next slot.
- **System Optimizer second-tier diagnosis.** Repeated failures the Doctor cannot
  classify trigger a one-shot LLM diagnosis run (max once per 6h per automation) that
  audits runtime CLIs, MCP/plugin config, macOS permissions, and environment, and
  reports a structured repair plan into the same chat.
- **Codex engine model pinning.** The app-selected model/effort is now passed to the
  codex CLI explicitly (`--model` / `-c model_reasoning_effort=`). Previously it was
  never forwarded, so machine config — or a codex update's changed built-in default —
  silently decided which model ran.
- **Chat streaming.** Token-delta typewriter reveal (adaptive rAF, snap guard for large
  chunks), steering no longer wipes the in-flight assistant message, and aborted partial
  output is persisted to the chat instead of vanishing.
- **Outputs panel.** Generated files can be revealed in Finder/Explorer via a new
  show-in-folder action; hidden `.agentlas/outputs` artifacts surface correctly.

## 0.7.19 — 2026-07-07

### Changed

- **Terminal CLI surface split out of Desktop.** Removes the bundled desktop terminal
  CLI/runtime surface and its install/test hooks so the desktop app can ship without
  the old in-app terminal install button path.
- **Browser surface English localization.** The Browser page, site cards, add/edit
  modal, activity log labels, approval sheet, and browser-action error outputs now
  respect the active locale instead of leaking Korean into English sessions.
- **Release feed cleanup.** Keeps the macOS packaging path focused on app artifacts
  and update metadata after the terminal CLI removal.

## 0.7.17 — 2026-07-07

### Security

- **Enterprise upload content-safety gate.** Bundles the Hephaestus v1.1.6 engine
  (up from v1.1.1), which hardens `hep-upload` against malicious agent packages.
  The sanitizer now defeats modern prompt-injection obfuscation — homoglyphs,
  leetspeak, zero-width/bidi characters, Unicode Tag-block smuggling,
  separated-letter tricks, and injections split across lines — and detects
  injection/exfiltration in English, Korean, Chinese/Japanese, and major
  European languages, plus secret-exfiltration beacons and high-value credential
  access. It removes only high-confidence attacker directives line-by-line while
  keeping and flagging ambiguous, negated, quoted, or descriptive content, so
  legitimate agent quality is preserved and packages still publish. Verified
  against 139 adversarial vectors (100% stripped) with 0 false positives on 35
  realistic benign samples.

## 0.7.1 — 2026-07-03

### Added

- **Multimodal engine auto-resolve.** Image/video/audio generation now picks a connected
  engine automatically instead of making the agent reason about it at runtime. Default is
  **Auto**: keyless engines first (Codex CLI image_gen, Nano Banana via Antigravity CLI),
  then API-key providers. The chosen engine + readiness is resolved before the run and
  passed to the agent, so it uses it directly. If nothing is connected, the chat shows an
  **"Open multimodal settings"** button instead of the agent flailing with account signup.

### Changed

- **Accumulated fixes from parallel work streams** bundled into this release: automation
  supervisor/health audit, upload Cloud/Hub target selection, chat question sheet, i18n
  leaks, and related desktop UI polish.

## 0.5.9 — 2026-07-01

### Added

- **Automation workflow engine (P0–P2).** Automations are no longer just a prompt on a
  timer. Proper scheduling (full cron + presets + time picker + timezone/DST via croner),
  a **visual node-graph** for every automation (React Flow) that is **auto-generated from
  chat**, condition triggers (file-change, chain, schedule+gate), opt-in launchd
  persistence so schedules fire even when the app is closed, and per-run history. DB
  migrations v33–v35 (graph, schedule spec, timezone, triggers, run history, lease).
- **Parallel workflows.** A chat request can now fan out into **parallel branches**
  (e.g. keyword research → 3 parallel deep-dives → writing → publish). The graph
  generator builds a real DAG with fan-out/fan-in + a layered layout, and the graph
  runner **executes independent branches concurrently** (bounded by the concurrency
  slider), running dependent steps in order. Verified end-to-end in the app.

### Changed

- **Smarter agent import, chat toolbar consolidation, and accumulated fixes** from
  parallel work streams (Oberon motion, Trex studio, Hephaestus, i18n leaks, capture
  media) are bundled into this release.

### Fixed

- Automation review pass: event-driven triggers no longer get promoted onto a clock
  schedule; "Run now" / trigger fires no longer eat the next scheduled slot; condition
  branches persist correctly; per-node agent targets resolve; chat-generated cron parses;
  fs-watcher no longer drops modify events on rename collisions. Removed the confusing
  "completion evidence" runtime note.

## 0.5.8 — 2026-07-01

### Added

- **Autonomous swarm mode (🐝).** Turn one chat into an emergent multi-agent swarm:
  a seed task splits into sub-tasks, workers run in parallel and spawn more work as
  the graph grows, then a synthesizer merges everything into one answer. Safety caps
  (max tasks/rounds, deadlock and infinite-spawn guards) protect your machine and
  wallet; Stop skips the final synthesis to save cost.
- **Continuous live mode ("계속 라이브로").** Keeps the same chat streaming live
  across many execution passes instead of stopping at the 3-pass limit — long,
  uninterrupted autonomous work in one window. Each pass is saved immediately so a
  disconnect never loses progress.
- **Spec-aware concurrency slider (Settings).** How many agents run at once is no
  longer a hardcoded 4. The app reads your CPU/RAM and shows a recommended value;
  a slider (game-graphics-settings style) lets you scale up or down, with a warning
  when you go above the recommendation.

### Changed

- **Chat toolbar consolidated into the + menu.** The bottom bar no longer scatters
  buttons when the window is resized. `/` and `@` moved into the + menu as
  **명령어 (command)** and **에이전트 부르기 (agent call)**; Hephaestus modes
  (find-agent, Stormbreaker, network) moved in too. Active modes show as removable
  chips next to +. The non-functional "앱 생성" entry was removed.
- **Smarter agent import.** Selecting a folder now scans nearby directories for an
  actual agent (looks for `.agentlas/` and other agent markers) instead of blindly
  registering the exact path — and explains *why* when a folder isn't an agent,
  rather than silently showing "no members."

## 0.5.7 — 2026-07-01

### Added

- **Connect GLM, Kimi, and DeepSeek in one click.** New BYOK providers that speak
  the Anthropic Messages API — Settings shows each with a preset endpoint, so you
  paste only the key and the base URL is filled in automatically. GLM (Z.ai) and
  Kimi (Moonshot) coding subscriptions work through their keys; DeepSeek runs
  pay-as-you-go. Routed through the existing Anthropic runner with a per-provider
  preset (`ANTHROPIC_COMPAT_PROVIDERS`).
- **Studio apps (Trex) + Oberon motion.** New agent-built app surfaces bundled in.

### Changed

- **Antigravity CLI.** The Gemini runtime now prefers the Antigravity (`agy`) CLI.
- **Bundled Hephaestus engine → v1.0.5.** Named multi-agent borrow (borrow every
  specialist the operator names) + a temporary orchestrator directive for
  multi-specialist requests.

### Fixed / Performance

- **Big CPU/RAM cleanup for low-end machines (27 files).** Visibility-aware
  polling that pauses when the window is hidden (approval/notification polling
  stays live), runtime child-process listener-leak cleanup, bounded concurrency
  for firm-org and app-factory work, process-group kill + tracking for Oberon
  keyframe and App Factory browser spawns, updater timer `unref` + before-quit
  cleanup, and render hot-path memoization (Bubble/Sidebar/Markdown).

## 0.5.6 — 2026-07-01

### Changed

- **Calmer chat surface for simple runs.** A plain single-agent run now shows a
  one-line status instead of agent cards, the org tree, and internal Stormbreaker
  loop events (armed / scope-lock / route) — those internal events are filtered
  out of the inline status. The card / network view is reserved for runs that
  actually fan out (2+ agents, borrowed Hub task forces, saved agent groups). The
  stop control stays on both the inline status and the input box and still cancels.
- **Resizable chat sidebars.** The left navigation and the right output panel can
  be dragged to resize, with min/max bounds and the width remembered per side.
- Retired the orphaned `/apps/generated` page: visiting it now redirects to Apps,
  and the right-panel output list and `@`-mention no longer link into it.

### Security

- **Main-process hardening (from a Hermes Desktop infra comparison).** Added a
  `will-navigate` guard (the app window can only navigate within `agentlas://` or
  the dev server; external links open in the system browser), a deny-by-default
  permission handler for unused device/sensor capabilities (clipboard and
  notifications stay allowed), and validation of `config:setCustomBaseUrl` (https,
  or http only on localhost/LAN) so a compromised renderer can't redirect the BYOK
  base URL and exfiltrate the API key. Each change was adversarially reviewed for
  side effects before landing.

### Fixed

- The engine now classifies a missing-Python-dependency exit as an actionable
  error and invalidates its cached interpreter/root on structural spawn failures,
  and the renderer auto-recovers from a renderer crash (bounded reload budget).
- Routing plugin-exclusion is carried in the bundled engine for this build, so the
  earlier "make this not look AI-written → Shopify plugin" misroute no longer
  appears (it now surfaces the copywriter agent).

## 0.5.5 — 2026-06-30

### Security

- **Main-process hardening (from a Hermes Desktop infra comparison).** Added a
  `will-navigate` guard so the trusted app window can only navigate within
  `agentlas://` (prod) or the dev server — external links open in the system
  browser instead. Installed a deny-by-default permission handler for
  device/sensor capabilities (geolocation, media, USB/serial/HID, display
  capture) the app never uses, while leaving clipboard and notifications allowed.
  Validated `config:setCustomBaseUrl` (https, or http only on localhost/LAN) so a
  compromised renderer can't redirect the BYOK base URL and exfiltrate the API
  key. Each change was adversarially reviewed for side effects before landing.

### Changed

- **Chat input now grows with what you type.** The composer textarea auto-expands
  from a two-line minimum up to a bounded height (then scrolls internally), and
  collapses back after sending — instead of staying a fixed two rows.

### Fixed

- Routing plugin-exclusion fix now needs to ship in the bundled engine: the change
  lives in the Hephaestus source/runtime but the packaged app carries its own
  bundled engine, so it only takes effect on a rebuild (or once the fix lands in
  the canonical Hephaestus the build clones).
- Packaged builds now pin the embedded engine to Hephaestus `v1.0.4` instead of
  a moving `main` checkout, so the signed app, Windows/Linux builds, and CLI
  runtime release can be traced to the same engine tag.

## 0.5.4 — 2026-06-30

### Added

- **Code map (RECALL layer): the agent can now find code without scanning the
  tree.** On first attach to a project, a compact code-map is generated in the
  background (`<project>/.agentlas/code-map/`) indexing symbols, references,
  modules, entry points and docs. Its seed (modules / entry points /
  most-referenced symbols) is injected into the per-turn memory context, so the
  model orients in a large codebase instead of grepping blindly. Generation is
  best-effort and non-blocking; reading is fully guarded, so a missing or partial
  map never affects a run. The zero-dependency generator is bundled with the app
  (`electron/memory/code-map-gen.mjs`).
- Added a focused Electron QA harness for the chat agent-call surface, covering
  `@` autocomplete keyboard/mouse stability, explicit-agent routing, recommendation
  retry, plain execution payloads, and stop-button cancellation.
- Added an Agentlas Desktop UI/UX stabilization playbook documenting the design
  system and failure patterns that caused recent surface regressions.

### Changed

- `buildMemoryContext` now appends a `### Code map` section alongside project
  soul, sitemap and curated memory when a project map is present.
- **Smoother chat streaming.** Streamed agent text now reveals at a steady cadence
  instead of jumping in whenever a large token chunk arrives. A buffered reveal
  (`useSmoothReveal`) advances the visible text toward the received buffer each
  animation frame, so the answer flows out evenly; it snaps to the full text the
  moment the turn completes, and reading is unaffected when not streaming.
- Renamed the chat router chip from `에이전트 찾기` to `알아서 에이전트 부르기` and
  removed hardcoded tour-source labels from the live workspace.
- Chat and project page tours no longer auto-open over active work; they remain
  available through the help menu.
- Local image outputs and file paths now render as first-class media in the chat
  stream and can open in the right-side preview panel.

### Fixed

- **Chat no longer gets stuck on "working…" after a run finishes.** A fast or
  early-completing run could emit its `final` event (and the active-chats
  broadcast) before the renderer had set the run id and subscribed, so the live
  view never cleared `busy` and the elapsed timer climbed indefinitely — even
  though the answer was already persisted (visible after navigating away and
  back). Added a watchdog that, while a turn is in progress, periodically checks
  the main process's active-run list and reconciles from history the moment that
  run is gone, so a missed completion clears within ~1s instead of hanging.
- **Routing no longer recommends a plugin as an agent.** The local router pooled
  the cached plugin catalog (`type: plugin`, e.g. `plugin/shopify-dev`) together
  with real agent/team cards, so a generic-vocabulary lexical match (e.g. the word
  "AI" in a request) could confidently route to a plugin — "make this not look
  AI-written" was recommending the Shopify plugin at score 15.3. Plugins are tools
  an agent loads via `required_plugins`, not route targets, so they are now
  excluded from the agent route pool. Same request now correctly surfaces the
  `no-ai-slop-copywriter` agent that the plugin's spurious score had been hiding.
- **Agent-call autocomplete no longer jumps away from the hovered or keyboard-selected
  row.** Autocomplete active state now resets only when the actual trigger/query
  changes, not on every parent render.
- **Explicit `@agent` selection disables automatic routing.** Choosing an agent
  directly clears the recommendation mode so the selected agent is the one that
  runs.
- **Recommendation-sheet controls now keep the user in flow.** `다른 에이전트 찾기`
  reruns route preview without closing the sheet, and `추천 없이 실행` no longer
  forwards a hidden router agent or borrowed-agent payload.
- **Stop is visible and actually cancels.** The chat input and live working card
  expose a stop control, preserve the current run id across metadata refreshes,
  and send cancel even if the stop request races with run-id arrival.
- Gemini CLI launches with a real terminal/color environment and disables default
  extensions for prompt runs; Grok CLI can now load its API key from the local vault
  when the process environment is missing it.

## 0.5.3 — 2026-06-30

### Changed

- **Borrowed Hub task-force permissions now follow the chat permission.** Hub
  agents are no longer hard-forced to read-only in the planner, delegate, or
  synthesis sub-runs. If the user selects read-only, they stay read-only; if the
  user selects read-write or full access, the borrowed task force receives the
  matching runtime permission and MCP/tool bridge for that run while the host
  policy still blocks secret exfiltration and permission escalation.
- Reworded Marketplace docs and QA references around Hub-only catalog behavior:
  Desktop no longer presents an offline in-memory marketplace fallback, and
  offline Hub failures should remain visible as empty/error states.
- Localized the top navigation dropdowns and Library headers so the new Agent
  group path renders cleanly in both Korean and English.

### Added

- Added **Agent group** under the Agent menu: users can drag installed agents,
  org-chart nodes, and live Hub agents into a saved top-level orchestrator group.
  Groups re-resolve members from the latest local org chart and Hub catalog,
  surface route/missing-agent warnings, and allow removing one member without
  deleting the whole group. Saved groups can now start a chat directly; the
  chat stores `agent_group_id` and runs the resolved roster through the local
  task-force orchestrator instead of flattening it into one prompt.

## 0.5.2 — 2026-06-30

### Added

- **Live Hub borrowed task-force execution.** Selecting multiple Hub agents from
  the recommendation sheet now runs a real local orchestrator flow instead of
  flattening them into one prompt: plan per-agent input packets, run each
  borrowed Hub agent in an isolated local sub-session, then synthesize the final
  answer.
- Added visible coordination events for borrowed Hub TF runs:
  `plan → delegate → synthesize`, with per-agent `borrow:<slug>` completion
  markers so the right panel can show the actual handoff.
- Added regression and live smoke harnesses for the borrowed task-force path.

### Security

- Borrowed Hub sub-runs are forced to read-only permission and no longer inherit
  MCP auto-approval config, allowed-tool lists, Codex MCP config args, or vault
  environment variables from the orchestrator.
- Added host-policy prompts for untrusted borrowed directives, secret-file
  refusal guidance, and output redaction for common tokens/API keys/private keys
  across status, tool, partial, and final events.

### Changed

- Recommended pipeline stages now reach the main runtime as an execution
  contract, not only as a placeholder UI stepper.
- Desktop Build copy and README keep the pricing boundary explicit: Build itself
  is 0 Agentlas credits; model usage is the user's runtime/subscription/key;
  Hub Network calls remain separately quoted and credited.

## 0.5.0 — 2026-06-29

22개 UI/기능 항목 + 3차 병렬 검수 + 버그헌터 5스웜 수정.

### Fixed

- **Hub 에이전트를 다시 불러옵니다.** 검색이 존재하지 않는 REST 엔드포인트
  (`/api/marketplace/agents`, 404)를 호출해 항상 비어 있던 문제를, 동작하는 MCP
  `marketplace.search_agents` 경로로 전환하고 결과에 `source` 마커를 부여해
  마켓 화면의 live-hub 필터에 걸러지지 않도록 수정.
- **새 채팅이 무한 기록되던 문제** — 최근/프로젝트/회사 목록이 메시지가 있는
  채팅만 표시(빈 새 채팅은 첫 메시지 전에 기록되지 않음).
- 다크 모드: 베이스 accent/상태 토큰이 라이트 팔레트를 상속해 대비가 무너지던
  문제(올리브 버튼 + 흰 글자, 흐린 placeholder)를 전용 다크 토큰맵으로 교정.
- 멀티모달 fallback·영상 설정을 한 줄 리스트로 정리(활성 행 클리핑 수정).
- 조직도 글자 겹침 + 그룹 "전체 제거" 버튼, 우하단 도움말(?) 영구 숨김(×).
- 검수/버그헌터 후속: 캐시 히트 시 Hub 상태 배지 stale, 마켓 페이저 클램프,
  멀티모달 저장 오류 처리, 조직도 제거 실패 시 목록 새로고침, 대시보드 최근 대화
  폴링 갱신, 스튜디오 벤치 영상 poster/자동재생.

### Changed

- **워크스페이스 좌측 사이드바 병합** — 채팅/프로젝트에서 글로벌 네비(SideNav)가
  사라지던 문제를 해결: 아이콘 전용 SideNav를 채팅 Sidebar와 하나의 레일로 합침
  (에이전트 관리 등 글로벌 진입점 유지).
- **대시보드 전역 오케스트레이터 모델 설정**(엔진/모델/effort) + 최근 대화
  페이지네이션(5개). CLI 활성화 중복 정리.
- **Hub 메뉴 단순화** — 상단 카테고리 섹션 제거, 검색 + 에이전트 카드 + 페이지네이션만.
- **Agentlas Studio 리디자인** — 넷플릭스 그리드 폐기, 컨트롤룸 헤더 + 벤치 + 랙
  구조(라이트/다크 안전). **대시보드 Hub 빌려쓰기**·**다크 모드** 리디자인
  (no-slop-designer, 레퍼런스 그라운딩).
- **프로젝트 단순화** — Ontology UI 제거, 채팅 관리(메모리·활동 공유) 용도로 축소,
  새 채팅 시 프로젝트/일반 선택 팝업.
- 슬래시/앳 힌트 한·영 병기: `/` → 명령어(command), `@` → 에이전트 부르기(agent call).
- 퍼블리싱/Hub fetch 5분 TTL 캐싱.
- 생성물(만든 앱/도구/화면/자료) 라이브러리 라우트 제거. 페이지 투어 카피 재작성.

## 0.4.7 — 2026-06-29

### Fixed

- Restored the left sidebar navigation, which had disappeared after an
  incomplete navigation refactor left `AppShell` hiding `SideNav` on chat routes
  and moved a half-built menu section into the chat `Sidebar`.

### Changed

- Brought back the full grouped left navigation in `SideNav`, porting the 0.4.0
  menu structure onto the current shell: **Dashboard** and **Workspace** as
  top-level items, plus the **Agent Forge** (Build, Agent), **Studio** (Apps,
  Automations), **Hub** (Agent Hub, Publish), and **Environment** (Connection
  Keys, MCP Tools, Apps Library, Tool Library, Surfaces, Assets) groups. All
  labels reuse existing localized `nav.*` keys; all 14 menu routes were verified.
- Removed now-dead query-param branches from the `SideNav` active-state helper.

## 0.4.4 — 2026-06-29

### Changed

- Set Desktop Build pricing to match the BYOK/BYOC model: single-agent builds
  now show 5 credits and multi-agent team builds show 10 credits.
- Added visible Build mode credit badges and kept the desktop surface smoke test
  locked to the new 5/10 credit display.
- Removed public-source hygiene issues from the desktop repo: local absolute
  paths in Oberon tooling, a realistic-looking fake API key in a smoke test, and
  absolute Playwright proof paths are no longer committed.

## 0.4.3 — 2026-06-29

### Changed

- Re-released the desktop app with Hephaestus v1.0.0 as the embedded Agent OS
  engine baseline.
- Preserved the Router Agent runtime injection from 0.4.2 and paired it with the
  v1.0.0 routing engine release so low-confidence Agentlas Hub routing can keep
  its escalation context across the desktop runtime handoff.
- Refreshed the production update feed target for the 100K-agent routing rollout
  after the R2 marketplace index and Atlas vector search path were activated.

## 0.4.0 — 2026-06-28

### Added

- Redesigned the first-run onboarding into a 5-step, Duolingo-style learning path: pick a goal → connect your AI → ask a live guide → hire your first agent → graduate with a day-1 streak.
- Added a live guide step: the AI you just connected answers your real questions right inside onboarding — a real model response, with no demo or fallback answers.
- Added an always-available help button so you can replay the setup or take the menu tour again anytime.
- Added local streaks and milestone tracking that reflect what you actually did during onboarding (no fake rewards).
- Rewrote all onboarding copy in Korean and English for a warmer, clearer first run, keeping product terms (agent, skill, Hub, Stormbreaker) and dropping engineer jargon.
- Added the always-on Stormbreaker Loop as the default execution discipline for non-trivial chat and automation work.
- Added visible `Stormbreaker Loop` activity events to the chat working panel, including armed, scope-lock, route, and final-gate stages.
- Added automatic goal decomposition, work-packet/sub-agent architecture instructions, immediate continuation passes, and hidden `every-30m` long-run continuation automations for loop-worthy work such as app builds, game builds, automations, trading/ops runs, deployment, debugging, and data/report generation.
- Added bounded repair/retry for invalid Agentlas Surface manifests: the desktop now re-prompts for a corrected manifest and re-validates before accepting it.
- Added Hephaestus Network as a default MCP plugin and added request-aware MCP auto-selection for Claude Code/Codex runs.
- Added GPT-5.5 Codex/GPT-5.5 model options.

### Changed

- Scheduled automations now receive the same Stormbreaker Loop prompt as chat runs, so recurring jobs are prompted to resume from evidence, verify state where tools allow it, act, and record changes. This does not by itself verify external account actions such as Instagram posting.
- Scheduled automations now reuse one hidden durable chat session per automation instead of starting each run from an empty background chat.
- Removed the Settings Stormbreaker toggle; the compatibility IPC now reports/enforces enabled state.
- Corrected plugin wording so credentialless catalog entries can be auto-enabled, while credential-gated tools remain candidates until vault values exist.
- Removed the first-draft automation loop note from the automation page in favor of the broader Stormbreaker loop model.
