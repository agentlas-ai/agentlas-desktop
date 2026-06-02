<p align="center">
  <img src="assets/agentlas-desktop-banner.svg" alt="Agentlas Desktop banner">
</p>

<h1 align="center">Agentlas Desktop</h1>

<p align="center">
  <strong>Run recurring business work with the AI agents and teams you built on Agentlas.</strong>
</p>

<p align="center">
  Build and review an agent package on <a href="https://agentlas.cloud">agentlas.cloud</a>, download or import it into Desktop,
  connect the AI account you already pay for, and run weekly work from your own machine.<br>
  Your local chats and installed agents stay on your machine; model, marketplace, auth, and update calls happen only through the services you choose.
</p>

<!-- ── Download (primary action) ───────────────────────────────────────── -->
<p align="center">
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
    <img alt="Download for macOS — Apple Silicon" src="https://img.shields.io/badge/Download_for_Mac-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
    <img alt="Download for macOS — Intel" src="https://img.shields.io/badge/Download_for_Mac-Intel-555555?style=for-the-badge&logo=apple&logoColor=white">
  </a>
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
    <img alt="Download for Windows" src="https://img.shields.io/badge/Download_for-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white">
  </a>
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
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
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">Releases</a>
  ·
  <a href="#documentation">Docs</a>
</p>

<p align="center">
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jeongmk522-netizen/agentlas-desktop?include_prereleases&label=download&color=blue">
  </a>
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green">
  </a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20Gemini%20%7C%20API%20keys-black">
</p>

<p align="center">
  <img alt="Agentlas Desktop running a CEO agent over a live org chart" src="docs/screenshot.png" width="960">
</p>

### What you get

| | |
|---|---|
| **Recurring work office** | Run weekly content, launch packages, client reports, support replies, and other agent jobs |
| **Web package handoff** | Download or import agents and teams built on `agentlas.cloud` |
| **CLI + API runtimes** | Claude Code · Codex · Gemini CLI · Anthropic/OpenAI/Google API keys |
| **3 cloud providers** | Anthropic · OpenAI · Google, using *your* key |
| **No model proxy** | Agentlas runs no hosted model and never proxies a call |
| **Local-first state** | chats and installed agents in local SQLite; credentials stay in local keychain/files you control |
| **Agent teams, visible** | every team renders as an org chart, not a black box |
| **Recurring work** | schedule recurring runs while Desktop is running |
| **Marketplace** | install single agents or whole teams from Agentlas sources |
| **Platform status** | macOS stable path; Windows/Linux preview builds on GitHub Releases |
| **Apache-2.0** | audit it, fork it, ship your own variant |

Connect the AI models you already pay for, import agents or whole teams, and run
recurring business work from one local window. The org chart, source files, run
artifacts, schedules, and credentials stay inspectable instead of disappearing
inside a generic chatbot.

- **Use your existing AI account.** Claude Code, Codex, and Gemini CLI, or
  OpenAI / Anthropic / Google API keys directly. Agentlas never proxies the model call.
- **Import web-built packages.** Drop in an agent or a whole team — for example a
  package you built on [agentlas.cloud](https://agentlas.cloud) — and run it.
- **See the team, not a black box.** Every agent team renders as an org chart and
  a file tree, so you can see who does what and which repo each run touches.
- **Run and orchestrate locally.** The app supervises the agent processes and
  routes work between roles, all on your disk.
- **Local-first.** Settings-saved keys use the OS keychain, imported `.env` and
  CLI credentials may still live in local files you control, and chats/installed
  agents live in local SQLite. Open source, Apache-2.0 — fork it, audit it, ship a variant.

## Who it's for

- **Small-business owners and operators** who want recurring AI work without an
  agency retainer or a second model bill.
- **Agencies and freelancers** who package repeatable client workflows on
  [agentlas.cloud](https://agentlas.cloud) and run them locally.
- **Power users** who already pay for Claude, ChatGPT, or Gemini and want to run
  agents on that subscription instead of paying a second AI bill to an agent SaaS.
- **Privacy-minded teams** who refuse to hand their API keys and chat history to a
  third-party agent platform.
- **Developers and tinkerers** who want an open-source, auditable, forkable agent runner.

## Features

A complete tour of what ships today.

### Connect the AI account you already pay for

- **Local CLI runtimes, auto-detected.** Agentlas finds your installed
  `claude-code`, `codex`, and `gemini` CLIs and runs through them — using the
  subscription/login you already have. No re-auth, no copy-pasting keys.
- **Cloud API keys.** No CLI? Paste an Anthropic, OpenAI, or Google API key and
  go. Keys saved in Settings use the OS keychain; imported `.env` files and CLI
  credential files remain local files under your control.
- **Mix and switch freely.** Have Claude Code *and* a Gemini key? Both show up; pick
  the active backend per run. Most apps lock you to one provider — Agentlas doesn't.
- **No Agentlas model proxy.** Model calls go from your machine to the selected
  provider or local CLI. Agentlas runs no hosted LLM and adds **$0** to your model bill.

### Agent teams for recurring business work

- **Install a whole team.** A team has a CEO agent that delegates down to
  department heads and workers — e.g. a storefront-ops team with content, CS, and
  analytics roles.
- **Live org chart.** Every team renders as a hierarchy so you can see who reports
  to whom and which role handles what — no black box.
- **Chat the CEO, mobilize the team.** Message the CEO and it routes work to the
  right roles, or talk to any single specialist directly.

### Projects, chats, and history that stay yours

- **Projects** group related chats, apply a shared context note, and set a default
  agent so every new chat starts with the right context.
- **Chats** support rename, archive/unarchive, switching the bound agent, and full
  message history — all in **local SQLite**, nothing on a server.
- **Image attachments** are sent as multimodal input on supported API-key backends.
- **Working-folder panel** pins a folder to a chat with a read-only file tree and
  text preview, so you can see the repo an agent is helping with.

### Install agents and teams from the marketplace

- **Agentlas installs.** Browse and install agents and whole teams from the
  `agentlas.cloud` marketplace; they run through local runtime adapters.
- **Trust grades.** Listings carry a trust grade; sideloading unvetted agents is
  gated.
- **Works offline.** An in-memory fallback source keeps the marketplace usable when
  the network or cloud is down.

### Library — manage the whole toolbox

- **Agents, Skills, external tools, and a shared env-var vault** in one place. The
  vault tracks which environment variables each agent needs and which are set —
  values are handled through local credential storage, and the UI only shows whether a key exists.

### Recurring work

- **Schedule recurring runs** against an agent or a team from a prompt template.
  Desktop checks due recurring jobs while the app is running, and saved entries persist
  across restarts.

### Migrate in — never locked in

- **Import from OpenClaw and Hermes** in one click: SOUL/persona → an agent, `.env`
  keys → the keychain, scheduled jobs → automations, memories → a project. Dry-run
  and overwrite supported. Secret values never leave the main process.
- **Apache-2.0 open source.** Audit it, fork it, ship your own variant.

### Local-first security

- API keys saved in Settings live in the **macOS/Windows/Linux keychain** via the
  main process. Imported `.env` files and CLI credential files may still exist as
  local plaintext files you control; the renderer/UI does not directly read the keychain.
- Chats, projects, teams, and installed agents live in **local SQLite**.

### Cross-platform status, updates, bilingual UI

- **macOS (arm64 + Intel)** is the stable public path.
- **Windows (installer + portable), Linux (AppImage + deb)** are preview builds on GitHub Releases.
- **Updates** are checked through GitHub Releases where the platform/build supports it; portable and preview builds may require a fresh download.
- **Full Korean / English UI** with automatic locale detection.

## How Agentlas compares

Three common ways to run AI agents today — and where Agentlas lands.

| | **Agentlas Desktop** | Hosted agent platform (SaaS) | Single-model desktop chat | Raw terminal CLI |
|---|---|---|---|---|
| Where model calls go | **Direct from your machine** | Through their servers | Direct | Direct |
| Who pays for tokens | **Your existing sub / key** | Platform fee **+** tokens | Your sub / key | Your sub / key |
| Where keys & history live | **Local keychain/files + local SQLite** | Their cloud | Local (varies) | Local |
| Multi-agent teams + org chart | **Yes** | Sometimes | No | No (manual) |
| Install marketplace agents | **Yes** | Varies | No | Manual |
| Use local CLIs (Claude Code / Codex / Gemini) | **Yes** | Rarely | No | One at a time |
| Mix CLIs **and** cloud keys in one window | **Yes** | No | No | No |
| Open source (Apache-2.0) | **Yes** | Usually no | Varies | Varies |
| Desktop GUI on mac / win / linux | **Yes** | Web only | Often | No (terminal) |

**Why people pick Agentlas**

- **It runs on the AI you already pay for.** No second subscription to an agent
  platform — your Claude/ChatGPT/Gemini plan does the work.
- **Local-first, no Agentlas model proxy.** Chats and installed agents live in local
  SQLite; Settings-saved keys use the keychain; imported credential files stay on your disk.
  Model calls go to the provider you select, and marketplace/auth/update traffic may contact Agentlas or GitHub.
- **Teams of agents, visible.** Agent teams with a real org chart beat a single opaque
  chatbot when work needs more than one role.
- **Open and portable.** Apache-2.0, importable from OpenClaw/Hermes, forkable — no
  lock-in.

## Screens

| Screen | What it does |
|--------|--------------|
| **Home** | Landing dashboard — recent chats, installed teams, quick actions. |
| **Chat** | One-on-one conversation with an agent or an agent team's CEO. Supports image attachments on API-key backends. |
| **Archived chats** | Chats you've archived — hidden from the sidebar, restorable anytime. |
| **Projects** | Create and open projects; each carries a default agent and a shared context note. |
| **Agent team detail** | The team's org chart — CEO → department heads → workers, plus the operating persona. |
| **Recurring work** | List, create, and toggle scheduled runs targeting an agent or a team. |
| **Library · Agents** | Installed agents, their tone/persona, and trust grade. |
| **Library · Skills** | Skills available to your installed agents. |
| **Library · External tools** | Installed external tool servers and their manifests. |
| **Library · Env** | The shared environment-variable vault — which keys are set and which agents require them. |
| **Marketplace** | Browse and install agents and teams from `agentlas.cloud` (with an offline in-memory fallback). |
| **Settings** | AI account connections, API keys, language, and migration from OpenClaw / Hermes. |
| **Onboarding** | First-run wizard: welcome → connect an AI account → menu tour → install your first team. |

## AI account connections

Agentlas connects to models two ways — through a **local CLI** you already have
installed, or with a **cloud API key**. Either way the call goes straight
from your machine to the provider; Agentlas never sits in the middle.

| Provider | How it connects | Notes |
|----------|-----------------|-------|
| **Claude Code** | Local CLI (`claude-code`) | Auto-detected. Uses your existing Claude subscription/login. |
| **Codex** | Local CLI (`codex`) | Auto-detected. Uses your existing ChatGPT/OpenAI login. |
| **Gemini** | Local CLI (`gemini`) | Auto-detected. Uses your existing Google login. |
| **Anthropic** | API key | `console.anthropic.com → API Keys`. Settings saves it through the OS keychain. |
| **OpenAI** | API key | `platform.openai.com/api-keys`. Settings saves it through the OS keychain. |
| **Google (Gemini)** | API key | `aistudio.google.com/app/apikey`. Settings saves it through the OS keychain. |

You need **one** of these to start — a single detected CLI or a single API key.
Add more later in **Settings**.

## Quick install

Get the latest build from the [**Releases page**](https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest).

| OS | File | Notes |
|----|------|-------|
| macOS (Apple silicon) | `Agentlas-x.y.z-arm64.dmg` | M1 and newer |
| macOS (Intel) | `Agentlas-x.y.z-x64.dmg` | Intel Macs |
| Windows | `Agentlas-Setup-x.y.z.exe` · `Agentlas-x.y.z-portable.exe` | Preview, Windows 10/11 (x64) |
| Linux | `Agentlas-x.y.z.AppImage` · `Agentlas-x.y.z.deb` | Preview, x64 |

### Install from the terminal

Prefer the command line? These one-liners fetch the latest release asset straight
from GitHub (no need to hardcode a version).

**macOS** (auto-detects Apple silicon vs Intel):

```bash
arch=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo x64)
url=$(curl -fsSL https://api.github.com/repos/jeongmk522-netizen/agentlas-desktop/releases/latest \
  | grep -o "https://[^\"]*-${arch}\.dmg" | head -1)
curl -fL "$url" -o Agentlas.dmg && open Agentlas.dmg
```

**Linux (.deb — Debian/Ubuntu):**

```bash
url=$(curl -fsSL https://api.github.com/repos/jeongmk522-netizen/agentlas-desktop/releases/latest \
  | grep -o 'https://[^"]*\.deb' | head -1)
curl -fL "$url" -o agentlas.deb && sudo dpkg -i agentlas.deb
```

**Linux (AppImage — any distro):**

```bash
url=$(curl -fsSL https://api.github.com/repos/jeongmk522-netizen/agentlas-desktop/releases/latest \
  | grep -o 'https://[^"]*\.AppImage' | head -1)
curl -fL "$url" -o Agentlas.AppImage && chmod +x Agentlas.AppImage && ./Agentlas.AppImage
```

**Windows (PowerShell):**

```powershell
$r = Invoke-RestMethod https://api.github.com/repos/jeongmk522-netizen/agentlas-desktop/releases/latest
$u = ($r.assets | Where-Object { $_.name -like 'Agentlas-Setup-*.exe' }).browser_download_url
Invoke-WebRequest $u -OutFile "$env:TEMP\AgentlasSetup.exe"; Start-Process "$env:TEMP\AgentlasSetup.exe"
```

(With the GitHub CLI on any OS: `gh release download -R jeongmk522-netizen/agentlas-desktop --pattern '*.dmg'`.)

### Updates — do I need to reinstall?

Usually not for supported installer builds. The app checks GitHub Releases after
launch and can show a **"Restart to update"** badge when a newer compatible build
is downloaded. Portable and preview builds may need a fresh download.

- **Windows:** auto-update is intended for the **installer** build (`Agentlas-Setup-*.exe`).
  The **portable** `.exe` does **not** self-update — re-download it to upgrade.
- **macOS / Linux:** check the release notes for the current asset; preview Linux
  builds may require a fresh download or package reinstall.

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
2. **Connect an AI account.** Agentlas auto-detects any installed `claude-code`,
   `codex`, or `gemini` CLI. No CLI? Paste an Anthropic / OpenAI / Google API key —
   Settings saves it through the OS keychain.
3. **Install a team or an agent** from the **Marketplace**. Try a team for recurring
   business work or a single specialist for one job.
4. **Start a chat** from the sidebar. Pick the agent or the team's CEO and type the outcome.
5. **Pin a working folder** (optional) so the agent can see the repo it's helping with.
6. **Add recurring work** for scheduled runs, and manage everything from **Library**.
7. **Coming from OpenClaw or Hermes?** Jump to
   [Migrating from OpenClaw](#migrating-from-openclaw) to bring your SOUL, keys,
   and automations across.

## CLI runtime vs Cloud API key — quick reference

Agentlas has no separate "CLI app" and "web app" — it's one desktop window. The
choice that matters is **how each run reaches a model**: through a local CLI you've
already logged into, or through a cloud API key you paste in. Both run from your
machine; here's how they differ.

| Action | Local CLI runtime | Cloud API key |
|--------|-------------------|----------------------|
| Connect | Auto-detected (`claude-code` / `codex` / `gemini`) | Paste a key in **Settings → API keys** |
| Who pays | Your existing subscription / login | Your API account, metered per token |
| Where the key lives | The CLI's own login/local files | Settings-saved keys use the OS keychain; imported `.env` files can remain local plaintext |
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
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) become API-key backends;
  other `*_API_KEY` / `*_TOKEN` secrets go into the shared env vault.
- **Scheduled jobs** (`cron/jobs.json`) → recurring work targeting the imported agent.
- **Memories / workspace** → a "OpenClaw 마이그레이션" project whose context note
  points at your original workspace so you can pin it as a working folder.

Options:

- **Dry run** — preview exactly what would be imported, writing nothing.
- **Overwrite** — re-import on top of a previous import (updates the agent in place).

> Imported scheduled jobs become saved recurring-work entries. Desktop checks due
> runs while the app is running; it does not claim an always-on system daemon.

### Migrating from Hermes

The same importer reads **Hermes** (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on
Windows): `SOUL.md` and workspace instructions become the agent persona, `.env`
recognized keys are imported through the local credential flow, and `memories/` are surfaced as a project. Pick **Hermes**
in the same Settings panel.

## Build from source

Requirements: Node.js 20+, npm. (macOS also needs Xcode Command Line Tools, and
Linux needs `libsecret-1-dev`, for the native modules.)

```bash
git clone https://github.com/jeongmk522-netizen/agentlas-desktop.git
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
│  ├─ runtime/        Claude Code, Codex, Gemini, API-key adapters
│  ├─ mcp/            MCP client and installer
│  ├─ marketplace/    agentlas.cloud marketplace source
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
- Settings-saved API keys avoid renderer-readable plaintext files; CLI and imported
  `.env` credentials may still exist as local files under user control.
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
