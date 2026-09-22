import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ScienceDaemonClient } from "./daemon-client";

function inputEnvelope(value: unknown): { projectId: string; requestId: string; command?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-math-request-invalid");
  const input = (value as { input?: unknown }).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-math-request-invalid");
  const row = input as Record<string, unknown>;
  if (typeof row.projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(row.projectId)
    || typeof row.requestId !== "string" || !row.requestId.trim() || row.requestId.length > 200
    || /[\u0000-\u001f]/u.test(row.requestId)
    || Object.keys(row).some(key => !["projectId", "requestId", "command"].includes(key))) {
    throw new Error("science-math-request-invalid");
  }
  return row as { projectId: string; requestId: string; command?: unknown };
}

/** The native Math editor calls the same versioned Science service as agent tools. */
export function registerScienceMathHandlers(input: {
  ipcMain: Pick<IpcMain, "handle">;
  assertScienceSender(event: IpcMainInvokeEvent, envelope: unknown): unknown;
  client: Pick<ScienceDaemonClient, "command" | "cancelMath">;
}): void {
  input.ipcMain.handle("science:math:command", (event, envelope: unknown) => {
    input.assertScienceSender(event, envelope);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-math-subframe-denied");
    const request = inputEnvelope(envelope);
    if (!request.command || typeof request.command !== "object" || Array.isArray(request.command)) {
      throw new Error("science-math-command-invalid");
    }
    // No reply deadline: a GUI wait is not the lifetime of a computation.
    return input.client.command({ op: "math.command", input: { ...request, command: request.command } });
  });
  input.ipcMain.handle("science:math:cancel", (event, envelope: unknown) => {
    input.assertScienceSender(event, envelope);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-math-subframe-denied");
    const request = inputEnvelope(envelope);
    return input.client.cancelMath({ projectId: request.projectId, requestId: request.requestId });
  });
}
