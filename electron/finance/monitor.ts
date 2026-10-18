import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FinanceAsset, FinanceMonitor } from "../../shared/finance";
import type { Automation } from "../../shared/types";
import type { FinanceScope } from "./store";
import { composeDeclaredPrompt } from "../runtime/prompt-order";
import { userDataPath } from "../runtime-paths";
import { detectRuntimes } from "../runtime/detect";
import { workStartRuntimePin } from "../work-start";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { createAutomation, getAutomation, updateAutomation, toggleAutomation } from "../store/automations";
import { defaultTz, nextRun, parseLegacyToken } from "../store/schedule";

const lockfile = require("proper-lockfile") as { lock(target: string, options: unknown): Promise<() => Promise<void>> };
export const FINANCE_MONITOR_SCHEDULES = ["daily-09:00", "weekday-09:00", "hourly"] as const;

export function financeMonitorPrompt(monitor: FinanceMonitor, assets: FinanceAsset[]): string {
  return composeDeclaredPrompt([
    { id: "finance.monitor.role", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: "finance_monitor: Research the owner's question using available sources. Return a concise briefing with source URLs, observation times, changes and coverage gaps. This is a research schedule; its output is retained in this automation's run history." },
    { id: "finance.monitor.assets", revision: 1, stability: "task-context", changeTriggers: ["task", "retrieval"], text: JSON.stringify({ assets: assets.filter(asset => monitor.assetIds.includes(asset.id)) }) },
    { id: "finance.monitor.request", revision: 1, stability: "turn-context", changeTriggers: ["owner-input"], text: monitor.query },
  ]);
}

type Binding = { automationId: string; scheduleHuman: string };
export interface FinanceMonitorInput { scope: FinanceScope; monitor: FinanceMonitor; assets: FinanceAsset[]; scheduleHuman?: string }

/** The binding is host-owned. A renderer-supplied automationId never grants authority over another job. */
function registry(scope: FinanceScope): string {
  scope.assertCurrent();
  const partition = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId])).digest("hex");
  const directory = userDataPath("finance", "monitor-bindings", partition);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("finance_monitor_store_invalid");
  return directory;
}
function fileFor(directory: string, monitorId: string): string {
  return path.join(directory, `${createHash("sha256").update(monitorId).digest("hex")}.json`);
}
function binding(file: string): Binding | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("finance_monitor_binding_invalid");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Binding;
    if (!/^[a-f0-9-]{36}$/.test(value.automationId) || !FINANCE_MONITOR_SCHEDULES.includes(value.scheduleHuman as typeof FINANCE_MONITOR_SCHEDULES[number])) throw new Error("finance_monitor_binding_invalid");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function writeBinding(file: string, value: Binding): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function projected(monitor: FinanceMonitor, job: Automation): FinanceMonitor {
  return { ...monitor, automationId: job.id, executionAvailability: "app-running", scheduleHuman: job.scheduleHuman,
    status: job.enabled ? "active" : "paused", lastCheckedAt: job.lastRunAt, nextCheckAt: job.enabled ? job.nextRunAt : null,
    note: "Scheduled research runs while Agentlas is running. Briefings and execution outcomes are available in Automations. Pausing prevents future starts; a run already in progress may finish." };
}
export function readFinanceMonitor(input: Pick<FinanceMonitorInput, "scope" | "monitor">): FinanceMonitor {
  const link = binding(fileFor(registry(input.scope), input.monitor.id));
  if (!link) return input.monitor;
  const job = getAutomation(link.automationId);
  return job ? projected(input.monitor, job) : { ...input.monitor, status: "error", nextCheckAt: null, note: "The linked automation is unavailable. Review it in Automations." };
}

export async function scheduleFinanceMonitor(input: FinanceMonitorInput): Promise<FinanceMonitor> {
  const schedule = input.scheduleHuman ?? "daily-09:00";
  if (!FINANCE_MONITOR_SCHEDULES.includes(schedule as typeof FINANCE_MONITOR_SCHEDULES[number]) || !input.monitor.query.trim()) throw new Error("finance_monitor_schedule_invalid");
  const timezone = defaultTz();
  const spec = parseLegacyToken(schedule, timezone);
  if (!spec || !nextRun(spec)) throw new Error("finance_monitor_schedule_invalid");
  const directory = registry(input.scope);
  const release = await lockfile.lock(directory, { realpath: false, stale: 60000, retries: { retries: 30, minTimeout: 20, maxTimeout: 250 } });
  let job: Automation | null = null;
  try {
    input.scope.assertCurrent();
    const file = fileFor(directory, input.monitor.id); const prior = binding(file);
    const prompt = financeMonitorPrompt(input.monitor, input.assets);
    if (prior) {
      job = getAutomation(prior.automationId);
      if (!job) throw new Error("finance_monitor_automation_missing");
      toggleAutomation(job.id, false);
      job = updateAutomation(job.id, { name: input.monitor.name, scheduleHuman: schedule, timezone, promptTemplate: prompt });
    } else {
      const runtimes = await detectRuntimes(); input.scope.assertCurrent();
      const runtime = runtimes.find(item => item.active && !item.signInRequired && item.credentialAccess?.status !== "unavailable");
      const agent = listInstalledAgentsReadOnly().find(item => item.slug === "agentlas-orchestrator");
      if (!runtime || !agent) throw new Error("finance_monitor_runtime_unavailable");
      job = createAutomation({ name: input.monitor.name, scheduleHuman: schedule, timezone, targetType: "agent", targetId: agent.id,
        promptTemplate: prompt, enabled: false, createdBy: "user", executionPermission: "read", toolMode: "browser", hubMode: "local-only",
        runtimeSelection: workStartRuntimePin(runtime) });
    }
    input.scope.assertCurrent();
    writeBinding(file, { automationId: job.id, scheduleHuman: schedule });
    job = toggleAutomation(job.id, true);
    input.scope.assertCurrent();
    return projected(input.monitor, job);
  } catch (error) {
    if (job) { try { toggleAutomation(job.id, false); } catch { /* The caller reports failure and retains the binding for reconciliation. */ } }
    throw error;
  } finally { await release(); }
}

/** Pause has no stale-view/revision requirement and never trusts a renderer's automation ID. */
export async function pauseFinanceMonitor(input: Pick<FinanceMonitorInput, "scope" | "monitor">): Promise<FinanceMonitor> {
  const directory = registry(input.scope);
  const release = await lockfile.lock(directory, { realpath: false, stale: 60000, retries: { retries: 30, minTimeout: 20, maxTimeout: 250 } });
  try {
    input.scope.assertCurrent();
    const prior = binding(fileFor(directory, input.monitor.id));
    if (!prior) throw new Error("finance_monitor_not_scheduled");
    const job = toggleAutomation(prior.automationId, false);
    return projected(input.monitor, job);
  } finally { await release(); }
}

/** Compensation only: revoke this exact host-bound schedule even after its initiating account session changes. */
export async function rollbackFinanceMonitor(input: Pick<FinanceMonitorInput, "scope" | "monitor">): Promise<void> {
  const directory = registry({ ...input.scope, assertCurrent() { /* Revocation retains the captured account partition. */ } });
  const release = await lockfile.lock(directory, { realpath: false, stale: 60000, retries: { retries: 30, minTimeout: 20, maxTimeout: 250 } });
  try {
    const prior = binding(fileFor(directory, input.monitor.id));
    if (!prior || prior.automationId !== input.monitor.automationId) throw new Error("finance_monitor_rollback_binding_mismatch");
    toggleAutomation(prior.automationId, false);
  } finally { await release(); }
}
