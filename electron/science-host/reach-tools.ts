import type { ToolPermission } from "../../shared/builtin-tools";
import { REACH_PORT_SCHEMAS } from "../reach-host/schemas";

/*
 * Agentlas Reach (the harness reach.* ports) for Science turns.
 *
 * Science turns carry no harness_call, so, like the office-document ports (document-tools.ts), the seven Reach ports are one more server of the
 * lazy Desktop catalogue (list_desktop_tools -> call_desktop_tool). Nothing is reimplemented: each tool is the harness port itself, called
 * through the same dispatcher One, Work, Finance and the personal agent use (harness/capability-ports.ts callHarnessPort), with the turn's own
 * authority:
 *   chatId     the Science runtime chat
 *   runId      the turn's invocation run (the dispatcher writes its receipt under it)
 *   permission the turn's real tool permission; a read-only turn may only carry out capabilities the app declares as reads, exactly as elsewhere
 * What the port answers is returned as it is: ok, refused or unavailable with a reason. A host without the desktop's driver (the daemon) still
 * answers map / app / describe / status from the files the map left on disk and says `unavailable` for the ones that drive an app.
 * No electron import (the daemon loads the Science host); the dispatcher is loaded on first use.
 */

export const SCIENCE_REACH_SERVER_ID = "desktop-apps";

export const SCIENCE_REACH_SERVER_DESCRIPTION = "Apps installed on this computer and what each can be asked to do: see which are ready (reach_map, reach_app, reach_describe), then carry out one capability of one app (reach_invoke). Read-only turns may only use capabilities an app declares as reads.";

export interface ScienceReachToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ScienceReachToolContext {
  chatId: string;
  runId: string;
  permission: ToolPermission;
}

// The wording of the harness registry's purposes (capability-ports.ts), so a model sees the same thing on every surface.
const TOOLS: ReadonlyArray<ScienceReachToolDescriptor & { operation: string }> = [
  { name: "reach_map", operation: "reach.map", description: "Installed apps on this computer and how far each is usable by you (scriptable, partial, unmapped), with app keys.", inputSchema: REACH_PORT_SCHEMAS.map },
  { name: "reach_app", operation: "reach.app", description: "One installed app's capabilities (ids, parameters count, whether each is ready to use).", inputSchema: REACH_PORT_SCHEMAS.app },
  { name: "reach_describe", operation: "reach.describe", description: "One app capability in full: parameters as JSON Schema, what it does to the app, how it is carried out.", inputSchema: REACH_PORT_SCHEMAS.describe },
  { name: "reach_status", operation: "reach.status", description: "State of the background app mapping: map age, exploration switch, driver.", inputSchema: REACH_PORT_SCHEMAS.status },
  { name: "reach_invoke", operation: "reach.invoke", description: "Carry out one ready capability of an installed app (AppleScript command, or the app's own menu and dialog driven on screen); read-only runs may only use capabilities the app declares as reads.", inputSchema: REACH_PORT_SCHEMAS.invoke },
  { name: "reach_explore", operation: "reach.explore", description: "Look at one running app now: open its dialogs one by one, read them, close them again, and turn what works into ready capabilities.", inputSchema: REACH_PORT_SCHEMAS.explore },
  { name: "reach_verify", operation: "reach.verify", description: "Check that an explored capability still works in the running app; re-read it if the app moved it.", inputSchema: REACH_PORT_SCHEMAS.verify },
];

export function scienceReachToolDescriptors(): ScienceReachToolDescriptor[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as Record<string, unknown> }));
}

/**
 * Runs one Reach tool. The result is the dispatcher's own envelope (schemaVersion, operationId, status ok | refused | unavailable, reason, next,
 * data, receiptId) serialized as text; `isError` is true for anything but ok, so Science records a refusal as a refusal. An exception that is
 * not a typed refusal becomes reach_port_failed.
 */
export async function runScienceReachTool(name: string, args: Record<string, unknown>, ctx: ScienceReachToolContext): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error("science_reach_tool_unknown");
  let result: { status: string };
  try {
    const { callHarnessPort } = await import("../harness/capability-ports");
    result = await callHarnessPort(tool.operation, args, { chatId: ctx.chatId, runId: ctx.runId, permission: ctx.permission, dryRun: false });
  } catch {
    result = { status: "unavailable", reason: "reach_port_failed", next: "reach_status says whether the app map and the driver are ready" } as { status: string };
  }
  return { content: JSON.stringify(result), isError: result.status !== "ok" };
}
