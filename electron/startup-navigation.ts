/**
 * Classify navigation failures that are expected during Electron startup.
 * Placeholder/data URLs and dev-server transitions must not pollute the
 * production startup incident stream, while a packaged app failure must remain
 * visible as an actual startup failure.
 */
export type StartupNavigationFailureKind =
  | "aborted"
  | "placeholder"
  | "dev-server"
  | "about-blank"
  | "unexpected";

export interface StartupNavigationFailureInput {
  url?: string;
  errorCode?: number | string;
  errorDescription?: string;
  isPackaged: boolean;
  devStartUrl?: string;
}

function numericErrorCode(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

function isLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  } catch {
    return false;
  }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function classifyStartupNavigationFailure(
  input: StartupNavigationFailureInput,
): StartupNavigationFailureKind {
  const url = (input.url ?? "").trim();
  const description = (input.errorDescription ?? "").trim();
  const code = numericErrorCode(input.errorCode);
  if (code === -3 || /ERR_ABORTED|aborted/i.test(description)) return "aborted";
  if (url === "about:blank") return "about-blank";
  if (/^data:text\/html(?:;|,)/i.test(url)) return "placeholder";
  if (
    !input.isPackaged
    && input.devStartUrl
    && isLoopback(url)
    && sameOrigin(url, input.devStartUrl)
    && (code === -2 || code === -102 || /ERR_(?:FAILED|CONNECTION_REFUSED)/i.test(description))
  ) {
    return "dev-server";
  }
  return "unexpected";
}

export function isExpectedStartupNavigationFailure(
  input: StartupNavigationFailureInput,
): boolean {
  return classifyStartupNavigationFailure(input) !== "unexpected";
}
