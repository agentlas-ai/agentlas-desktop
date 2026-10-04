// Renderer surface for Adaptive Toolchains: what the product has learned to do,
// and the narrow owner decisions over it. No local path, prompt or tool output
// crosses this boundary — only states, counts and the contract text.

import type { IpcMain } from "electron";

import {
  applyOwnerDecision,
  type OwnerDecision,
  type ToolchainAutomationView,
  type ToolchainOverview,
} from "../../shared/toolchain";
import { listAutomations } from "../store/automations";
import { exposeAutomation, interfaceIsStale, toolchainTestInProgress, withdrawAutomation } from "./interface";
import { toolchainHistory } from "./history";
import { refreshAllToolchains, refreshToolchainForAutomation } from "./learner";
import { toolchainLogos } from "./logo";
import { listToolchainStates, mutateToolchainState } from "./store";

const DECISIONS: ReadonlySet<OwnerDecision> = new Set(["approve", "dismiss", "demote", "retry"]);

export function toolchainOverview(): ToolchainOverview {
  const states = new Map(listToolchainStates().map((state) => [state.automationId, state]));
  const automations: ToolchainAutomationView[] = [];
  for (const automation of listAutomations()) {
    if (!automation.graph) continue;
    const state = states.get(automation.id);
    automations.push({
      automationId: automation.id,
      automationName: automation.name,
      enabled: automation.enabled,
      refreshedAt: state?.refreshedAt ?? null,
      observations: state?.observations ?? [],
      crystallizations: (state?.crystallizations ?? []).map(({ folder, evidence, ...rest }) => ({
        ...rest,
        folderKnown: Boolean(folder),
        evidence: {
          share: evidence.share,
          eligibleEpisodes: evidence.eligibleEpisodes,
          quality: evidence.quality,
          supportingRuns: evidence.supportingRunIds.length,
        },
      })),
      interface: state?.interface ?? null,
      interfaceStale: state?.interface ? interfaceIsStale(state.interface, automation) : false,
      testInProgress: toolchainTestInProgress(automation.id),
      openReports: (state?.reports ?? []).filter((report) => report.state === "open").reverse()
        .map((report) => ({ at: report.at, problem: report.problem.length > 160 ? `${report.problem.slice(0, 159)}…` : report.problem })),
    });
  }
  return { schemaVersion: "agentlas.toolchain-overview.v1", generatedAt: new Date().toISOString(), automations };
}

function automationIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error("toolchain_automation_id_invalid");
  return value;
}

export function registerToolchainIpc(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle("toolchains:overview", () => toolchainOverview());
  ipc.handle("toolchains:logos", () => toolchainLogos(listAutomations().filter((automation) => automation.graph).map((automation) => automation.id)));
  ipc.handle("toolchains:history", (_event, automationId: unknown) => toolchainHistory(automationIdOf(automationId)));
  ipc.handle("toolchains:refresh", (_event, automationId?: unknown) => {
    if (automationId === undefined || automationId === null) refreshAllToolchains();
    else refreshToolchainForAutomation(automationIdOf(automationId));
    return toolchainOverview();
  });
  ipc.handle("toolchains:decide", (_event, input: unknown) => {
    const bag = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const automationId = automationIdOf(bag.automationId);
    const decision = bag.decision as OwnerDecision;
    if (!DECISIONS.has(decision) || typeof bag.crystallizationId !== "string") throw new Error("toolchain_decision_invalid");
    let refused = false;
    mutateToolchainState(automationId, (current) => {
      const index = current.crystallizations.findIndex((item) => item.id === bag.crystallizationId);
      if (index < 0) { refused = true; return null; }
      const next = applyOwnerDecision(current.crystallizations[index], decision, new Date().toISOString());
      if (!next) { refused = true; return null; }
      const crystallizations = current.crystallizations.slice();
      crystallizations[index] = next;
      return { ...current, crystallizations };
    });
    // An illegal transition is refused, never coerced into the nearest legal one.
    if (refused) throw new Error("toolchain_decision_not_allowed");
    return toolchainOverview();
  });
  ipc.handle("toolchains:expose", async (_event, automationId: unknown) => {
    await exposeAutomation(automationIdOf(automationId), undefined, { kind: "owner" });
    return toolchainOverview();
  });
  ipc.handle("toolchains:withdraw", (_event, automationId: unknown) => {
    withdrawAutomation(automationIdOf(automationId));
    return toolchainOverview();
  });
}
