import { execFile } from "node:child_process";
import { win32 } from "node:path";

export interface LocalProcessIdentity { pid: number; executablePath: string | null; commandLine: string; createdAt: string | null }
export type ProcessCommandRunner = (executable: string, args: string[]) => Promise<string>;
const run: ProcessCommandRunner = (executable,args) => new Promise((resolve,reject) => {
  execFile(executable,args,{maxBuffer:65536,timeout:5000,windowsHide:true},(error,stdout) => error ? reject(error) : resolve(stdout));
});

/** CommandLineToArgvW quote/backslash rules, used only to compare a read-only CIM receipt. */
export function windowsCommandArguments(command: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? "") && i < command.length) i++;
    if (i >= command.length) break;
    let value = "", quoted = false;
    while (i < command.length) {
      if (!quoted && /\s/.test(command[i]!)) break;
      let slashes = 0;
      while (command[i] === "\\") { slashes++; i++; }
      if (command[i] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; i++; }
        else if (quoted && command[i+1] === '"') { value += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else { value += "\\".repeat(slashes); if (!quoted && /\s/.test(command[i] ?? "")) break; if (i < command.length) value += command[i++]!; }
    }
    if (quoted) return [];
    result.push(value);
  }
  return result;
}

export async function observeLocalProcessIdentity(pid: number, options: { platform?: NodeJS.Platform; systemRoot?: string; commandRunner?: ProcessCommandRunner } = {}): Promise<LocalProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const platform = options.platform ?? process.platform, execute = options.commandRunner ?? run;
  try {
    if (platform === "win32") {
      const systemRoot = options.systemRoot ?? process.env.SystemRoot;
      if (!systemRoot || !win32.isAbsolute(systemRoot)) return null;
      const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -ne $p){[pscustomobject]@{pid=[int]$p.ProcessId;executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
      const executable = win32.join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe");
      const text = await execute(executable,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")]);
      const value = JSON.parse(text) as Partial<LocalProcessIdentity>;
      if (value.pid !== pid || typeof value.executablePath !== "string" || !win32.isAbsolute(value.executablePath)
        || typeof value.commandLine !== "string" || value.commandLine.length > 32768
        || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
      return value as LocalProcessIdentity;
    }
    if (platform !== "darwin" && platform !== "linux") return null;
    const commandLine = (await execute("/bin/ps",["-p",String(pid),"-o","command="])).trim();
    return commandLine ? {pid,commandLine,executablePath:null,createdAt:null} : null;
  } catch { return null; }
}

export function matchesLocalProcessIdentity(identity: LocalProcessIdentity, expected: { pid: number; executablePath: string; modelPath: string; processCreatedAt?: string | null }, platform = process.platform): boolean {
  if (identity.pid !== expected.pid) return false;
  if (platform !== "win32") return identity.commandLine.includes(expected.executablePath) && identity.commandLine.includes(expected.modelPath);
  if (!expected.processCreatedAt || identity.createdAt !== expected.processCreatedAt || !identity.executablePath) return false;
  const normalize = (value: string) => win32.normalize(value).toLowerCase();
  if (normalize(identity.executablePath) !== normalize(expected.executablePath)) return false;
  const args = windowsCommandArguments(identity.commandLine), position = args.indexOf("--model");
  return args.length > 0 && normalize(args[0]!) === normalize(expected.executablePath)
    && position > 0 && args.filter(value => value === "--model").length === 1 && !!args[position+1]
    && normalize(args[position+1]!) === normalize(expected.modelPath);
}

export async function terminateMatchedLocalProcess(expected: Parameters<typeof matchesLocalProcessIdentity>[1], options: {
  platform?: NodeJS.Platform;
  observe?: (pid: number) => Promise<LocalProcessIdentity | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  delay?: () => Promise<void>;
} = {}): Promise<void> {
  const observe = options.observe ?? observeLocalProcessIdentity;
  const kill = options.kill ?? ((pid,signal) => { process.kill(pid,signal); });
  const alive = options.alive ?? (pid => { try { process.kill(pid,0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
  const delay = options.delay ?? (() => new Promise(resolve => setTimeout(resolve,100)));
  if (!alive(expected.pid)) return;
  const identity = await observe(expected.pid);
  if (!identity || !matchesLocalProcessIdentity(identity,expected,options.platform)) throw new Error("local_model_process_lease_command_mismatch");
  kill(expected.pid,"SIGTERM");
  for (let i = 0; i < 50; i++) { if (!alive(expected.pid)) return; await delay(); }
  // PID reuse must never turn escalation into a signal to another process.
  const current = await observe(expected.pid);
  if (!current || !matchesLocalProcessIdentity(current,expected,options.platform)) throw new Error("local_model_process_identity_changed");
  kill(expected.pid,"SIGKILL");
  for (let i = 0; i < 20; i++) { if (!alive(expected.pid)) return; await delay(); }
  throw new Error("local_model_process_shutdown_unconfirmed");
}
