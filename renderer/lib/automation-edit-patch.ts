import type { Automation, AutomationHubMode, AutomationToolMode, AutomationUpdatePatch, Trigger, TriggerKind } from "@shared/types";

/**
 * Patch semantics for the automation editor (harness rework E8/S4).
 *
 * An edit sends only the fields the owner changed. The store keeps a field the patch leaves out, so an omitted field is
 * the only way to say "not touched". Sending the form's create defaults for an untouched field rewrote stored data the owner
 * never opened: a schedule reset to daily 09:00, a poll or webhook trigger replaced by `{kind:"schedule"}` (token lost),
 * a monitor contract and an fs trigger's debounce/onlyIf dropped, a Hub version pin moved to the catalog's newest hash,
 * an agent pin cleared. Create is unchanged: it still sends the full spec.
 */
export interface AutomationEditForm {
  name: string;
  /** The prompt as typed, trimmed, with no default applied. */
  promptTemplate: string;
  /** Used only when the owner changed the prompt and left it empty (what a create would send). */
  promptFallback: string;
  targetType: Automation["targetType"];
  targetId: string;
  /** The Hub package hash picked for a hub target; undefined when the target is not a hub agent. */
  hubVersion?: string;
  toolMode: AutomationToolMode;
  hubMode: AutomationHubMode;
  triggerType: TriggerKind;
  fsPath: string;
  fsOn: "create" | "modify" | "delete";
  chainAfter: string;
  /** What the schedule builder reported. null = the owner never changed the schedule it opened with. */
  schedule: { human: string; json: string } | null;
}

/** The trigger the form's own controls describe. Only fs and chain have controls; schedule carries no data. */
function formTrigger(form: AutomationEditForm, stored: Trigger | null): Trigger {
  const sameKind = stored && stored.kind === form.triggerType ? stored : null;
  // Fields the form has no control for (debounceMs, onlyIf, monitor) travel with the stored trigger of the same kind.
  const carried: Record<string, unknown> = {};
  if (sameKind) for (const [key, value] of Object.entries(sameKind)) carried[key] = value;
  else if (stored?.monitor !== undefined) carried.monitor = stored.monitor;
  if (form.triggerType === "fs") return { ...carried, kind: "fs", path: form.fsPath.trim(), on: form.fsOn } as Trigger;
  if (form.triggerType === "chain") return { ...carried, kind: "chain", afterAutomationId: form.chainAfter } as Trigger;
  return { ...carried, kind: "schedule" } as Trigger;
}

function triggerDirty(form: AutomationEditForm, stored: Automation): boolean {
  const storedKind: TriggerKind = stored.triggerType ?? stored.trigger?.kind ?? "schedule";
  if (form.triggerType !== storedKind) return true;
  const trigger = stored.trigger;
  if (form.triggerType === "fs") return trigger?.kind !== "fs" || trigger.path !== form.fsPath.trim() || trigger.on !== form.fsOn;
  if (form.triggerType === "chain") return trigger?.kind !== "chain" || trigger.afterAutomationId !== form.chainAfter;
  return false;
}

export function automationEditPatch(stored: Automation, form: AutomationEditForm): AutomationUpdatePatch {
  const patch: AutomationUpdatePatch = {};
  if (form.name.trim() !== stored.name) patch.name = form.name.trim();
  if (form.promptTemplate !== stored.promptTemplate.trim()) patch.promptTemplate = form.promptTemplate || form.promptFallback;
  if (form.targetType !== stored.targetType || form.targetId !== stored.targetId) {
    patch.targetType = form.targetType;
    patch.targetId = form.targetId;
    // "" releases the pin (latest); a hub target carries the exact package the owner just picked.
    patch.targetVersion = form.targetType === "hub" ? form.hubVersion ?? "" : "";
  }
  if (form.toolMode !== stored.toolMode) patch.toolMode = form.toolMode;
  if (form.hubMode !== stored.hubMode) patch.hubMode = form.hubMode;
  if (triggerDirty(form, stored)) {
    patch.triggerType = form.triggerType;
    patch.trigger = formTrigger(form, stored.trigger ?? null);
  }
  if (form.triggerType === "schedule" && form.schedule) {
    patch.scheduleHuman = form.schedule.human;
    patch.scheduleJson = form.schedule.json;
  }
  return patch;
}
