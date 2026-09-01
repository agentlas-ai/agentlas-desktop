import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type {
  ProductExtensionInstallReceipt,
  ProductExtensionStatus,
  ProductExtensionUninstallReceipt,
  ScienceSuiteComponentId,
  ScienceSuiteInstallProgress,
  ScienceSuiteInstallReceipt,
  ScienceSuiteStatus,
} from "../../shared/product-extension";
import { ProductExtensionInstaller } from "./installer";
import { downloadAndInstallSciencePackage, type SciencePackageArchiveSpec } from "./downloader";
import { ScienceRendererRegistry } from "../science/renderer-registry";
import type { ScienceRendererBinding, ScienceRendererExecutorBinding } from "../../shared/science-renderer-runtime";

export const SCIENCE_EXTENSION_ID = "agentlas-science";

const SCIENCE_SUITE_SPECS: ReadonlyArray<SciencePackageArchiveSpec & {
  displayName: string;
  description: string;
  sourceEnv: string;
}> = [
  {
    id: SCIENCE_EXTENSION_ID,
    displayName: "Science Workspace",
    description: "Projects, literature, evidence graphs, statistics, and research writing",
    version: "0.1.0",
    archiveUrl: "https://github.com/agentlas-ai/agentlas-desktop-releases/releases/download/science-v0.1.0/Agentlas-Science-0.1.0.zip",
    archiveBytes: 5_154_626,
    archiveSha256: "0c318bb0209fd6366b258666a4a1050150792010fed6f30c935826d663b661a0",
    sourceEnv: "AGENTLAS_SCIENCE_EXTENSION_SOURCE_DIR",
  },
  {
    id: "agentlas-science-renderer-ketcher",
    displayName: "Chemistry Tools",
    description: "Ketcher structure editor and Indigo chemistry runtime",
    version: "1.1.0",
    archiveUrl: "https://github.com/agentlas-ai/agentlas-desktop-releases/releases/download/science-v0.1.0/Agentlas-Science-Ketcher-0.1.0.zip",
    archiveBytes: 12_865_713,
    archiveSha256: "cbf82bd4f8f638abbc6c753d4b82716fb8a5c7003ac4e648e3a318e36785ca4e",
    sourceEnv: "AGENTLAS_SCIENCE_KETCHER_RENDERER_SOURCE_DIR",
  },
  {
    id: "agentlas-science-renderer-molstar",
    displayName: "Molecular Visualization",
    description: "Mol* protein and molecular structure viewer",
    version: "1.2.0",
    archiveUrl: "https://github.com/agentlas-ai/agentlas-desktop-releases/releases/download/science-v0.1.0/Agentlas-Science-Molstar-0.1.0.zip",
    archiveBytes: 1_533_924,
    archiveSha256: "691b1907202b4908f2b58fb2a784c2213b5ed03df77338f1189ac324fb84552a",
    sourceEnv: "AGENTLAS_SCIENCE_MOLSTAR_RENDERER_SOURCE_DIR",
  },
] as const;

let cachedInstaller: ProductExtensionInstaller | null = null;

function policyCandidates(): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, "product-extension-signing-policy.json")]
    : [path.join(process.cwd(), "build-resources", "product-extension-signing-policy.json")];
}

function trustedPublicKeys(): Record<string, string> {
  for (const candidate of policyCandidates()) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262_144) continue;
      const value = JSON.parse(fs.readFileSync(candidate, "utf8")) as { schemaVersion?: unknown; keys?: unknown };
      if (!value || typeof value !== "object"
        || value.schemaVersion !== "agentlas.product-extension-signing-policy.v1"
        || Object.keys(value).sort().join(",") !== "keys,schemaVersion"
        || !value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) continue;
      const keys = Object.fromEntries(
        Object.entries(value.keys as Record<string, unknown>)
          .filter(([key, pem]) => {
            if (!/^[a-zA-Z0-9._-]{1,96}$/.test(key) || typeof pem !== "string"
              || pem.includes("PRIVATE KEY") || !pem.includes("BEGIN PUBLIC KEY")) return false;
            try {
              const parsed = crypto.createPublicKey(pem);
              return parsed.type === "public" && parsed.asymmetricKeyType === "ed25519";
            } catch {
              return false;
            }
          }),
      ) as Record<string, string>;
      if (Object.keys(keys).length > 0) return keys;
    } catch {
      // A missing or malformed policy fails closed. The installer reports an
      // untrusted key and never activates package bytes.
    }
  }
  if (!app.isPackaged && process.env.AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON) {
    try {
      const value = JSON.parse(process.env.AGENTLAS_PRODUCT_EXTENSION_TRUSTED_KEYS_JSON) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).filter(([, pem]) => typeof pem === "string")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return {};
}

function installer(): ProductExtensionInstaller {
  if (cachedInstaller) return cachedInstaller;
  const qaRoot = !app.isPackaged ? process.env.AGENTLAS_PRODUCT_EXTENSION_ROOT_DIR?.trim() : "";
  if (qaRoot && !path.isAbsolute(qaRoot)) throw new Error("product-extension-qa-root-must-be-absolute");
  cachedInstaller = new ProductExtensionInstaller({
    rootDir: qaRoot || path.join(os.homedir(), ".agentlas", "extensions"),
    dataRootDir: path.join(app.getPath("userData"), "extensions"),
    desktopVersion: app.getVersion(),
    trustedPublicKeys: trustedPublicKeys(),
  });
  return cachedInstaller;
}

export function scienceExtensionStatus(): ProductExtensionStatus {
  return installer().status(SCIENCE_EXTENSION_ID);
}

export function scienceSuiteStatus(): ScienceSuiteStatus {
  const components = SCIENCE_SUITE_SPECS.map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    description: spec.description,
    packageBytes: spec.archiveBytes,
    status: installer().status(spec.id),
  }));
  const installed = components.every((component) => component.status.phase === "installed");
  const enabled = components.every((component) => component.status.enabled);
  const phase = installed
    ? "installed"
    : components.some((component) => component.status.phase === "repair-required")
      ? "repair-required"
      : components.some((component) => component.status.phase === "disabled")
        ? "disabled"
        : "not-installed";
  return {
    id: "agentlas-science-suite",
    phase,
    installed,
    enabled,
    totalPackageBytes: components.reduce((sum, component) => sum + component.packageBytes, 0),
    components,
  };
}

export function activeScienceExtension() {
  return installer().activeRelease(SCIENCE_EXTENSION_ID);
}

export function scienceRendererPackStatuses() {
  return new ScienceRendererRegistry(installer(), app.getVersion()).listStatuses();
}

export function resolveVerifiedScienceRenderer(rendererId: string, artifactKind: string) {
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveVerifiedPackage(rendererId, artifactKind);
}

export function resolveExactVerifiedScienceRenderer(binding: ScienceRendererBinding, artifactKind: string) {
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveExactVerifiedPackage(binding, artifactKind);
}

export function resolveVerifiedScienceRendererExecutor(rendererId: string, artifactKind: string, executorId: string) {
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveVerifiedExecutor(rendererId, artifactKind, executorId);
}

export function resolveExactVerifiedScienceRendererExecutor(binding: ScienceRendererBinding, artifactKind: string, executorId: string) {
  return new ScienceRendererRegistry(installer(), app.getVersion()).resolveExactVerifiedExecutor(binding, artifactKind, executorId);
}

export function resolveExactVerifiedScienceRendererExecutorBinding(
  rendererBinding: ScienceRendererBinding,
  executorBinding: ScienceRendererExecutorBinding,
  artifactKind: string,
) {
  return new ScienceRendererRegistry(installer(), app.getVersion())
    .resolveExactVerifiedExecutorBinding(rendererBinding, executorBinding, artifactKind);
}

export async function installScienceExtension(): Promise<ProductExtensionInstallReceipt> {
  const spec = SCIENCE_SUITE_SPECS[0];
  const source = !app.isPackaged ? process.env.AGENTLAS_SCIENCE_EXTENSION_SOURCE_DIR?.trim() : "";
  if (!app.isPackaged && (!source || !path.isAbsolute(source))) {
    return {
      ok: false,
      id: SCIENCE_EXTENSION_ID,
      action: "failed",
      version: null,
      code: "science-extension-package-unavailable",
      message: "No verified Agentlas Science package is available for this Desktop build.",
    };
  }
  if (source) {
    try {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("science-extension-package-source-invalid");
    } catch {
      return {
        ok: false,
        id: SCIENCE_EXTENSION_ID,
        action: "failed",
        version: null,
        code: "science-extension-package-source-invalid",
        message: "The verified Agentlas Science package could not be opened.",
      };
    }
    return installer().installFromDirectory(path.resolve(source));
  }
  return downloadAndInstallSciencePackage(spec, installer());
}

export async function installScienceSuite(
  onProgress?: (progress: ScienceSuiteInstallProgress) => void,
): Promise<ScienceSuiteInstallReceipt> {
  const totalBytes = SCIENCE_SUITE_SPECS.reduce((sum, spec) => sum + spec.archiveBytes, 0);
  const progress = (
    phase: ScienceSuiteInstallProgress["phase"],
    componentId: ScienceSuiteComponentId | null,
    componentIndex: number,
    completedBytes: number,
    message: string,
  ) => onProgress?.({
    id: "agentlas-science-suite",
    phase,
    componentId,
    componentIndex,
    componentCount: SCIENCE_SUITE_SPECS.length,
    completedBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((completedBytes / totalBytes) * 100))) : 0,
    message,
  });

  progress("checking", null, 0, 0, "Checking the signed Science package");
  const sources = SCIENCE_SUITE_SPECS.map((spec) => ({
    spec,
    source: !app.isPackaged ? process.env[spec.sourceEnv]?.trim() ?? "" : "",
  }));
  const unavailable = !app.isPackaged
    ? sources.find(({ source }) => !source || !path.isAbsolute(source))
    : undefined;
  if (unavailable) {
    const receipt: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components: [],
      code: "science-suite-package-unavailable",
      message: `No verified ${unavailable.spec.displayName} package is available for this Desktop build.`,
    };
    progress("failed", unavailable.spec.id, sources.indexOf(unavailable), 0, receipt.message ?? receipt.code ?? "Installation failed");
    return receipt;
  }
  for (const { spec, source } of sources) {
    if (!source) continue;
    try {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("science-suite-package-source-invalid");
    } catch {
      const receipt: ScienceSuiteInstallReceipt = {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components: [],
        code: "science-suite-package-source-invalid",
        message: `The verified ${spec.displayName} package could not be opened.`,
      };
      progress("failed", spec.id, sources.findIndex((entry) => entry.spec.id === spec.id), 0, receipt.message ?? receipt.code ?? "Installation failed");
      return receipt;
    }
  }

  const componentReceipts: ProductExtensionInstallReceipt[] = [];
  let completedBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const { spec, source } = sources[index];
    let receipt: ProductExtensionInstallReceipt;
    if (source) {
      progress(index === 0 ? "downloading" : "installing", spec.id, index, completedBytes, `Installing ${spec.displayName}`);
      receipt = installer().installFromDirectory(path.resolve(source));
    } else {
      progress("downloading", spec.id, index, completedBytes, `Downloading ${spec.displayName}`);
      receipt = await downloadAndInstallSciencePackage(spec, installer(), (downloadedBytes) => {
        progress("downloading", spec.id, index, completedBytes + downloadedBytes, `Downloading ${spec.displayName}`);
      });
    }
    componentReceipts.push(receipt);
    if (!receipt.ok || receipt.id !== spec.id) {
      const failed: ScienceSuiteInstallReceipt = {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components: componentReceipts,
        code: receipt.code ?? "science-suite-component-install-failed",
        message: receipt.message ?? `${spec.displayName} could not be installed.`,
      };
      progress("failed", spec.id, index, completedBytes, failed.message ?? failed.code ?? "Installation failed");
      return failed;
    }
    completedBytes += spec.archiveBytes;
    progress("verifying", spec.id, index, completedBytes, `Verified ${spec.displayName}`);
  }

  progress("health-checking", null, sources.length, completedBytes, "Checking the installed Science workspace");
  const finalStatus = scienceSuiteStatus();
  if (!finalStatus.installed || !finalStatus.enabled) {
    const failed: ScienceSuiteInstallReceipt = {
      ok: false,
      id: "agentlas-science-suite",
      action: "failed",
      components: componentReceipts,
      code: "science-suite-health-check-failed",
      message: "Agentlas Science did not pass its installation check.",
    };
    progress("failed", null, sources.length, completedBytes, failed.message ?? "Agentlas Science did not pass its installation check.");
    return failed;
  }
  const action = componentReceipts.every((receipt) => receipt.action === "unchanged")
    ? "unchanged"
    : componentReceipts.some((receipt) => receipt.action === "updated")
      ? "updated"
      : "installed";
  progress("installed", null, sources.length, totalBytes, "Agentlas Science is ready");
  return {
    ok: true,
    id: "agentlas-science-suite",
    action,
    components: componentReceipts,
    code: null,
    message: null,
  };
}

export function setScienceExtensionEnabled(enabled: boolean): ProductExtensionStatus {
  return installer().setEnabled(SCIENCE_EXTENSION_ID, enabled);
}

export function uninstallScienceExtension(): ProductExtensionUninstallReceipt {
  return installer().uninstall(SCIENCE_EXTENSION_ID);
}

export function resetScienceExtensionInstallerForTests(): void {
  if (app.isPackaged) return;
  cachedInstaller = null;
}
