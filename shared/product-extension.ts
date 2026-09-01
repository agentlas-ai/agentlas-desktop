export const PRODUCT_EXTENSION_SCHEMA = "agentlas.product-extension/v1" as const;
export const PRODUCT_EXTENSION_INSTALL_SCHEMA = "agentlas.product-extension-install/v1" as const;

export const PRODUCT_EXTENSION_PERMISSIONS = [
  "science:projects",
  "science:artifacts",
  "science:compute",
  "science:network",
  "science:agent-runtime",
] as const;

export type ProductExtensionPermission = typeof PRODUCT_EXTENSION_PERMISSIONS[number];

export interface ProductExtensionFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ProductExtensionSignature {
  algorithm: "ed25519";
  keyId: string;
  value: string;
}

export interface ProductExtensionManifest {
  schema: typeof PRODUCT_EXTENSION_SCHEMA;
  id: string;
  version: string;
  displayName: string;
  minimumDesktopVersion: string;
  entry: string;
  serviceEntry?: string;
  permissions: ProductExtensionPermission[];
  files: ProductExtensionFile[];
  signature: ProductExtensionSignature;
}

export type ProductExtensionInstallPhase =
  | "not-installed"
  | "checking"
  | "downloading"
  | "verifying"
  | "installing"
  | "health-checking"
  | "installed"
  | "disabled"
  | "repair-required";

export interface ProductExtensionStatus {
  id: string;
  phase: ProductExtensionInstallPhase;
  installed: boolean;
  enabled: boolean;
  version: string | null;
  installedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ProductExtensionInstallReceipt {
  ok: boolean;
  id: string;
  action: "installed" | "updated" | "unchanged" | "failed";
  version: string | null;
  code: string | null;
  message: string | null;
}

export const SCIENCE_SUITE_COMPONENT_IDS = [
  "agentlas-science",
  "agentlas-science-renderer-ketcher",
  "agentlas-science-renderer-molstar",
] as const;

export type ScienceSuiteComponentId = typeof SCIENCE_SUITE_COMPONENT_IDS[number];

export interface ScienceSuiteComponentStatus {
  id: ScienceSuiteComponentId;
  displayName: string;
  description: string;
  packageBytes: number;
  status: ProductExtensionStatus;
}

export interface ScienceSuiteStatus {
  id: "agentlas-science-suite";
  phase: ProductExtensionInstallPhase;
  installed: boolean;
  enabled: boolean;
  totalPackageBytes: number;
  components: ScienceSuiteComponentStatus[];
}

export interface ScienceSuiteInstallProgress {
  id: "agentlas-science-suite";
  phase: "checking" | "downloading" | "verifying" | "installing" | "health-checking" | "installed" | "failed";
  componentId: ScienceSuiteComponentId | null;
  componentIndex: number;
  componentCount: number;
  completedBytes: number;
  totalBytes: number;
  percent: number;
  message: string;
}

export interface ScienceSuiteInstallReceipt {
  ok: boolean;
  id: "agentlas-science-suite";
  action: "installed" | "updated" | "unchanged" | "failed";
  components: ProductExtensionInstallReceipt[];
  code: string | null;
  message: string | null;
}

export interface ProductExtensionUninstallReceipt {
  ok: boolean;
  id: string;
  removedVersion: string | null;
  dataPreserved: true;
  code: string | null;
  message: string | null;
}

export interface ProductExtensionViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProductExtensionViewStatus {
  id: string;
  state: "opening" | "ready" | "error" | "closed";
  title?: string;
  errorCode?: string;
  errorMessage?: string;
}

const ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const KEY_ID_RE = /^[a-zA-Z0-9._-]{1,96}$/;

export function isProductExtensionId(value: string): boolean {
  return ID_RE.test(value);
}

export function isSafeProductExtensionPath(value: string): boolean {
  if (!value || value.length > 240 || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isProductExtensionManifest(value: unknown): value is ProductExtensionManifest {
  if (!isRecord(value)) return false;
  if (value.schema !== PRODUCT_EXTENSION_SCHEMA) return false;
  if (typeof value.id !== "string" || !isProductExtensionId(value.id)) return false;
  if (typeof value.version !== "string" || !VERSION_RE.test(value.version)) return false;
  if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 120) return false;
  if (typeof value.minimumDesktopVersion !== "string" || !VERSION_RE.test(value.minimumDesktopVersion)) return false;
  if (typeof value.entry !== "string" || !isSafeProductExtensionPath(value.entry)) return false;
  if (value.serviceEntry !== undefined && (typeof value.serviceEntry !== "string" || !isSafeProductExtensionPath(value.serviceEntry))) return false;
  if (!Array.isArray(value.permissions) || value.permissions.some((permission) => !PRODUCT_EXTENSION_PERMISSIONS.includes(permission as ProductExtensionPermission))) return false;
  if (new Set(value.permissions).size !== value.permissions.length) return false;
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 20_000) return false;
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!isRecord(file)) return false;
    if (typeof file.path !== "string" || !isSafeProductExtensionPath(file.path) || paths.has(file.path)) return false;
    if (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256)) return false;
    if (!Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > 2_147_483_648) return false;
    paths.add(file.path);
  }
  if (!paths.has(value.entry)) return false;
  if (value.serviceEntry && !paths.has(value.serviceEntry)) return false;
  if (!isRecord(value.signature)) return false;
  if (value.signature.algorithm !== "ed25519") return false;
  if (typeof value.signature.keyId !== "string" || !KEY_ID_RE.test(value.signature.keyId)) return false;
  if (typeof value.signature.value !== "string" || !/^[A-Za-z0-9+/]{80,120}={0,2}$/.test(value.signature.value)) return false;
  return true;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function productExtensionSignedPayload(manifest: ProductExtensionManifest): string {
  const { signature: _signature, ...unsigned } = manifest;
  return JSON.stringify(canonicalValue(unsigned));
}

export function compareProductExtensionVersions(left: string, right: string): number {
  const parse = (value: string) => value.split("-")[0].split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}
