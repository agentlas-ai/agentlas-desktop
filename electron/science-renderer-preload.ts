import { contextBridge, ipcRenderer } from "electron";

// Electron sandbox preloads cannot resolve arbitrary local CommonJS modules at
// runtime. Keep this tiny capability switch inside the preload bundle so the
// signed renderer guest always receives the expected bridge.
function scienceRendererGuestCommitCapability(rendererId: string): "chemistry" | "molstar" | "read-only" {
  if (rendererId === "agentlas.ketcher") return "chemistry";
  if (rendererId === "agentlas.molstar") return "molstar";
  return "read-only";
}

const instanceId = process.argv
  .find((argument) => argument.startsWith("--agentlas-science-renderer-instance="))
  ?.slice("--agentlas-science-renderer-instance=".length) ?? "";
const rendererId = process.argv
  .find((argument) => argument.startsWith("--agentlas-science-renderer-id="))
  ?.slice("--agentlas-science-renderer-id=".length) ?? "";

const bridge: Record<string, unknown> = {
  instanceId,
  handshake: () => ipcRenderer.invoke("scienceRenderer:handshake", { instanceId }),
  report: (report: unknown) => ipcRenderer.invoke("scienceRenderer:report", { instanceId, report }),
};
const commitCapability = scienceRendererGuestCommitCapability(rendererId);
if (commitCapability === "chemistry") {
  bridge.commitChemistry = (input: unknown) => ipcRenderer.invoke("scienceRenderer:chemistryCommit", input);
} else if (commitCapability === "molstar") {
  bridge.commitMolstar = (input: unknown) => ipcRenderer.invoke("scienceRenderer:molstarCommit", input);
}

contextBridge.exposeInMainWorld("agentlasScienceRenderer", Object.freeze(bridge));
