/** Local execution authority, shared by the code runner and confined shell. No host APIs or prompts. */
const SECRET_PATHS = Object.freeze([
  ".ssh", ".aws", ".config/gh", ".gnupg", ".password-store",
]);
const MAC_SECRET_PATHS = Object.freeze([...SECRET_PATHS, "Library/Keychains"]);
const LINUX_SECRET_PATHS = Object.freeze([...SECRET_PATHS, ".local/share/keyrings"]);

export function localSandboxSecretRelativePaths(platform: string): readonly string[] {
  return platform === "darwin" ? MAC_SECRET_PATHS : platform === "linux" ? LINUX_SECRET_PATHS : SECRET_PATHS;
}

/** Execution/config authority inside a writable project. Application dotenv files remain editable. */
const PROTECTED_PATHS = Object.freeze([
  ".git/hooks", ".git/config", ".mcp.json", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
  ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/commands", ".claude/skills", ".claude/hooks",
]);

export function localSandboxProtectedRelativePaths(): readonly string[] { return PROTECTED_PATHS; }
