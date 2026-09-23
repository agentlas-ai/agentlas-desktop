import path from "node:path";
import { isPackagedRuntime, runtimeResourcesPath } from "../runtime-paths";

/**
 * Math uses the signed Python tree that the Desktop release carries. Return
 * its expected path even when an installed package is damaged: a missing
 * engine must be reported, never silently replaced by user Python.
 * Development builds can still use AGENTLAS_MATH_PYTHON or PATH.
 */
export function configureScienceMathPython(): void {
  if (!isPackagedRuntime()) return;
  const resources = runtimeResourcesPath();
  if (!resources) return;
  process.env.AGENTLAS_MATH_PYTHON = path.join(resources, "python-runtime",
    ...(process.platform === "win32" ? ["python.exe"] : ["bin", "python3"]));
}
