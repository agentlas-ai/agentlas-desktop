/**







 */
export function mainWindowDevToolsAllowed(input: { packaged: boolean; env?: NodeJS.ProcessEnv }): boolean {
  return !input.packaged || (input.env ?? process.env).AGENTLAS_DEVTOOLS === "1";
}
