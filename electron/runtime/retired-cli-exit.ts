import type { ChildProcess } from "node:child_process";
import { killCliTree } from "./exec";

/** A sent kill signal is not an exited process. Bound replacement to observed leader exit. */
export async function waitForRetiredCliExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = () => {
      if (child.pid == null || child.exitCode !== null || child.signalCode !== null) finish();
    };
    const timer = setTimeout(() => finish(new Error("runtime_retired_cli_exit_timeout")), 5_000);
    child.once("exit", exited);
    child.once("error", failed);
    // Existing close paths send TERM; shorten escalation for an awaited handoff.
    killCliTree(child, 250);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}
