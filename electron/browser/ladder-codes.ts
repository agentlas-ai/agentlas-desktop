/**
 * The closed list of browser ladder stops that mean the Agentlas browser TOOL broke (Agentlas 2.0 N1a).
 * No imports: pure modules (gates) load it directly.
 */
/**
 * Browser ladder stops (browser/fallback-ladder.ts BROWSER_FAILURE_CODES) that mean the Agentlas browser TOOL broke: a cut
 * bridge, a browser that would not start or died, the in-app guest or session gone, a refused tab, the MCP not attached, a failed
 * native call. Only these may be answered with the runtime's own tools. Not here, on purpose: ownership-unverifiable (the host could not
 * prove whose browser it is) and port-foreign (a browser outside the Agentlas profile is never driven) are safety verdicts, login-wall
 * and human-check-required are the owner's, and page-load-failed is the site, not the tool.
 */
export const HARNESS_TOOL_BREAKAGE_LADDER_CODES: ReadonlySet<string> = new Set([
  "bridge-wire-dropped", "chrome-launch-failed", "chrome-crashed", "native-session-ended", "native-tab-limit", "native-guest-destroyed",
  "browser-mcp-not-attached", "native-tool-failed",
]);
