<p align="center">
  <img src="assets/agentlas-desktop-banner.svg" alt="Agentlas Desktop banner">
</p>

<h1 align="center">Agentlas Desktop</h1>

<p align="center">
  <strong>Run AI-native Apps and agent teams on the Claude, ChatGPT, or Gemini plan you already pay for — locally.</strong>
</p>

<p align="center">
  A local Apps OS for AI work that <strong>never hands your API keys or chat history to a hosting platform.</strong><br>
  Bring your own Claude Code, Codex, or Gemini CLI (or any API key), install Apps over MCP, and run them on your own machine.
</p>

<!-- ── Download (primary action) ───────────────────────────────────────── -->
<p align="center">
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">
    <img alt="Download for macOS — Apple Silicon" src="https://img.shields.io/badge/Download_for_Mac-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">
    <img alt="Download for macOS — Intel" src="https://img.shields.io/badge/Download_for_Mac-Intel-555555?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">
    <img alt="Download for Windows" src="https://img.shields.io/badge/Download_for-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white">
  </a>
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">
    <img alt="Download for Linux" src="https://img.shields.io/badge/Download_for-Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black">
  </a>
</p>
<p align="center">
  <sub>Free · open source (Apache-2.0) · no Agentlas account needed to run · prefer the terminal? <a href="#install-from-the-terminal">one-line install ↓</a></sub>
</p>

<p align="center">
  <a href="https://agentlas.cloud">agentlas.cloud</a>
  ·
  <a href="https://agentlas.cloud/desktop">Desktop page</a>
  ·
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">Releases</a>
  ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/agentlas-ai/agentlas-desktop/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/agentlas-ai/agentlas-desktop?include_prereleases&label=download&color=blue">
  </a>
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green">
  </a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20Gemini%20%7C%20BYOK-black">
</p>

<p align="center">
  <img alt="Agentlas Desktop running a CEO agent over a live org chart" src="docs/screenshot.png" width="960">
</p>

## Release log

Canonical release history lives in
[GitHub Releases](https://github.com/agentlas-ai/agentlas-desktop/releases).
This README keeps the latest public deploy note so humans and agents can verify
the current channel quickly.

- **2026-06-06 · v0.2.18 terminal ontology update** — `agentlas` now accepts
  short REPL commands such as `/ontology`, `/ontology list`, and
  `/ontology company ./docs`; company and personal folders stay private unless
  explicitly registered otherwise.
- **2026-06-09 · v0.2.27 Cloud-ready agent packages** — terminal users can now repair
  `agentlas.json`, run a local security scan, compile a manifest-based runtime
  bundle, and test lazy file reads before Cloud sync or Hub publish.
- **2026-06-06 · v0.2.17 public desktop release** — Project Ontology panel and
  `agentlas ontology` terminal status/add/open flow shipped. Each project gets a
  separate `.agentlas/ontology-inbox/`, `.agentlas/ontology-sources.json`, and
  `.agentlas/ontology-runtime.sqlite`; home folders and sibling projects are not
  scanned automatically.

### What you get

| | |
|---|---|
| **4 runtimes** | Claude Code · Codex · Gemini CLI · any API key (BYOK) — auto-detected |
| **3 cloud providers** | Anthropic · OpenAI · Google, using *your* key |
| **+$0 to your model bill** | Agentlas runs no model and never proxies a call |
| **100% local** | keys in the OS keychain, chats & agents in local SQLite |
| **Agent teams, visible** | every firm renders as an org chart, not a black box |
| **Apps Store** | install Apps, agent firms, and supporting engines over the Model Context Protocol |
| **3 platforms** | macOS (Apple Silicon + Intel) · Windows · Linux, self-updating |
| **Apache-2.0** | audit it, fork it, ship your own variant |

Connect the AI models you already pay for, install Apps over MCP, and run AI-native
apps or whole agent teams from one local window — with the UI, org chart, and repo
behind every run in plain view. Your keys and your chat history stay on your
machine, never on someone else's agent platform.

- **Bring your own models.** Claude Code, Codex, and Gemini CLI, or
  OpenAI / Anthropic / Google API keys directly. Agentlas never proxies the model call.
- **Install Apps over MCP.** Drop in an App, an agent, or a whole team — for example
  a package you built on [agentlas.cloud](https://agentlas.cloud) — and run it.
- **Prepare Cloud-ready agents locally.** `agentlas cloud wizard` creates or
  repairs `agentlas.json`; `agentlas cloud runtime bundle` builds the MCP call
  context from manifest allowlists instead of sending a whole ZIP.
- **Apps are first-class.** An App opens inside Agentlas Desktop like a small
  macOS/Windows/Linux window: it can have its own UI, UX, backend adapters,
  generated assets, credential requirements, MCP tools, and sub-engines. Assets,
  vault keys, and MCP servers are support devices for Apps, not separate top-level
  products.
- **See the team, not a black box.** Every agent team renders as an org chart and
  a file tree, so you can see who does what and which repo each run touches.
- **Run and orchestrate locally.** The app supervises the agent processes and
  routes work between roles, all on your disk.
- **Local-first.** Keys in the OS keychain, chats and installed agents in local
  SQLite. Open source, Apache-2.0 — fork it, audit it, ship a variant.

## Who it's for

- **Power users** who already pay for Claude, ChatGPT, or Gemini and want to run
  agents on that subscription instead of paying a second AI bill to an agent SaaS.
- **Builders** who package Apps or agents on [agentlas.cloud](https://agentlas.cloud) and
  want to run them locally over MCP.
- **Privacy-minded teams** who refuse to hand their API keys and chat history to a
  third-party agent platform.
- **Tinkerers** who want an open-source, auditable, forkable agent runner.

## Features

A complete tour of what ships today.

### Bring your own everything (BYOC)

- **Local CLI runtimes, auto-detected.** Agentlas finds your installed
  `claude-code`, `codex`, and `gemini` CLIs and runs through them — using the
  subscription/login you already have. No re-auth, no copy-pasting keys.
- **BYOK cloud keys.** No CLI? Paste an Anthropic, OpenAI, or Google API key and
  go. Keys are stored in the OS keychain, never a file.
- **Mix and switch freely.** Have Claude Code *and* a Gemini key? Both show up; pick
  the active backend per run. Most apps lock you to one provider — Agentlas doesn't.
- **No proxy, ever.** Every model call goes straight from your machine to the
  provider. Agentlas runs no LLM of its own and adds **$0** to your model bill.

### Agent firms — teams, not a single bot

- **Install a whole company.** A *firm* is a CEO agent that delegates down to
  department heads and workers — e.g. a storefront-ops firm with content, CS, and
  analytics departments.
- **Live org chart.** Every firm renders as a hierarchy so you can see who reports
  to whom and which role handles what — no black box.
- **Chat the CEO, mobilize the team.** Message the CEO and it routes work to the
  right roles, or talk to any single specialist directly.

### Projects, chats, and history that stay yours

- **Projects** group related chats, apply a shared context note, and set a default
  agent so every new chat starts with the right context.
- **Project Ontology panel** activates a project-local `.agentlas/ontology-inbox/`,
  shows registered sources, and keeps the SQLite knowledge store inside that
  project. It does not scan your home folder or sibling projects.
- **Chats** support rename, archive/unarchive, switching the bound agent, and full
  message history — all in **local SQLite**, nothing on a server.
- **Image attachments** are sent as multimodal input on BYOK backends.
- **Working-folder panel** pins a folder to a chat with a read-only file tree and
  text preview, so you can see the repo an agent is helping with.

### Apps Store — install and generate Apps

- **MCP-native installs.** Browse and install Apps, agents, and whole firms from the
  `agentlas.cloud` Apps Store; they run through local runtime adapters over the
  Model Context Protocol.
- **Operator-published Apps.** Agentlas operators publish App source/bundles to a
  private GitHub repo, GitHub Release, or object storage; `agentlas.cloud` keeps the
  MongoDB marketplace index, permissions, manifest, and version metadata. MongoDB is
  not the blob store for full app bundles.
- **Chat-generated Apps.** Turn on **Apps Generate** beside the Goal control in chat
  and describe the tool you want. The built-in Agentlas App Builder routes the task
  into an internal App manifest, not a standalone localhost web app or loose assets,
  and leaves a stable Apps CTA when the model does not.
- **First proof App.** **Document Studio** opens at `/apps/document-studio` as an
  AI document workspace with tabs, an editable generated draft, figure planning,
  and an "Open in Apps" CTA.
- **Trust grades.** Listings carry a trust grade; sideloading unvetted agents is
  gated.
- **Works offline.** An in-memory fallback source keeps the marketplace usable when
  the network or cloud is down.

### Apps — manage the whole toolbox

- **Installed Apps, Apps Store, Apps Vault, and Apps Engines** live under one sidebar
  section. The vault tracks which credentials each App needs and which are set;
  values live in the keychain, the UI only shows whether a key exists. MCP servers
  and generated assets are engines/artifacts that help Apps run.

### Automations

- **Schedule recurring runs** against an agent or a firm from a prompt template.
  (UI ships in the current M0 build; the persistent scheduler lands in V1.)

### Migrate in — never locked in

- **Import from OpenClaw and Hermes** in one click: SOUL/persona → an agent, `.env`
  keys → the keychain, scheduled jobs → automations, memories → a project. Dry-run
  and overwrite supported. Secret values never leave the main process.
- **Apache-2.0 open source.** Audit it, fork it, ship your own variant.

### Local-first security

- API keys and tokens live in the **macOS/Windows/Linux keychain** via the main
process — never a plaintext file, never readable by the renderer/UI.
- Chats, projects, firms, and installed agents live in **local SQLite**.
- Ontology sources are project-local by default: add files to the project's
  `.agentlas/ontology-inbox/` or register an explicit source with
  `/ontology company ./docs` inside the Agentlas terminal.

### Cross-platform, self-updating, bilingual

- **macOS (arm64 + Intel), Windows (installer + portable), Linux (AppImage + deb).**
- **Auto-updates** via a GitHub Releases feed — a "Restart to update" badge appears
  when a new build is downloaded.
- **Full Korean / English UI** with automatic locale detection.

## How Agentlas compares

Three common ways to run AI agents today — and where Agentlas lands.

| | **Agentlas Desktop** | Hosted agent platform (SaaS) | Single-model desktop chat | Raw terminal CLI |
|---|---|---|---|---|
| Where model calls go | **Direct from your machine** | Through their servers | Direct | Direct |
| Who pays for tokens | **Your existing sub / key** | Platform fee **+** tokens | Your sub / key | Your sub / key |
| Where keys & history live | **Your keychain + local SQLite** | Their cloud | Local (varies) | Local |
| Multi-agent firms + org chart | **Yes** | Sometimes | No | No (manual) |
| Install 3rd-party Apps over MCP | **Yes, Apps Store** | Varies | No | Manual |
| Use local CLIs (Claude Code / Codex / Gemini) | **Yes** | Rarely | No | One at a time |
| Mix CLIs **and** cloud keys in one window | **Yes** | No | No | No |
| Open source (Apache-2.0) | **Yes** | Usually no | Varies | Varies |
| Desktop GUI on mac / win / linux | **Yes** | Web only | Often | No (terminal) |

**Why people pick Agentlas**

- **It runs on the AI you already pay for.** No second subscription to an agent
  platform — your Claude/ChatGPT/Gemini plan does the work.
- **Your data never leaves your machine.** Keys in the OS keychain, chats in local
  SQLite, model calls direct to the provider. Nothing to trust us with.
- **Teams of agents, visible.** Firms with a real org chart beat a single opaque
  chatbot when work needs more than one role.
- **Open and portable.** Apache-2.0, importable from OpenClaw/Hermes, forkable — no
  lock-in.

## Screens

| Screen | What it does |
|--------|--------------|
| **Home** | Landing dashboard — recent chats, installed teams, quick actions. |
| **Chat** | One-on-one conversation with an agent or a firm's CEO. Supports image attachments on BYOK backends. |
| **Archived chats** | Chats you've archived — hidden from the sidebar, restorable anytime. |
| **Projects** | Create and open projects; each carries a default agent and a shared context note. |
| **Firm detail** | The agent company's org chart — CEO → department heads → workers, plus the firm persona. |
| **Automations** | List, create, and toggle scheduled runs targeting an agent or a firm. |
| **Apps · Installed** | Installed Apps launcher. Includes Document Studio and App Builder generated Apps. |
| **Apps · Store** | Browse and install Apps, agents, and firms from `agentlas.cloud` (with an offline in-memory fallback). |
| **Apps · Engines** | Installed MCP servers, backend connectors, and sub-engines used by Apps. |
| **Apps · Vault** | The shared credential vault — which keys are set and which Apps require them. |
| **Settings** | Backend connections, BYOK API keys, language, and migration from OpenClaw / Hermes. |
| **Onboarding** | First-run wizard: welcome → connect a backend → menu tour → install your first team. |

## LLM Providers

Agentlas connects to models two ways — through a **local CLI** you already have
installed, or with a **cloud API key (BYOK)**. Either way the call goes straight
from your machine to the provider; Agentlas never sits in the middle.

| Provider | How it connects | Notes |
|----------|-----------------|-------|
| **Claude Code** | Local CLI (`claude-code`) | Auto-detected. Uses your existing Claude subscription/login. |
| **Codex** | Local CLI (`codex`) | Auto-detected. Uses your existing ChatGPT/OpenAI login. |
| **Gemini** | Local CLI (`gemini`) | Auto-detected. Uses your existing Google login. |
| **Anthropic** | BYOK API key | `console.anthropic.com → API Keys`. Stored in the OS keychain. |
| **OpenAI** | BYOK API key | `platform.openai.com/api-keys`. Stored in the OS keychain. |
| **Google (Gemini)** | BYOK API key | `aistudio.google.com/app/apikey`. Stored in the OS keychain. |

You need **one** of these to start — a single detected CLI or a single API key.
Add more later in **Settings**.

## Quick install

Get the latest build from the [**Releases page**](https://github.com/agentlas-ai/agentlas-desktop/releases/latest).

| OS | File | Notes |
|----|------|-------|
| macOS (Apple silicon) | `Agentlas-x.y.z-arm64.dmg` | M1 and newer |
| macOS (Intel) | `Agentlas-x.y.z-x64.dmg` | Intel Macs |
| Windows | `Agentlas-Setup-x.y.z.exe` · `Agentlas-x.y.z-portable.exe` | Windows 10/11 (x64) |
| Linux | `Agentlas-x.y.z.AppImage` · `Agentlas-x.y.z.deb` | x64 |

### Install from the terminal

Prefer the command line? These one-liners fetch the latest release asset straight
from GitHub (no need to hardcode a version).

**macOS** (auto-detects Apple silicon vs Intel):

```bash
arch=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop/releases/latest \
  | grep -o "https://[^\"]*-${arch}\.dmg" | head -1)
curl -fL "$url" -o Agentlas.dmg && open Agentlas.dmg
```

**Linux (.deb — Debian/Ubuntu):**

```bash
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop/releases/latest \
  | grep -o 'https://[^"]*\.deb' | head -1)
curl -fL "$url" -o agentlas.deb && sudo dpkg -i agentlas.deb
```

**Linux (AppImage — any distro):**

```bash
url=$(curl -fsSL https://api.github.com/repos/agentlas-ai/agentlas-desktop/releases/latest \
  | grep -o 'https://[^"]*\.AppImage' | head -1)
curl -fL "$url" -o Agentlas.AppImage && chmod +x Agentlas.AppImage && ./Agentlas.AppImage
```

**Windows (PowerShell):**

```powershell
$r = Invoke-RestMethod https://api.github.com/repos/agentlas-ai/agentlas-desktop/releases/latest
$u = ($r.assets | Where-Object { $_.name -like 'Agentlas-Setup-*.exe' }).browser_download_url
Invoke-WebRequest $u -OutFile "$env:TEMP\AgentlasSetup.exe"; Start-Process "$env:TEMP\AgentlasSetup.exe"
```

(With the GitHub CLI on any OS: `gh release download -R agentlas-ai/agentlas-desktop --pattern '*.dmg'`.)

### Turn on project ontology from the terminal

Open a project folder and type `agentlas`. Inside the Agentlas terminal:

```text
/ontology
/ontology list
/ontology company ./company-docs
/ontology personal ~/notes
```

### Prepare an agent for Agentlas Cloud calls

Run these from the Agentlas terminal CLI before private Cloud sync or public Hub
publish:

```bash
agentlas cloud wizard ./some-agent --name instagram-operator
agentlas cloud security scan ./some-agent --strict
agentlas cloud runtime bundle ./some-agent
agentlas cloud runtime read-agent-file ./some-agent AGENTS.md
agentlas cloud field-test
```

The wizard writes `agentlas.json`, the scan writes
`.agentlas/security-scan.json`, and lazy reads obey the package allow/deny
rules so secret-like files stay blocked.

Those commands create/use only this project's `.agentlas/` folder. They do not
scan your home folder or other projects.

### Updates — do I need to reinstall?

No. The app updates itself: ~15s after launch and then hourly it checks GitHub
Releases, downloads a newer build in the background, and shows a **"Restart to
update"** badge (the same idea as Codex's update button). Click it to apply.

- **Windows:** auto-update works for the **installer** build (`Agentlas-Setup-*.exe`).
  The **portable** `.exe` does **not** self-update — re-download it to upgrade.
- **macOS / Linux (AppImage):** self-update in place. The `.deb` updates via the
  same in-app flow.

### First-time setup — opening the app the first time

Agentlas Desktop is open source and the public builds aren't paid code-signed on
every platform, so your OS may ask you to confirm the first launch. This is normal
for indie/open-source apps and happens only once.

**macOS** — if you see *"Agentlas can't be opened because Apple cannot check it
for malicious software"*, right-click the app in Applications → **Open** →
**Open**. Or, in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Agentlas.app
open /Applications/Agentlas.app
```

**Windows** — if SmartScreen shows *"Windows protected your PC"*, click
**More info** → **Run anyway**. The portable `.exe` runs without installing.

**Linux** — make the AppImage executable and run it:

```bash
chmod +x Agentlas-*.AppImage
./Agentlas-*.AppImage
# no FUSE on your distro? run:
./Agentlas-*.AppImage --appimage-extract-and-run
```

(Or install the `.deb`: `sudo dpkg -i Agentlas-*.deb`.)

## Getting Started

After installing, the first-run wizard walks you through it — but here's the whole
flow:

1. **Open the app** and let the welcome screen finish (first launch only).
2. **Connect a backend.** Agentlas auto-detects any installed `claude-code`,
   `codex`, or `gemini` CLI. No CLI? Paste an Anthropic / OpenAI / Google API key —
   it goes straight into the OS keychain.
3. **Install an App, team, or agent** from **Apps Store**. Try a firm (a CEO plus
   its departments), a single specialist, or a generated App.
4. **Open Apps** from the sidebar and try **Document Studio**, or start a chat and
   use `/apps` or `/docstudio`.
5. **Pin a working folder** (optional) so the agent can see the repo it's helping with.
6. **Add automations** for recurring runs, and manage App engines and credentials
   from **Apps**.
7. **Coming from OpenClaw or Hermes?** Jump to
   [Migrating from OpenClaw](#migrating-from-openclaw) to bring your SOUL, keys,
   and automations across.

## CLI runtime vs Cloud (BYOK) — quick reference

Agentlas has no separate "CLI app" and "web app" — it's one desktop window. The
choice that matters is **how each run reaches a model**: through a local CLI you've
already logged into, or through a cloud API key you paste in. Both run from your
machine; here's how they differ.

| Action | Local CLI runtime | Cloud API key (BYOK) |
|--------|-------------------|----------------------|
| Connect | Auto-detected (`claude-code` / `codex` / `gemini`) | Paste a key in **Settings → BYOK** |
| Who pays | Your existing subscription / login | Your API account, metered per token |
| Where the key lives | The CLI's own login | The OS keychain (never a file) |
| Works offline-ish | Whatever the CLI supports | No — direct cloud calls |
| Image attachments | Ignored by the CLI (a warning is shown) | Sent as multimodal input |
| Switch active backend | **Settings** → pick a detected runtime | **Settings** → pick a saved key |
| Version pinning | Follows the installed CLI version | Follows the provider's API |

> Agentlas never routes either path through its own servers. The model call goes
> from your machine straight to Anthropic / OpenAI / Google.

## Migrating from OpenClaw

Already running a terminal-style assistant like **OpenClaw**? Bring it across in the
app — **Settings → 다른 도구에서 가져오기 (Import from another tool)**.

Agentlas scans `~/.openclaw` and shows a preview (names and counts only — no secret
values ever leave the main process). Click **Import** and it brings over:

- **Your agent's SOUL / persona** (`workspace/SOUL.md`, `IDENTITY.md`, `USER.md`,
  `AGENTS.md`, `TOOLS.md`) → a new installed agent you can chat with immediately.
- **API keys** from `~/.openclaw/.env` → the OS keychain. Recognized provider keys
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) become BYOK backends;
  other `*_API_KEY` / `*_TOKEN` secrets go into the shared env vault.
- **Scheduled jobs** (`cron/jobs.json`) → automations targeting the imported agent.
- **Memories / workspace** → a "OpenClaw 마이그레이션" project whose context note
  points at your original workspace so you can pin it as a working folder.

Options:

- **Dry run** — preview exactly what would be imported, writing nothing.
- **Overwrite** — re-import on top of a previous import (updates the agent in place).

> Imported automations are session-only in the current M0 build; the persistent
> scheduler lands in V1. Everything else (agent, keys, project) persists.

### Migrating from Hermes

The same importer reads **Hermes** (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on
Windows): `SOUL.md` and workspace instructions become the agent persona, `.env`
keys go to the keychain, and `memories/` are surfaced as a project. Pick **Hermes**
in the same Settings panel.

## Build from source

Requirements: Node.js 20+, npm. (macOS also needs Xcode Command Line Tools, and
Linux needs `libsecret-1-dev`, for the native modules.)

```bash
git clone https://github.com/agentlas-ai/agentlas-desktop.git
cd agentlas-desktop
npm install
npm run dev        # Next.js renderer on :3100 + Electron
```

```bash
npm run typecheck  # TypeScript for electron main + renderer
npm run build      # export renderer + compile electron into dist/
```

Package an installer (unsigned — fine for local use):

```bash
npm run dist:win            # Windows: NSIS installer + portable .exe
npm run dist:linux          # Linux: AppImage + .deb
npm run dist:mac:unsigned   # macOS: unsigned .dmg (no Apple cert needed)
```

Output lands in `release/`. Releases for the public download page are built by
the cross-platform GitHub Actions workflow (`.github/workflows/release.yml`) on a
tag push — see [`docs/PUBLIC-RELEASE.md`](docs/PUBLIC-RELEASE.md). End users don't
need any of that.

## Architecture

```text
Agentlas Desktop
├─ electron/          privileged main process
│  ├─ runtime/        Claude Code, Codex, Gemini, BYOK adapters
│  ├─ mcp/            MCP client and installer
│  ├─ marketplace/    agentlas.cloud Apps Store source
│  ├─ migrate/        OpenClaw / Hermes importer
│  ├─ secrets/        OS keychain vault
│  ├─ store/          SQLite-backed local state
│  └─ updater.ts      electron-updater integration
├─ renderer/          Next.js App Router UI
├─ shared/            typed IPC contracts
├─ scripts/           release, signing, and verification tooling
└─ docs/              architecture and release notes
```

The renderer never gets direct filesystem, keychain, or process-supervision
access — it talks to the main process through a typed preload bridge.

## Documentation

| Document | Covers |
|----------|--------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, IPC bridge, runtime adapters, data flow. |
| [docs/M0-CHECKLIST.md](docs/M0-CHECKLIST.md) | The M0 spike scope and what's verified. |
| [docs/PUBLIC-RELEASE.md](docs/PUBLIC-RELEASE.md) | Cross-platform CI release + the signed/notarized macOS path. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, what to test, and the public-safety rules. |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability. |
| [Migrating from OpenClaw](#migrating-from-openclaw) | Bring a SOUL, keys, and automations over from OpenClaw / Hermes. |

## Security model

- No credentials in Git.
- No API keys written to plaintext local files.
- Renderer code cannot directly read secrets.
- Migration previews send key **names** only — secret values never leave the main process.
- Signing material is git-ignored and injected only during release.
- Auto-update assets are served from GitHub Releases.

Security reports: see [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run
`npm run typecheck`, and keep public safety in mind: no credentials, no local
logs, no signing material. Windows/Linux testing and packaging feedback is
especially appreciated.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
