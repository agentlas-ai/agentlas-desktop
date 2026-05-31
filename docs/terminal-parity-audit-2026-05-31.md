# Agentlas Terminal — Parity & Superiority Audit (2026-05-31)

> Goal: drive the agentlas terminal to **at least feature-parity** with Hermes / OpenClaw and the
> two coding terminals it actually hosts (Claude Code, Codex CLI), then **exceed them on UI/UX**.
> Sources: agentlas CLI source (read 2026-05-31) + official docs of each competitor (cited below).

---

## 0. Executive summary

agentlas is **not** another coding CLI — it is the **multi-LLM host TUI** that drives
`claude-code` / `codex` / `gemini` headless (preserving subscription auth) and renders their
streams inside one branded shell, with capability-based auto-routing, "agents" + "firms", and a
shared memory/keychain with the desktop app. That positioning is genuinely differentiated and is
the foundation of the superiority thesis (section 4).

But as a *terminal* it is currently behind the bar that Claude Code and Codex set on **input
ergonomics and session affordances**. The biggest credibility gaps are all in the REPL loop
(`cli/agentlas-repl.cjs`), which today is a bare `readline.question` loop:

- **No tab-autocomplete**, **no persistent history / Ctrl-R**, **no multiline composer** — the
  three things a user notices in the first 30 seconds.
- **agentlas's own conversation is in-memory only** — no `/resume`, `/export`, or `--continue` of
  the host session (the backends keep their own sessions, but the host transcript is lost).
- **No `@file` mentions, no `!` shell mode, no `/diff` review, no session-total `/cost`,
  no `/compact`** — all present in both Claude Code and Codex.

None of these touch the (well-built) headless-backend architecture; they are additive REPL work.

---

## 1. agentlas terminal — verified inventory (from source)

**Identity / chrome**: "agentlas — the Boston Terrier terminal". T-Rex ASCII mascot + `AGENTLAS`
wordmark splash, truecolor brand palette (crimson paw + emerald). Runs as **Electron-as-Node**
(`ELECTRON_RUN_AS_NODE=1 <Electron> cli/agentlas.cjs`) so it can `require` the app's
`better-sqlite3` / `keytar` and share the app's SQLite DB + OS keychain.
*(Verified: system Node v25 fails with NODE_MODULE_VERSION 130 != 141; the Electron binary runs it.)*

**Core model** (`agentlas-repl.cjs`, `agentlas-native-host.cjs`): agentlas is **always the host**.
For `claude-code`/`codex`/`gemini` it spawns them headless (`claude -p --output-format
stream-json --include-partial-messages`, `codex exec --json ... resume <thread>`, `gemini -p`),
parses their event streams and re-renders them in its own UI. For BYOK (`anthropic`/`openai`/
`google`) + `ollama` it runs its **own** agent loop (`agentlas-api-agent.cjs`) with local tools.

**Multi-LLM capability routing** (`agentlas-capabilities.cjs`): each agent auto-routes to a runtime
matching its job — image agents -> `gemini` (nano-banana) / `codex` (Imagen) because Claude has no
image gen. Per-agent runtime can be pinned via `/team`.

**Entities**: "Agents" + "Firms" (a company with a CEO agent you delegate to). Installed from the
desktop marketplace or `/import <folder>`. (Live: 11 agents, 2 firms on this machine.)

**Top-level CLI**: `agentlas` (splash->pick) | `agentlas <agent>` / `open <agent>` |
`firm <firm> [cmd]` | `run <agent> [prompt]` (one-shot, reads stdin, scriptable) | `import <path>` |
`cd <agent>` (writes CLAUDE.md/AGENTS.md/GEMINI.md) | `list` | `env` | `creds save ...` | `doctor` |
`setup`. Flags: `--runtime claude-code|codex|gemini`, `--permission read|write|full` (default write).

**REPL slash commands**: `/help /agents /team [agent rt] /agent <name> /firms /firm <name>
/runtime <kind> /model <id> /permission|/perm <lvl> /cwd [path] /memory /clear /import <path>
/doctor /status /exit`.

**Interactive UX**: streaming truecolor text | tool call/result lines (`* name` + `result`) |
braille spinner w/ status | **light** markdown (headings/bold/inline-code/bullets — *no tables, no
syntax-highlighted code blocks*) | per-turn cost line (`in->out tok | $ | s`) | memory-events guard
(hides a trailing `## Memory Events` block from the live stream) | Ctrl-C aborts turn once / quits
when idle | status line (`subject | runtime | perm | cwd`).

**Onboarding**: first-run wizard (language en/ko -> default runtime -> default permission) saved to
`cli-prefs.json`; full i18n en/ko for all chrome. (Wizard is explicitly "openclaw-style" per source.)

**Memory**: injects project+global memory into the system prompt; `/memory` shows it; curates
replies + captures memory events.

**BYOK loop tools**: `list_dir, read_file, write_file, edit_file, bash` gated by read|write|full.

---

## 2. Competitor inventories (web-sourced)

### 2a. Claude Code CLI (the primary bar)
Interactive surface is deep. **Slash**: `/help /clear /compact /cost /context /usage /model
/resume /init /config /vim /memory /agents /mcp /login /logout /status /doctor /review /add-dir
/export /rewind /permissions /hooks /output-style /btw /recap /voice /terminal-setup` + custom
skills/commands via `/<name>`. **Keyboard/input**: Up/Down + **Ctrl-R reverse history search**
(scope-cyclable with Ctrl-S); **Shift-Tab** cycles permission modes (default/acceptEdits/plan);
**Esc** interrupts, **Esc-Esc** clears draft / opens **rewind (checkpoint) menu**; **@** file-path
mention w/ autocomplete; **!** shell mode (output enters context, Tab-completes prior `!` cmds);
**multiline** via `\`+Enter / Shift-Enter / Ctrl-J; **Ctrl-V** paste image -> `[Image #N]` chip;
**Ctrl-O** transcript viewer; **Ctrl-T** task list; **Ctrl-G** edit prompt in `$EDITOR`; vim editor
mode; **Tab** accepts grayed prompt suggestion; per-dir persistent history; session recap; PR badge.
*(docs: code.claude.com/docs/en/interactive-mode, /en/slash-commands, /en/checkpointing)*

### 2b. Codex CLI (OpenAI) — the other terminal agentlas hosts
**50+ slash commands**: `/model /fast /personality /clear /new /resume /fork /side /permissions
/approve /plan /goal /review /copy /diff /raw /compact /statusline /title /theme /keymap /vim
/skills /plugins /apps /mcp /hooks /ide /ps /stop /agent /experimental /memories /status
/debug-config /mention /init /feedback /logout /quit`. **Keyboard**: Ctrl-O copy, Alt-R raw,
Ctrl-L clear view. **Input**: @file via `/mention`, image paste/attach, IDE context via `/ide`.
**Approval/sandbox**: Auto / Read-Only / configurable, switchable mid-session via `/permissions`.
**Resume**: `codex resume` picker, `--last`, `<SESSION_ID>`; `/fork`, `/side`. `/theme` + `/keymap`
= themable + rebindable. *(docs: developers.openai.com/codex/cli/slash-commands, /cli/reference)*

### 2c. Hermes Agent (Nous Research) — the polished installer in the screenshot
Python/uv, "the agent that grows with you" (self-improving). **Standouts agentlas lacks**:
**Voice mode** (Ctrl-B push-to-talk, Whisper STT, spoken replies, Discord voice) + **TTS** (10
providers incl. free Edge TTS); **browser automation** (Browserbase / Browser Use / local CDP);
**image generation** (FLUX 2, GPT-Image via FAL); **checkpoints & `/rollback`**; **subagent
delegation** (3 concurrent); **cron / scheduled tasks** (natural language); **event hooks**;
**batch** (run across thousands of prompts); **`@` context refs** (files/folders/diffs/URLs);
**skills** (agentskills.io); **`/personality` + SOUL.md**; **skins/themes** (colors, spinners,
branding); **plugins**; **fallback providers + credential pools + prompt caching**;
**OpenAI-compatible API server**; **IDE/ACP** (VS Code/Zed/JetBrains); **messaging gateway**
(WhatsApp/Telegram/Slack/Discord). CLI: `hermes`, `hermes model/tools/config set/gateway/setup/
update/doctor`, `hermes claw migrate`. *(docs: hermes-agent.nousresearch.com/docs)*

### 2d. OpenClaw (the wizard agentlas's onboarding is modeled on)
"Your own personal AI assistant. Any OS." — `npm i -g openclaw`. **Multi-agent**: `agents
add/list/delete/bind/unbind/set-identity`, per-agent workspace + auth + skill visibility, **channel
routing** (`telegram:*`, `telegram:ops`) pinning inbound traffic to agents. Gateway + skills system
+ `IDENTITY.md`. `openclaw agent --message "..." --thinking high`. Hermes is its evolution
(`hermes claw migrate`). *(github.com/openclaw/openclaw)*

---

## 3. Gap matrix

| Capability | agentlas today | CC | Codex | Hermes | OpenClaw | Verdict |
|---|---|:--:|:--:|:--:|:--:|---|
| Tab autocomplete (cmds/agents/paths) | no | yes | yes | yes | yes | **P0 gap** |
| Persistent history + Up/Down | session-only | yes | yes | yes | ? | **P0 gap** |
| Ctrl-R reverse search | no | yes | yes | ? | ? | **P0 gap** |
| Multiline composer | no (1 line) | yes | yes | yes | ? | **P0 gap** |
| `@file` mentions | no | yes | yes | yes | ? | **P0 gap** |
| `!` shell mode | no | yes | (sandbox) | yes | ? | **P0 gap** |
| `/diff` review | no | yes | yes | yes | ? | **P0 gap** |
| Session-total `/cost` | per-turn only | yes | yes | yes | ? | **P0 gap** |
| `/compact` context mgmt | no | yes | yes | yes | ? | **P1** |
| Resume host session | no | yes | yes | yes | yes | **P1** |
| Themes / rebindable keys | brand only | themes | yes | yes | ? | **P2** |
| Syntax-highlighted code / tables | no | yes | yes | yes | ? | **P1** |
| Image paste into terminal | no | yes | yes | yes | ? | **P2** |
| Voice / TTS | no | dictation | no | yes++ | ? | **P2** |
| Cron / scheduled | app-side only | no | no | yes | yes | **P2** |
| **Multi-LLM host + capability routing** | **yes++** | no | no | partial | partial | **agentlas wins** |
| **Firms / agents marketplace** | **yes** | agents | agents | no | multi-agent | **agentlas edge** |
| **Run 3 subscription CLIs headless in one shell** | **yes++** | no | no | no | no | **unique** |

---

## 4. Superiority thesis — what agentlas can do that they can't

agentlas is the only one of the five that is a **neutral host over claude+codex+gemini at once**.
Lean into that:

1. **Per-runtime / per-agent cost & usage ledger** — Claude Code only knows itself; agentlas can
   show a live `/cost` table broken down by *which backend* and *which agent* spent what this
   session. (No competitor can.)
2. **Hot runtime swap that carries the host transcript** — `/runtime codex` mid-conversation,
   replaying the agentlas-held history into the new backend (it already keeps `state.history`).
3. **One unified `/diff` and one approval model** across whatever backend just edited files.
4. **Capability auto-routing as a first-class, visible feature** — `/team` already shows it; make
   the routing decision narrated and overridable inline.

---

## 5. Prioritized backlog (buildable, grounded in `cli/`)

### P0 — table-stakes parity (make it feel like a real terminal)

| id | item | target | effort | files |
|---|---|---|:--:|---|
| `tab-complete` | readline `completer`: `/cmds`, agent/firm slugs, runtime kinds, perm levels, `/team` & `/model` args, path completion for `/cwd` `/import` `@` | S | input, repl |
| `hist-persist` | load/save `rl.history` to `<userData>/cli-history.json`, cap N; Up/Down work once seeded | S | input, repl |
| `ctrl-r` | reverse incremental search over history (`Ctrl-R` cycle, `Esc`/`Tab` accept, `Ctrl-C` cancel) | M | input |
| `multiline` | trailing `\` continues input; assemble before submit | M | input, repl |
| `at-file` | expand `@path` tokens -> inject file contents (truncated) as a context block before send | S | repl |
| `bang-shell` | `!cmd` runs in cwd, prints output, appends to history context | S | repl |
| `slash-diff` | `/diff` -> `git -C cwd diff` (incl. untracked) rendered with +/- coloring | S | repl, ui |
| `session-cost` | accumulate usage per `runtimeLabel`+agent into `state.cost`; `/cost` prints session total + breakdown (captured uniformly in `Ui.cost`) | S | repl, ui |

### P1 — superiority moves (lean on the host position)
| id | item | effort | files |
|---|---|:--:|---|
| `cost-compare` | `/cost` per-runtime + per-agent table (no competitor can) | S | repl, ui |
| `runtime-swap-ctx` | `/runtime` mid-turn replays `state.history` into the new backend | M | repl |
| `host-resume` | persist host transcript per (agent,cwd) -> `/resume`, `/export <file>`, `--continue` | M | repl, agentlas.cjs |
| `compact` | `/compact` summarizes `state.history` for the api-loop path | M | repl, api-agent |
| `rich-render` | fenced code blocks w/ minimal syntax tint + markdown tables in `Ui.markdown` | M | ui |
| `narrate-route` | show + allow inline override of the capability routing decision | S | repl |

### P2 — delight / longer-horizon
| id | item | effort |
|---|---|:--:|
| `themes` | `/theme` presets + `/keymap` (Codex parity) | M |
| `image-paste` | `Ctrl-V` image -> temp file -> pass to image-capable runtime | M |
| `tts-voice` | optional TTS of replies (Edge TTS free) + `Ctrl-B` dictation (Hermes parity) | L |
| `scheduler` | surface the app's automation-scheduler as `/cron` in the CLI | M |
| `plan-mode` | `Shift-Tab` cycle read->write->full (perm modes as a visible cycle) | S |

---

## 6. Recommended first batch (this PR)

Ship the eight **P0** items + the `cost-compare` **P1** in one pass — they are additive, low-risk,
and confined to the REPL/UI/i18n layer. Concretely: a new `cli/agentlas-input.cjs`
(history + completer + reverse-search + multiline) wired into `startRepl`, plus `/diff`, `/cost`,
`@file`, and `!shell` handlers in `agentlas-repl.cjs`, a `lastUsage` capture in `Ui.cost`, and
en/ko strings + `/help` rows in `agentlas-i18n.cjs`. After this batch agentlas reads as a
first-class terminal *and* shows the per-runtime cost table none of the others can.
