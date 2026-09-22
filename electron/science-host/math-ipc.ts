import type { IpcMain, IpcMainInvokeEvent } from "electron";

interface MathWorkspacePort {
  command(projectId: string, requestId: string, command: unknown): Promise<Record<string, unknown>>;
  cancel(projectId: string, requestId: string): { requested: boolean };
}

function workspace(): MathWorkspacePort {
  // Science is released independently. Older extension services remain usable
  // and report this missing capability only when the Math command is requested.
  const science = require("agentlas-science") as { scienceMathWorkspace?: () => MathWorkspacePort };
  if (typeof science.scienceMathWorkspace !== "function") throw new Error("science-math-service-update-required");
  return science.scienceMathWorkspace();
}

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
}): void {
  input.ipcMain.handle("science:math:command", (event, envelope: unknown) => {
    input.assertScienceSender(event, envelope);
    const request = inputEnvelope(envelope);
    if (!request.command || typeof request.command !== "object" || Array.isArray(request.command)) {
      throw new Error("science-math-command-invalid");
    }
    return workspace().command(request.projectId, request.requestId, request.command);
  });
  input.ipcMain.handle("science:math:cancel", (event, envelope: unknown) => {
    input.assertScienceSender(event, envelope);
    const request = inputEnvelope(envelope);
    return workspace().cancel(request.projectId, request.requestId);
  });
}
