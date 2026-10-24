import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "../runtime-paths";
import { bindCodexProductSessionStore } from "../runtime/codex-product-home";

/** A trusted Science host port, never an IPC/model path argument. Grant homes
 * keep their private MCP configuration while the common runtime owns rollouts. */
export function bindScienceCodexProductSessionStore(home: string): void {
  const fail = (): never => { throw Object.assign(new Error("science_codex_session_home_invalid"), { code: "science_codex_session_home_invalid" }); };
  const root = path.resolve(userDataPath("science-codex-home"));
  const name = typeof home === "string" ? path.basename(home) : "";
  if (typeof home !== "string" || !path.isAbsolute(home) || path.dirname(path.resolve(home)) !== root
    || !/^(?:(?:alive-)?session-[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(name)) fail();
  try {
    const rootStat = fs.lstatSync(root), homeStat = fs.lstatSync(home), config = fs.lstatSync(path.join(home, "config.toml"));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.isSymbolicLink()
      || fs.realpathSync(home) !== path.join(fs.realpathSync(root), name)
      || !config.isFile() || config.isSymbolicLink() || config.nlink !== 1
      || (process.platform !== "win32" && (config.mode & 0o077) !== 0)) fail();
  } catch { fail(); }
  bindCodexProductSessionStore(home);
}
