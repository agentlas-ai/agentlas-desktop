/**
 * Antigravity write-boundary hook: agy starts this process right before one of its tools runs (PreToolUse, plugin hook of the product mirror).
 * The judgment is agy-write-boundary.ts. It acts only when the runner put AGENTLAS_AGY_WRITE_ROOTS in the environment (a write run); the same
 * mirror serves read and full runs untouched. A call it cannot read is refused, never passed.
 */
import { AGY_WRITE_ROOTS_ENV, agyWriteBoundaryRefusal, agyWriteRootsFromEnv, type AgyHookInput } from "./agy-write-boundary";

const chunks: Buffer[] = [];
process.stdin.on("data", (d: Buffer) => chunks.push(d));
process.stdin.on("end", () => {
  if (process.env[AGY_WRITE_ROOTS_ENV] === undefined) return;
  let input: AgyHookInput;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgyHookInput; }
  catch { process.stdout.write(JSON.stringify({ decision: "deny", reason: "permission denied: the write boundary could not read this tool call, so it did not run." })); return; }
  const reason = agyWriteBoundaryRefusal(input, agyWriteRootsFromEnv(process.env[AGY_WRITE_ROOTS_ENV]));
  if (reason) process.stdout.write(JSON.stringify({ decision: "deny", reason }));
});
