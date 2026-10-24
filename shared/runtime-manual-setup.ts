/**
 * Setup a person runs by hand for the subscription CLIs this app does not install itself, per operating system.
 *
 * One table for every place that shows it: the connect popup (Main sends PLANS.cursor.manualInstall), the
 * dashboard engine cards (EngineUsage) and the Settings subscription panel. Before this the three places
 * carried one literal each, and on Windows they showed `curl … | bash` and a bare `gh auth login` (Windows
 * test of 1.3.88, 2026-10-23): neither runs in PowerShell, and `gh` was never installed.
 *
 * Sources, checked 2026-10-24:
 *  - Cursor CLI: cursor.com/docs/cli/installation. macOS, Linux and WSL `curl https://cursor.com/install -fsS | bash`;
 *    native Windows PowerShell `irm 'https://cursor.com/install?win32=true' | iex`, which installs
 *    %LOCALAPPDATA%\cursor-agent\{cursor-agent,agent}.cmd and adds that folder to the user PATH.
 *  - GitHub Copilot CLI: docs.github.com "Authenticating GitHub Copilot CLI". It reads, in order,
 *    COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, its keychain login, and last the GitHub CLI (`gh auth token`).
 *    This app starts Copilot CLI with `npx -y @github/copilot@<pin> --acp` (acp.ts ACP_AGENTS), so the machine
 *    needs Node.js 22+ for npx, and the GitHub CLI signed in. winget ids: OpenJS.NodeJS.LTS, GitHub.cli
 *    (cli.github.com); Homebrew formulae: node, gh.
 *
 * UI text only. Nothing here reaches a model.
 */

export type SetupOs = "macos" | "windows" | "linux";
export type ManualSetupRuntime = "cursor" | "github-copilot-cli";

export interface ManualSetup {
  /** Where the lines run. PowerShell syntax (`irm … | iex`) does not run in cmd.exe, and bash syntax does not run in PowerShell. */
  shell: "powershell" | "terminal";
  /** Commands, one per line, in order. */
  lines: string[];
  /** What the person must know beyond the lines, or null. */
  note: { ko: string; en: string } | null;
}

/** Node's process.platform → the three systems the app ships for. Anything else reads as Linux (a POSIX shell). */
export function setupOsFromNodePlatform(platform: string): SetupOs {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

/** The renderer's view of the same fact (navigator), matching renderer/app/layout.tsx PLATFORM_BOOTSTRAP. */
export function setupOsFromNavigator(nav: { platform?: string; userAgent?: string } | undefined): SetupOs {
  const value = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  if (/Win32|Win64|Windows/i.test(value)) return "windows";
  if (/Mac/i.test(value)) return "macos";
  return "linux";
}

const CURSOR_POSIX = "curl https://cursor.com/install -fsS | bash";
const CURSOR_WINDOWS = "irm 'https://cursor.com/install?win32=true' | iex";

export function manualSetupFor(runtime: ManualSetupRuntime, os: SetupOs): ManualSetup {
  if (runtime === "cursor") {
    return os === "windows"
      ? { shell: "powershell", lines: [CURSOR_WINDOWS], note: null }
      : { shell: "terminal", lines: [CURSOR_POSIX], note: null };
  }
  if (os === "windows") {
    return {
      shell: "powershell",
      lines: ["winget install -e --id OpenJS.NodeJS.LTS", "winget install -e --id GitHub.cli", "gh auth login"],
      note: {
        ko: "Copilot CLI는 Node.js(npx)로 실행되고 GitHub CLI 로그인을 씁니다. 이미 있는 것은 건너뛰세요. 설치 뒤 Agentlas를 다시 시작해야 새 경로를 찾습니다.",
        en: "Copilot CLI runs through Node.js (npx) and uses the GitHub CLI sign-in. Skip what you already have. Restart Agentlas after installing so it finds the new PATH.",
      },
    };
  }
  if (os === "macos") {
    return {
      shell: "terminal",
      lines: ["brew install node gh", "gh auth login"],
      note: {
        ko: "Copilot CLI는 Node.js(npx)로 실행되고 GitHub CLI 로그인을 씁니다. 이미 있는 것은 건너뛰세요.",
        en: "Copilot CLI runs through Node.js (npx) and uses the GitHub CLI sign-in. Skip what you already have.",
      },
    };
  }
  return {
    shell: "terminal",
    lines: ["gh auth login"],
    note: {
      ko: "먼저 Node.js 22 이상과 GitHub CLI를 설치하세요(https://github.com/cli/cli#installation). Copilot CLI는 npx로 실행되고 GitHub CLI 로그인을 씁니다.",
      en: "First install Node.js 22+ and the GitHub CLI (https://github.com/cli/cli#installation). Copilot CLI runs through npx and uses the GitHub CLI sign-in.",
    },
  };
}

/** The lines as one copyable block. */
export function manualSetupText(setup: ManualSetup): string {
  return setup.lines.join("\n");
}

/** Label for where to run it. */
export function manualSetupShellLabel(setup: ManualSetup, ko: boolean): string {
  if (setup.shell === "powershell") return ko ? "PowerShell에서 실행:" : "Run in PowerShell:";
  return ko ? "터미널에서 실행:" : "Run in Terminal:";
}
