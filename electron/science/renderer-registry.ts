import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  SCIENCE_RENDERER_PACK_DESCRIPTOR,
  isScienceRendererPackManifest,
  validateScienceRendererPackRelease,
  type ScienceRendererPackManifest,
  type ScienceRendererPackExecutor,
  type ScienceRendererPackStatus,
} from "../../shared/science-renderer-pack";
import type { ProductExtensionInstaller } from "../extensions/installer";
import { productExtensionSignedPayload } from "../../shared/product-extension";
import {
  SCIENCE_RENDERER_BINDING_SCHEMA,
  SCIENCE_RENDERER_EXECUTOR_BINDING_SCHEMA,
  scienceRendererBindingsEqual,
  scienceRendererExecutorBindingsEqual,
  type ScienceRendererBinding,
  type ScienceRendererExecutorBinding,
} from "../../shared/science-renderer-runtime";
import {
  SCIENCE_TABLE_ARTIFACT_KIND,
  SCIENCE_TABLE_RENDERER_ID,
  SCIENCE_TABLE_RENDERER_VERSION,
} from "../../shared/science-table";
import {
  SCIENCE_NUMERIC_SURFACE_ARTIFACT_KIND,
  SCIENCE_NUMERIC_SURFACE_RENDERER_ID,
} from "../../shared/science-numeric-3d";

const MAX_DESCRIPTOR_BYTES = 1_048_576;
const RENDERER_PACK_PREFIX = "agentlas-science-renderer-";

interface LoadedRendererPack {
  status: ScienceRendererPackStatus;
  manifest: ScienceRendererPackManifest | null;
  releaseDir: string | null;
}

export interface ResolvedScienceRenderer {
  pack: ScienceRendererPackManifest;
  releaseDir: string;
  renderer: ScienceRendererPackManifest["renderers"][number];
  binding: ScienceRendererBinding;
}

export interface ResolvedScienceRendererExecutor {
  renderer: ResolvedScienceRenderer;
  executor: ScienceRendererPackExecutor;
  binding: ScienceRendererExecutorBinding;
  executorDescriptorSha256: string;
  entryPath: string;
  assets: Array<{ role: "runtime" | "wasm"; path: string; sha256: string }>;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function resolveVerifiedReleaseFile(releaseDir: string, relativePath: string, expectedSha256: string): string {
  const root = fs.realpathSync(releaseDir);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error("science-renderer-pack-file-path-invalid");
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("science-renderer-pack-file-invalid");
  if (fs.realpathSync(target) !== target) throw new Error("science-renderer-pack-file-realpath-invalid");
  const actualSha256 = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("science-renderer-pack-file-digest-mismatch");
  return target;
}

const CORE_PACK: ScienceRendererPackStatus = {
  id: "agentlas-science-core",
  displayName: "Science Core",
  version: "1.0.0",
  source: "core",
  state: "ready",
  // Core table is a plain DOM renderer. Its canonical, source-bound payload is
  // validated by Main before the UI receives it; no extension code is trusted.
  // Image remains a reserved contract ID until its adapter/probe path exists.
  rendererIds: ["agentlas.vega", SCIENCE_NUMERIC_SURFACE_RENDERER_ID, "agentlas.cytoscape", "agentlas.d3-sky", "agentlas.jbrowse", SCIENCE_TABLE_RENDERER_ID],
  artifactKinds: ["chart.vega", SCIENCE_NUMERIC_SURFACE_ARTIFACT_KIND, "phylogeny.radial", "literature.citation-network", "astronomy.sky-catalog", "genomics.variant-track", SCIENCE_TABLE_ARTIFACT_KIND],
  engineNames: ["Vega 6.4.0", "Three.js 0.173.0", "Cytoscape.js 3.34.1", "D3 7.9.0", "JBrowse 2 4.3.0", `Agentlas Data Table ${SCIENCE_TABLE_RENDERER_VERSION}`],
  surfaces: ["canvas", "svg", "dom"],
  packageBytes: 0,
  licenseSpdx: ["BSD-3-Clause", "MIT", "ISC"],
  errorCode: null,
};

function readPackDescriptor(releaseDir: string): unknown {
  const descriptorPath = path.join(releaseDir, SCIENCE_RENDERER_PACK_DESCRIPTOR);
  const stat = fs.lstatSync(descriptorPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > MAX_DESCRIPTOR_BYTES) throw new Error("science-renderer-pack-descriptor-invalid");
  return JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
}

function statusFromManifest(manifest: ScienceRendererPackManifest): ScienceRendererPackStatus {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    version: manifest.version,
    source: "extension",
    state: "verified-unprobed",
    rendererIds: manifest.renderers.map((renderer) => renderer.id),
    artifactKinds: [...new Set(manifest.renderers.flatMap((renderer) => renderer.artifactKinds))].sort(),
    engineNames: manifest.engines.map((engine) => `${engine.name} ${engine.version}`),
    surfaces: [...new Set(manifest.renderers.flatMap((renderer) => renderer.surfaces))].sort(),
    packageBytes: manifest.assets.packageBytes,
    licenseSpdx: [...new Set(manifest.licenses.map((license) => license.spdx))].sort(),
    errorCode: null,
  };
}

export class ScienceRendererRegistry {
  constructor(
    private readonly installer: ProductExtensionInstaller,
    private readonly desktopVersion: string,
  ) {}

  private load(): LoadedRendererPack[] {
    const packs: LoadedRendererPack[] = [{ status: { ...CORE_PACK }, manifest: null, releaseDir: null }];
    for (const extensionStatus of this.installer.listStatuses(RENDERER_PACK_PREFIX)) {
      if (extensionStatus.phase === "disabled") {
        packs.push({
          status: {
            id: extensionStatus.id,
            displayName: extensionStatus.id,
            version: extensionStatus.version,
            source: "extension",
            state: "disabled",
            rendererIds: [], artifactKinds: [], engineNames: [], surfaces: [], packageBytes: 0, licenseSpdx: [], errorCode: null,
          },
          manifest: null,
          releaseDir: null,
        });
        continue;
      }
      if (extensionStatus.phase !== "installed") {
        packs.push({
          status: {
            id: extensionStatus.id,
            displayName: extensionStatus.id,
            version: extensionStatus.version,
            source: "extension",
            state: "repair-required",
            rendererIds: [], artifactKinds: [], engineNames: [], surfaces: [], packageBytes: 0, licenseSpdx: [],
            errorCode: extensionStatus.errorCode ?? "science-renderer-pack-extension-invalid",
          },
          manifest: null,
          releaseDir: null,
        });
        continue;
      }
      try {
        const release = this.installer.activeRelease(extensionStatus.id);
        if (!release) throw new Error("science-renderer-pack-release-missing");
        const value = readPackDescriptor(release.releaseDir);
        if (!isScienceRendererPackManifest(value)) throw new Error("science-renderer-pack-manifest-invalid");
        validateScienceRendererPackRelease(value, release.manifest, this.desktopVersion);
        packs.push({ status: statusFromManifest(value), manifest: value, releaseDir: release.releaseDir });
      } catch (error) {
        packs.push({
          status: {
            id: extensionStatus.id,
            displayName: extensionStatus.id,
            version: extensionStatus.version,
            source: "extension",
            state: "repair-required",
            rendererIds: [], artifactKinds: [], engineNames: [], surfaces: [], packageBytes: 0, licenseSpdx: [],
            errorCode: error instanceof Error ? error.message.split(":", 1)[0] : "science-renderer-pack-invalid",
          },
          manifest: null,
          releaseDir: null,
        });
      }
    }

    const owners = new Map<string, LoadedRendererPack[]>();
    for (const pack of packs.filter((candidate) => candidate.status.state === "ready" || candidate.status.state === "verified-unprobed")) {
      for (const rendererId of pack.status.rendererIds) owners.set(rendererId, [...(owners.get(rendererId) ?? []), pack]);
    }
    for (const duplicates of owners.values()) {
      if (duplicates.length < 2) continue;
      for (const pack of duplicates) {
        pack.status.state = "conflict";
        pack.status.errorCode = "science-renderer-pack-identity-conflict";
      }
    }
    return packs;
  }

  listStatuses(): ScienceRendererPackStatus[] {
    return this.load().map((pack) => ({ ...pack.status }));
  }

  resolveVerifiedPackage(rendererId: string, artifactKind: string): ResolvedScienceRenderer | null {
    for (const pack of this.load()) {
      if (pack.status.state !== "verified-unprobed" || !pack.manifest || !pack.releaseDir) continue;
      const renderer = pack.manifest.renderers.find((candidate) => candidate.id === rendererId && candidate.artifactKinds.includes(artifactKind));
      if (renderer) {
        const release = this.installer.activeRelease(pack.manifest.id);
        if (!release || release.releaseDir !== pack.releaseDir) continue;
        const descriptorFile = release.manifest.files.find((file) => file.path === SCIENCE_RENDERER_PACK_DESCRIPTOR);
        if (!descriptorFile) continue;
        const binding: ScienceRendererBinding = {
          schema: SCIENCE_RENDERER_BINDING_SCHEMA,
          packId: pack.manifest.id,
          packVersion: pack.manifest.version,
          extensionManifestSha256: createHash("sha256").update(productExtensionSignedPayload(release.manifest), "utf8").digest("hex"),
          packDescriptorSha256: descriptorFile.sha256,
          assetsMerkleRoot: pack.manifest.assets.merkleRoot,
          rendererId: renderer.id,
          // The first engine is the renderer-facing engine; later rows are
          // validators or auxiliary runtimes pinned in the same signed pack.
          rendererVersion: pack.manifest.engines[0].version,
          rendererDescriptorSha256: sha256Json(renderer),
          entrySha256: renderer.entrySha256,
          inputSchemaSha256: renderer.inputSchemaSha256,
          semanticSchemaSha256: renderer.semanticSchemaSha256,
        };
        return { pack: pack.manifest, releaseDir: pack.releaseDir, renderer, binding };
      }
    }
    return null;
  }

  resolveExactVerifiedPackage(binding: ScienceRendererBinding, artifactKind: string): ResolvedScienceRenderer | null {
    const resolved = this.resolveVerifiedPackage(binding.rendererId, artifactKind);
    return resolved && scienceRendererBindingsEqual(resolved.binding, binding) ? resolved : null;
  }

  resolveVerifiedExecutor(rendererId: string, artifactKind: string, executorId: string): ResolvedScienceRendererExecutor | null {
    const renderer = this.resolveVerifiedPackage(rendererId, artifactKind);
    if (!renderer) return null;
    const executor = renderer.pack.executors?.find((candidate) => candidate.id === executorId && candidate.artifactKinds.includes(artifactKind));
    if (!executor) return null;
    const release = this.installer.activeRelease(renderer.pack.id);
    if (!release || release.releaseDir !== renderer.releaseDir) return null;
    const entryPath = resolveVerifiedReleaseFile(renderer.releaseDir, executor.entry, executor.entrySha256);
    const assets = executor.assets.map((asset) => ({
      role: asset.role,
      path: resolveVerifiedReleaseFile(renderer.releaseDir, asset.path, asset.sha256),
      sha256: asset.sha256,
    }));
    const executorDescriptorSha256 = sha256Json(executor);
    const binding: ScienceRendererExecutorBinding = {
      schema: SCIENCE_RENDERER_EXECUTOR_BINDING_SCHEMA,
      packId: renderer.binding.packId,
      packVersion: renderer.binding.packVersion,
      extensionManifestSha256: renderer.binding.extensionManifestSha256,
      packDescriptorSha256: renderer.binding.packDescriptorSha256,
      assetsMerkleRoot: renderer.binding.assetsMerkleRoot,
      rendererId: renderer.binding.rendererId,
      executorId: executor.id,
      executorVersion: executor.version,
      executorDescriptorSha256,
      entrySha256: executor.entrySha256,
      enginesSha256: sha256Json(executor.engines),
      assetsSha256: sha256Json(executor.assets),
      runtime: executor.runtime,
      network: executor.network,
      sandboxPolicy: executor.sandboxPolicy,
    };
    return { renderer, executor, binding, executorDescriptorSha256, entryPath, assets };
  }

  resolveExactVerifiedExecutor(binding: ScienceRendererBinding, artifactKind: string, executorId: string): ResolvedScienceRendererExecutor | null {
    const resolved = this.resolveVerifiedExecutor(binding.rendererId, artifactKind, executorId);
    return resolved && scienceRendererBindingsEqual(resolved.renderer.binding, binding) ? resolved : null;
  }

  resolveExactVerifiedExecutorBinding(
    rendererBinding: ScienceRendererBinding,
    executorBinding: ScienceRendererExecutorBinding,
    artifactKind: string,
  ): ResolvedScienceRendererExecutor | null {
    const resolved = this.resolveVerifiedExecutor(rendererBinding.rendererId, artifactKind, executorBinding.executorId);
    return resolved
      && scienceRendererBindingsEqual(resolved.renderer.binding, rendererBinding)
      && scienceRendererExecutorBindingsEqual(resolved.binding, executorBinding)
      ? resolved : null;
  }
}
