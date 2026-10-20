// Renderer surface for Toolchain assets: MCP-shaped tools for apps and web pages, their versions, calls and
// health. No local path, prompt or tool output crosses this boundary — only states, counts and the contract text.

import type { IpcMain } from "electron";

import type { ToolchainAssetCreateInput } from "../../shared/toolchain-asset";
import { resolveNativeAssetPublicationAuthority } from "./asset-cold-start";
import { getToolchainAsset, listToolchainAssets, publishToolchainVersion, toolchainAssetTestInProgress, withdrawToolchainAsset } from "./assets";
import { callToolchain, listToolchainCalls } from "./calls";
import { toolchainHealthView } from "./health";
import { generateToolchain } from "./generalizer";
import type { ToolchainGenerationInput } from "../../shared/toolchain-asset";
import { sha256Value } from "../../shared/graph-execution-digest";
import { registerOwnerProducedToolchainRelease } from "../one/toolchain-personal-owner";
import type { ToolchainGenerationResult } from "../../shared/toolchain-asset";

export function registerToolchainIpc(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle("toolchains:assets-list", () => listToolchainAssets().map(asset => ({ ...asset, testInProgress: toolchainAssetTestInProgress(asset.id), ...toolchainHealthView(asset) })));
  ipc.handle("toolchains:assets-get", (_event, id: string) => getToolchainAsset(id));
  // An owner-authored release is the owner's own production: register it with the personal native owner so a One
  // turn can run it once it is published (the canonical registry is what toolchain_run resolves).
  const ownerProduced = (result: ToolchainGenerationResult): ToolchainGenerationResult => {
    try { registerOwnerProducedToolchainRelease(result); }
    catch (error) { console.warn("[toolchain] owner release registration failed:", error instanceof Error ? error.message : error); }
    return result;
  };
  ipc.handle("toolchains:assets-generate", async (_event, input: ToolchainGenerationInput) => ownerProduced(await generateToolchain(input)));
  // Compatibility callers delegate to the same AI authoring path. Their old
  // source graph is never inspected, converted or changed.
  const legacyRequest = (input: ToolchainAssetCreateInput & { id?: string }): ToolchainGenerationInput => ({
    request: JSON.stringify({ capability: input.contract, improvementOf: input.id ?? null }),
    requestId: `compat-${sha256Value(input).slice(7)}`, ...(input.id ? { toolchainId: input.id } : {}),
  });
  ipc.handle("toolchains:assets-create", async (_event, input: ToolchainAssetCreateInput) => ownerProduced(await generateToolchain(legacyRequest(input))).asset);
  ipc.handle("toolchains:assets-add-version", async (_event, input: ToolchainAssetCreateInput & { id: string }) => ownerProduced(await generateToolchain(legacyRequest(input))).asset);
  ipc.handle("toolchains:assets-publish", async (event, input: { id: string; version: number; allowEffectfulValidation?: boolean }) => {
    // The owner's checkbox on the Toolchains screen ("validation executes the examples and may write, upload or send")
    // approves effectful examples; the native owner honors it only for the trusted owner window that sent this IPC.
    const nativePublication = await resolveNativeAssetPublicationAuthority({ kind: "ipc",
      caller: { event, allowEffectfulValidation: input.allowEffectfulValidation === true }, id: input.id, version: input.version });
    return publishToolchainVersion(input.id, input.version, { permission: "write", nativePublication });
  });
  ipc.handle("toolchains:assets-withdraw", (_event, id: string) => withdrawToolchainAsset(id));
  ipc.handle("toolchains:assets-run", (_event, input: { id: string; version?: number; input: Record<string, unknown>; requestId: string }) => {
    const asset = getToolchainAsset(input.id);
    const version = input.version ?? asset?.stableVersion;
    if (!version) throw new Error("toolchain_version_not_callable");
    return callToolchain({ toolchainId: input.id, version, args: input.input }, { requestId: input.requestId, permission: "write" });
  });
  ipc.handle("toolchains:assets-history", (_event, id: string) => listToolchainCalls(id));
}
