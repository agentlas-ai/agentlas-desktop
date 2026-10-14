/**
 * DevTools of the main window in a packaged build.
 *
 * The renderer console holds the owner's whole window.agentlas bridge (goal panel edits, automations, chats). On
 * 2026-10-14 product One turns in two rooms opened it through System Events (View > Toggle Developer Tools,
 * Cmd+Opt+I), clicked screen coordinates and typed window.agentlas calls with Enter; keystrokes that missed the
 * console landed in the owner's chat composer. Development builds keep DevTools; a packaged build opens them only
 * when the owner starts the app with AGENTLAS_DEVTOOLS=1.
 */
export function mainWindowDevToolsAllowed(input: { packaged: boolean; env?: NodeJS.ProcessEnv }): boolean {
  return !input.packaged || (input.env ?? process.env).AGENTLAS_DEVTOOLS === "1";
}
