import fs from "node:fs";
import path from "node:path";
import { startManagedOneHost } from "./host";

export async function runManagedOneHost(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--bootstrap" || !path.isAbsolute(argv[1])) throw new Error("managed_one_bootstrap_file_required");
  const file = argv[1], stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("managed_one_bootstrap_file_not_private");
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  // Consume before tools can start. No service bearer remains in the workspace.
  fs.unlinkSync(file);
  const host = await startManagedOneHost(raw, { onDrained: () => { setTimeout(() => process.exit(0), 100); } });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void host.close().then(() => process.exit(0), () => process.exit(1)); });
}
if (require.main === module) void runManagedOneHost().catch(() => { console.error("managed_one_host_boot_failed"); process.exit(1); });
