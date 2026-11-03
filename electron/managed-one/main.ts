import fs from "node:fs";
import path from "node:path";
import { startManagedOneHost } from "./host";
import { validateManagedOneBootstrap } from "./auth";

/** One stderr line that names why the host did not start, without any value from the bootstrap. Error codes of this product
 * (`managed_one_*`) and system codes (`ENOENT`) pass through; any other message could quote the bootstrap (a JSON syntax
 * error shows the text it choked on), so only the error's class name is kept. */
export function managedOneBootFailureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const cause = /^[a-z][a-z0-9_]{2,100}$/.test(message) ? message : typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "unknown";
  return `managed_one_host_boot_failed: ${cause}`;
}

export async function runManagedOneHost(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--bootstrap" || !path.isAbsolute(argv[1])) throw new Error("managed_one_bootstrap_file_required");
  const file = argv[1], stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("managed_one_bootstrap_file_not_private");
  let raw: unknown;
  // The file holds service bearers, so it is removed in every case, but only after it has been read and checked: a bootstrap that
  // fails the check is reported with its reason (below) rather than vanishing unexplained. No service bearer remains in the workspace.
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); validateManagedOneBootstrap(raw); }
  finally { fs.unlinkSync(file); }
  const host = await startManagedOneHost(raw, { onDrained: () => { setTimeout(() => process.exit(0), 100); } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void host.close().then(() => process.exit(0), () => process.exit(1)); });
}
if (require.main === module) void runManagedOneHost().catch(error => { console.error(managedOneBootFailureLine(error)); process.exit(1); });
