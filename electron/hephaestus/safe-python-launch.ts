// The one place that builds a Python command line for an Agentlas engine module (`agentlas_cloud`, `ontology`, `career_graph`).
//
// `python -c` and `python -m` put the current directory first on sys.path. Desktop runs the engine in a chat's project folder,
// and external hosts (Claude Code, Codex) start the engine MCP server from the folder the user opened, so a folder that
// carries `agentlas_cloud/` or a file named like a standard-library module (`runpy.py`, `json.py`) would be loaded in place of
// the installed engine. The text below removes every relative sys.path entry (the empty string is the current directory)
// BEFORE it imports runpy: on Python 3.9 and 3.10 runpy is not frozen, so importing it first loads the folder's runpy.py.
//
// Same text as the engine's own `BOOTSTRAP` (Agentlas-OS agentlas_cloud/safe_launch.py), `bin/hephaestus`, and the
// `AGENTLAS_SAFE_RUNPY` value, so one behaviour holds on every host. No `-I`: it would drop PYTHONPATH and PYTHONUTF8.
export const SAFE_PY_BOOTSTRAP =
  "import os,sys;" +
  "sys.path[:]=[p for p in sys.path if os.path.isabs(p) and not (os.path.exists(p) and os.path.exists(os.curdir) and os.path.samefile(p,os.curdir))];" +
  "import runpy;" +
  "r=sys.argv[1];" +
  "sys.path.insert(0,r);" +
  "sys.argv=sys.argv[2:];" +
  "runpy.run_module(sys.argv[0],run_name='__main__',alter_sys=True)";

/**
 * Arguments after the interpreter for `python -m <module> <args...>` with only `runtimeRoot` (an absolute path) as the engine
 * location. `prefix` is the interpreter's own leading arguments (`["-3"]` for the Windows `py` launcher, else `[]`).
 */
export function safeModuleArgs(runtimeRoot: string, module: string, args: readonly string[], prefix: readonly string[] = []): string[] {
  return [...prefix, "-c", SAFE_PY_BOOTSTRAP, runtimeRoot, module, ...args];
}

/**
 * PYTHONPATH the child inherits from the user's shell, minus every relative entry (`.`, `src`, the empty string): the
 * interpreter puts those on sys.path at startup, before any bootstrap text runs, and they resolve against the project folder.
 */
export function absolutePythonPathEntries(value: string | undefined, delimiter: string, isAbsolute: (entry: string) => boolean): string {
  return (value ?? "").split(delimiter).filter((entry) => entry.length > 0 && isAbsolute(entry)).join(delimiter);
}
