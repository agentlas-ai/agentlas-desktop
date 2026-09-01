import { createHash } from "node:crypto";

export const SCIENCE_NUMERIC_SURFACE_SCHEMA = "agentlas.science.numeric-surface-artifact/v1" as const;
export const SCIENCE_NUMERIC_SURFACE_V2_SCHEMA = "agentlas.science.numeric-surface-artifact/v2" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA = "agentlas.science.statistics-numeric-surface-source/v2" as const;
export const SCIENCE_NUMERIC_SURFACE_RENDERER_ID = "agentlas.three-numeric" as const;
export const SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION = "1.0.0" as const;
export const SCIENCE_NUMERIC_SURFACE_ARTIFACT_KIND = "chart.numeric-3d" as const;
export const SCIENCE_NUMERIC_SURFACE_PNG_EXPORT_SCHEMA = "agentlas.science.numeric-surface-png-export/v1" as const;
export const SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA = "agentlas.science.numeric-surface-raster-artifact/v1" as const;
export const SCIENCE_NUMERIC_SURFACE_RASTERIZER_TOOL_ID = "agentlas.numeric-surface-rasterizer" as const;
export const SCIENCE_NUMERIC_SURFACE_RASTERIZER_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_MATERIALIZER_TOOL_ID = "agentlas.statistics-numeric-surface-materializer" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_MATERIALIZER_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_INPUT_ROLE = "statistics-numeric-surface-materialization-input" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_INPUT_MIME = "application/vnd.agentlas.science.statistics-numeric-surface-materialization-input+json" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_OUTPUT_ROLE = "statistics-numeric-surface-artifact" as const;
export const SCIENCE_STATISTICS_NUMERIC_SURFACE_OUTPUT_MIME = "application/vnd.agentlas.science.numeric-surface-artifact+json" as const;

export interface ScienceNumericSurfaceViewState {
  cameraPosition: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

export interface ScienceNumericSurfaceViewStateReceipt {
  schema: "agentlas.science.numeric-surface-view-state/v1";
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  renderer: {
    id: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_ID;
    version: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION;
  };
  viewState: ScienceNumericSurfaceViewState;
  viewStateSha256: string;
  updatedAt: string;
}

export interface ScienceNumericSurfacePngExport {
  schema: typeof SCIENCE_NUMERIC_SURFACE_PNG_EXPORT_SCHEMA;
  mimeType: "image/png";
  renderer: {
    id: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_ID;
    version: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION;
    outputColorSpace: "srgb";
  };
  surfaceArtifact: {
    artifactId: string;
    artifactVersion: number;
    contentSha256: string;
    payloadSha256: string;
  };
  viewStateReceipt: ScienceNumericSurfaceViewStateReceipt;
  viewStateReceiptSha256: string;
  renderMode: "three-offscreen-webgl";
  exportProfile: "journal-raster-300dpi" | "journal-raster-600dpi";
  dpi: 300 | 600;
  width: number;
  height: number;
  widthMm: number;
  heightMm: number;
  colorSpace: "srgb";
  background: "#ffffff";
  readback: {
    byteSize: number;
    rgbaSha256: string;
    nonBackgroundPixelCount: number;
  };
  byteSize: number;
  sha256: string;
  dataBase64: string;
}

export interface ScienceNumericSurfaceRasterArtifactPayload {
  schema: typeof SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA;
  surfaceArtifact: ScienceNumericSurfacePngExport["surfaceArtifact"];
  viewStateReceipt: ScienceNumericSurfaceViewStateReceipt;
  viewStateReceiptSha256: string;
  export: Omit<ScienceNumericSurfacePngExport, "schema" | "surfaceArtifact" | "viewStateReceipt" | "viewStateReceiptSha256" | "dataBase64">;
  exportSha256: string;
}

export interface PersistScienceNumericSurfaceViewStateInput {
  projectId: string;
  artifactId: string;
  artifactVersion: number;
  artifactContentSha256: string;
  viewState: ScienceNumericSurfaceViewState;
}

export interface ScienceNumericSurfaceArtifactPayload {
  schema: typeof SCIENCE_NUMERIC_SURFACE_SCHEMA;
  renderer: {
    id: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_ID;
    version: typeof SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION;
  };
  chartFamily: "surface3d";
  title: string;
  grid: {
    x: number[];
    y: number[];
    z: number[][];
    valueCount: number;
    zMin: number;
    zMax: number;
    gridSha256: string;
  };
  axes: {
    x: { title: string; unit: string | null };
    y: { title: string; unit: string | null };
    z: { title: string; unit: string | null };
  };
  appearance: {
    palette: "viridis" | "cividis" | "blue-red" | "grayscale";
    wireframe: boolean;
    showObservedPoints: boolean;
  };
  interaction: {
    rotate: true;
    pan: true;
    zoom: true;
    persistViewState: true;
  };
  viewState: ScienceNumericSurfaceViewState;
  analysis: {
    runId: string;
    toolId: string;
    toolVersion: string;
    model: string;
    inputSha256: string;
    outputSha256: string;
  };
  payloadSha256: string;
}

export interface ScienceStatisticsNumericSurfaceSourcePayload {
  schema: typeof SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA;
  chartFamily: "surface3d";
  title: string;
  grid: ScienceNumericSurfaceV2ArtifactPayload["grid"];
  observations: ScienceNumericSurfaceV2ArtifactPayload["observations"];
  support: ScienceNumericSurfaceV2ArtifactPayload["support"];
  axes: ScienceNumericSurfaceArtifactPayload["axes"];
  appearance: ScienceNumericSurfaceArtifactPayload["appearance"];
  viewState: ScienceNumericSurfaceViewState;
  method: "response_surface_regression";
  model: string;
}

export interface ScienceNumericSurfaceObservedPoint {
  row: number;
  id: string;
  x: number;
  y: number;
  z: number;
  residual: number;
}

export interface ScienceNumericSurfaceV2ArtifactPayload extends Omit<ScienceNumericSurfaceArtifactPayload, "schema" | "grid"> {
  schema: typeof SCIENCE_NUMERIC_SURFACE_V2_SCHEMA;
  grid: ScienceNumericSurfaceArtifactPayload["grid"] & {
    supportMask: boolean[][];
    supportMaskSha256: string;
    supportedValueCount: number;
  };
  observations: {
    points: ScienceNumericSurfaceObservedPoint[];
    pointsSha256: string;
  };
  support: {
    algorithm: "monotone-chain-2d/v1";
    hull: Array<{ x: number; y: number }>;
    hullSha256: string;
    maskRule: "grid-point-inside-or-boundary/v1";
    receiptSha256: string;
  };
}

type JsonRecord = Record<string, unknown>;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_RE = /^[a-z][a-z0-9._-]{0,159}$/u;
const SAFE_MODEL_RE = /^[\p{L}\p{N}\s~+*:/().,_^-]{1,500}$/u;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`science-numeric-surface-${field}-keys-invalid`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().map((key) => [key, canonical((value as JsonRecord)[key])]));
}

export function scienceNumericSurfaceSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function scienceNumericSurfacePayloadSha256(value: unknown): string {
  const item = record(value);
  if (!item) throw new Error("science-numeric-surface-payload-invalid");
  return scienceNumericSurfaceSha256(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "payloadSha256")));
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) {
    throw new Error(`science-numeric-surface-${field}-invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`science-numeric-surface-${field}-invalid`);
  }
  return value.trim();
}

function nullableText(value: unknown, maximum: number, field: string): string | null {
  return value === null ? null : text(value, maximum, field);
}

function vector(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`science-numeric-surface-${field}-invalid`);
  return [finite(value[0], field), finite(value[1], field), finite(value[2], field)];
}

function strictAxis(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 200) {
    throw new Error(`science-numeric-surface-${field}-invalid`);
  }
  const axis = value.map((item) => finite(item, field));
  if (axis.some((item, index) => index > 0 && item <= axis[index - 1])) {
    throw new Error(`science-numeric-surface-${field}-order-invalid`);
  }
  return axis;
}

function numericSurfaceGrid(value: unknown): ScienceNumericSurfaceArtifactPayload["grid"] {
  const grid = record(value);
  if (!grid) throw new Error("science-numeric-surface-grid-invalid");
  exactKeys(grid, ["x", "y", "z", "valueCount", "zMin", "zMax", "gridSha256"], "grid");
  const x = strictAxis(grid.x, "grid-x");
  const y = strictAxis(grid.y, "grid-y");
  if (!Array.isArray(grid.z) || grid.z.length !== y.length || grid.z.some((row) => !Array.isArray(row) || row.length !== x.length)) {
    throw new Error("science-numeric-surface-grid-z-shape-invalid");
  }
  const z = grid.z.map((row) => (row as unknown[]).map((item) => finite(item, "grid-z")));
  if (x.length * y.length > 40_000 || grid.valueCount !== x.length * y.length) throw new Error("science-numeric-surface-grid-size-invalid");
  const zValues = z.flat();
  const zMin = Math.min(...zValues);
  const zMax = Math.max(...zValues);
  if (finite(grid.zMin, "grid-z-min") !== zMin || finite(grid.zMax, "grid-z-max") !== zMax || zMin === zMax) {
    throw new Error("science-numeric-surface-grid-domain-invalid");
  }
  const gridSha256 = scienceNumericSurfaceSha256({ x, y, z });
  if (grid.gridSha256 !== gridSha256) throw new Error("science-numeric-surface-grid-digest-invalid");
  return { x, y, z, valueCount: x.length * y.length, zMin, zMax, gridSha256 };
}

function numericSurfaceAxes(value: unknown): ScienceNumericSurfaceArtifactPayload["axes"] {
  const axes = record(value);
  if (!axes) throw new Error("science-numeric-surface-axes-invalid");
  exactKeys(axes, ["x", "y", "z"], "axes");
  const parseAxis = (raw: unknown, field: string) => {
    const axis = record(raw);
    if (!axis) throw new Error(`science-numeric-surface-axis-${field}-invalid`);
    exactKeys(axis, ["title", "unit"], `axis-${field}`);
    return { title: text(axis.title, 160, `axis-${field}-title`), unit: nullableText(axis.unit, 80, `axis-${field}-unit`) };
  };
  return { x: parseAxis(axes.x, "x"), y: parseAxis(axes.y, "y"), z: parseAxis(axes.z, "z") };
}

function numericSurfaceAppearance(value: unknown): ScienceNumericSurfaceArtifactPayload["appearance"] {
  const appearance = record(value);
  if (!appearance) throw new Error("science-numeric-surface-appearance-invalid");
  exactKeys(appearance, ["palette", "wireframe", "showObservedPoints"], "appearance");
  if (!["viridis", "cividis", "blue-red", "grayscale"].includes(String(appearance.palette))
    || typeof appearance.wireframe !== "boolean" || typeof appearance.showObservedPoints !== "boolean") {
    throw new Error("science-numeric-surface-appearance-invalid");
  }
  return appearance as unknown as ScienceNumericSurfaceArtifactPayload["appearance"];
}

export function validateScienceNumericSurfaceViewState(value: unknown): ScienceNumericSurfaceViewState {
  const viewState = record(value);
  if (!viewState) throw new Error("science-numeric-surface-view-state-invalid");
  exactKeys(viewState, ["cameraPosition", "target", "up"], "view-state");
  const cameraPosition = vector(viewState.cameraPosition, "camera-position");
  const target = vector(viewState.target, "target");
  const up = vector(viewState.up, "up");
  if (scienceNumericSurfaceSha256(cameraPosition) === scienceNumericSurfaceSha256(target)
    || Math.hypot(...up) < 1e-9) throw new Error("science-numeric-surface-view-state-invalid");
  return { cameraPosition, target, up };
}

export function validateScienceNumericSurfaceViewStateReceipt(value: unknown): ScienceNumericSurfaceViewStateReceipt {
  const receipt = record(value);
  if (!receipt) throw new Error("science-numeric-surface-view-state-receipt-invalid");
  exactKeys(receipt, [
    "schema", "projectId", "artifactId", "artifactVersion", "artifactContentSha256",
    "renderer", "viewState", "viewStateSha256", "updatedAt",
  ], "view-state-receipt");
  const renderer = record(receipt.renderer);
  if (receipt.schema !== "agentlas.science.numeric-surface-view-state/v1"
    || !UUID_RE.test(String(receipt.projectId)) || !UUID_RE.test(String(receipt.artifactId))
    || !Number.isSafeInteger(receipt.artifactVersion) || Number(receipt.artifactVersion) < 1
    || !SHA256_RE.test(String(receipt.artifactContentSha256))
    || !renderer || Object.keys(renderer).length !== 2
    || renderer.id !== SCIENCE_NUMERIC_SURFACE_RENDERER_ID || renderer.version !== SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION
    || !SHA256_RE.test(String(receipt.viewStateSha256))
    || typeof receipt.updatedAt !== "string" || receipt.updatedAt.length > 64
    || !Number.isFinite(Date.parse(receipt.updatedAt))) {
    throw new Error("science-numeric-surface-view-state-receipt-invalid");
  }
  const viewState = validateScienceNumericSurfaceViewState(receipt.viewState);
  if (scienceNumericSurfaceSha256(viewState) !== receipt.viewStateSha256) {
    throw new Error("science-numeric-surface-view-state-receipt-digest-invalid");
  }
  return {
    schema: "agentlas.science.numeric-surface-view-state/v1",
    projectId: String(receipt.projectId),
    artifactId: String(receipt.artifactId),
    artifactVersion: Number(receipt.artifactVersion),
    artifactContentSha256: String(receipt.artifactContentSha256),
    renderer: { id: SCIENCE_NUMERIC_SURFACE_RENDERER_ID, version: SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION },
    viewState,
    viewStateSha256: String(receipt.viewStateSha256),
    updatedAt: receipt.updatedAt,
  };
}

function numericSurfaceExportArtifactBinding(value: unknown): ScienceNumericSurfacePngExport["surfaceArtifact"] {
  const binding = record(value);
  if (!binding) throw new Error("science-numeric-surface-png-parent-invalid");
  exactKeys(binding, ["artifactId", "artifactVersion", "contentSha256", "payloadSha256"], "png-parent");
  if (!UUID_RE.test(String(binding.artifactId))
    || !Number.isSafeInteger(binding.artifactVersion) || Number(binding.artifactVersion) < 1
    || !SHA256_RE.test(String(binding.contentSha256)) || !SHA256_RE.test(String(binding.payloadSha256))) {
    throw new Error("science-numeric-surface-png-parent-invalid");
  }
  return {
    artifactId: String(binding.artifactId),
    artifactVersion: Number(binding.artifactVersion),
    contentSha256: String(binding.contentSha256),
    payloadSha256: String(binding.payloadSha256),
  };
}

function numericSurfacePngExportCore(value: JsonRecord): Omit<ScienceNumericSurfacePngExport, "schema" | "surfaceArtifact" | "viewStateReceipt" | "viewStateReceiptSha256" | "dataBase64"> {
  exactKeys(value, [
    "mimeType", "renderer", "renderMode", "exportProfile", "dpi", "width", "height", "widthMm", "heightMm",
    "colorSpace", "background", "readback", "byteSize", "sha256",
  ], "png-export");
  const renderer = record(value.renderer);
  const readback = record(value.readback);
  const dpi = Number(value.dpi);
  const width = Number(value.width);
  const height = Number(value.height);
  const widthMm = Number(value.widthMm);
  const heightMm = Number(value.heightMm);
  const byteSize = Number(value.byteSize);
  if (value.mimeType !== "image/png" || value.renderMode !== "three-offscreen-webgl"
    || ![300, 600].includes(dpi) || value.exportProfile !== `journal-raster-${dpi}dpi`
    || !Number.isSafeInteger(width) || width < 320 || width > 8_192
    || !Number.isSafeInteger(height) || height < 240 || height > 8_192 || width * height > 16_000_000
    || !Number.isFinite(widthMm) || !Number.isFinite(heightMm)
    || Math.abs(widthMm - Number(((width / dpi) * 25.4).toFixed(6))) > 1e-6
    || Math.abs(heightMm - Number(((height / dpi) * 25.4).toFixed(6))) > 1e-6
    || value.colorSpace !== "srgb" || value.background !== "#ffffff"
    || !renderer || Object.keys(renderer).length !== 3
    || renderer.id !== SCIENCE_NUMERIC_SURFACE_RENDERER_ID || renderer.version !== SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION
    || renderer.outputColorSpace !== "srgb"
    || !readback || Object.keys(readback).length !== 3
    || readback.byteSize !== width * height * 4
    || !SHA256_RE.test(String(readback.rgbaSha256))
    || !Number.isSafeInteger(readback.nonBackgroundPixelCount)
    || Number(readback.nonBackgroundPixelCount) < 1 || Number(readback.nonBackgroundPixelCount) >= width * height
    || !Number.isSafeInteger(byteSize) || byteSize < 1_024 || byteSize > 64 * 1024 * 1024
    || !SHA256_RE.test(String(value.sha256))) {
    throw new Error("science-numeric-surface-png-export-invalid");
  }
  return {
    mimeType: "image/png",
    renderer: { id: SCIENCE_NUMERIC_SURFACE_RENDERER_ID, version: SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION, outputColorSpace: "srgb" },
    renderMode: "three-offscreen-webgl",
    exportProfile: `journal-raster-${dpi}dpi` as "journal-raster-300dpi" | "journal-raster-600dpi",
    dpi: dpi as 300 | 600,
    width,
    height,
    widthMm,
    heightMm,
    colorSpace: "srgb",
    background: "#ffffff",
    readback: {
      byteSize: Number(readback.byteSize),
      rgbaSha256: String(readback.rgbaSha256),
      nonBackgroundPixelCount: Number(readback.nonBackgroundPixelCount),
    },
    byteSize,
    sha256: String(value.sha256),
  };
}

export function validateScienceNumericSurfacePngExport(value: unknown): ScienceNumericSurfacePngExport {
  const root = record(value);
  if (!root) throw new Error("science-numeric-surface-png-export-invalid");
  exactKeys(root, [
    "schema", "mimeType", "renderer", "surfaceArtifact", "viewStateReceipt", "viewStateReceiptSha256",
    "renderMode", "exportProfile", "dpi", "width", "height", "widthMm", "heightMm", "colorSpace", "background",
    "readback", "byteSize", "sha256", "dataBase64",
  ], "png-export-root");
  if (root.schema !== SCIENCE_NUMERIC_SURFACE_PNG_EXPORT_SCHEMA
    || !SHA256_RE.test(String(root.viewStateReceiptSha256))
    || typeof root.dataBase64 !== "string" || root.dataBase64.length < 1_024 || root.dataBase64.length > 96 * 1024 * 1024) {
    throw new Error("science-numeric-surface-png-export-invalid");
  }
  const surfaceArtifact = numericSurfaceExportArtifactBinding(root.surfaceArtifact);
  const viewStateReceipt = validateScienceNumericSurfaceViewStateReceipt(root.viewStateReceipt);
  if (viewStateReceipt.projectId.length < 1
    || viewStateReceipt.artifactId !== surfaceArtifact.artifactId
    || viewStateReceipt.artifactVersion !== surfaceArtifact.artifactVersion
    || viewStateReceipt.artifactContentSha256 !== surfaceArtifact.contentSha256
    || scienceNumericSurfaceSha256(viewStateReceipt) !== root.viewStateReceiptSha256) {
    throw new Error("science-numeric-surface-png-view-state-binding-invalid");
  }
  return {
    schema: SCIENCE_NUMERIC_SURFACE_PNG_EXPORT_SCHEMA,
    surfaceArtifact,
    viewStateReceipt,
    viewStateReceiptSha256: String(root.viewStateReceiptSha256),
    ...numericSurfacePngExportCore(Object.fromEntries(Object.entries(root).filter(([key]) => ![
      "schema", "surfaceArtifact", "viewStateReceipt", "viewStateReceiptSha256", "dataBase64",
    ].includes(key)))),
    dataBase64: root.dataBase64,
  };
}

export function validateScienceNumericSurfaceRasterArtifactPayload(value: unknown): ScienceNumericSurfaceRasterArtifactPayload {
  const root = record(value);
  if (!root) throw new Error("science-numeric-surface-raster-artifact-invalid");
  exactKeys(root, ["schema", "surfaceArtifact", "viewStateReceipt", "viewStateReceiptSha256", "export", "exportSha256"], "raster-artifact");
  if (root.schema !== SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA
    || !SHA256_RE.test(String(root.viewStateReceiptSha256)) || !SHA256_RE.test(String(root.exportSha256))) {
    throw new Error("science-numeric-surface-raster-artifact-invalid");
  }
  const surfaceArtifact = numericSurfaceExportArtifactBinding(root.surfaceArtifact);
  const viewStateReceipt = validateScienceNumericSurfaceViewStateReceipt(root.viewStateReceipt);
  const exported = record(root.export);
  if (!exported || viewStateReceipt.artifactId !== surfaceArtifact.artifactId
    || viewStateReceipt.artifactVersion !== surfaceArtifact.artifactVersion
    || viewStateReceipt.artifactContentSha256 !== surfaceArtifact.contentSha256
    || scienceNumericSurfaceSha256(viewStateReceipt) !== root.viewStateReceiptSha256) {
    throw new Error("science-numeric-surface-raster-binding-invalid");
  }
  const exportCore = numericSurfacePngExportCore(exported);
  const core = {
    schema: SCIENCE_NUMERIC_SURFACE_RASTER_ARTIFACT_SCHEMA,
    surfaceArtifact,
    viewStateReceipt,
    viewStateReceiptSha256: String(root.viewStateReceiptSha256),
    export: exportCore,
  };
  if (scienceNumericSurfaceSha256(core) !== root.exportSha256) throw new Error("science-numeric-surface-raster-digest-invalid");
  return { ...core, exportSha256: String(root.exportSha256) };
}

function monotoneChain(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const unique = [...new Map(points.map((point) => [`${point.x}\0${point.y}`, point])).values()]
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (unique.length < 3) throw new Error("science-numeric-surface-observations-hull-invalid");
  const cross = (origin: { x: number; y: number }, left: { x: number; y: number }, right: { x: number; y: number }) => (
    (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x)
  );
  const lower: Array<{ x: number; y: number }> = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) throw new Error("science-numeric-surface-observations-hull-invalid");
  return hull;
}

function pointInsideOrOnHull(point: { x: number; y: number }, hull: Array<{ x: number; y: number }>): boolean {
  const epsilon = 1e-10;
  for (let index = 0; index < hull.length; index += 1) {
    const left = hull[index];
    const right = hull[(index + 1) % hull.length];
    const cross = (right.x - left.x) * (point.y - left.y) - (right.y - left.y) * (point.x - left.x);
    if (cross < -epsilon) return false;
  }
  return true;
}

function numericSurfaceObservations(value: unknown): ScienceNumericSurfaceV2ArtifactPayload["observations"] {
  const observations = record(value);
  if (!observations) throw new Error("science-numeric-surface-observations-invalid");
  exactKeys(observations, ["points", "pointsSha256"], "observations");
  if (!Array.isArray(observations.points) || observations.points.length < 3 || observations.points.length > 100_000) {
    throw new Error("science-numeric-surface-observations-invalid");
  }
  const points = observations.points.map((raw, index) => {
    const point = record(raw);
    if (!point) throw new Error("science-numeric-surface-observation-invalid");
    exactKeys(point, ["row", "id", "x", "y", "z", "residual"], "observation");
    if (!Number.isSafeInteger(point.row) || Number(point.row) < 0 || typeof point.id !== "string") {
      throw new Error("science-numeric-surface-observation-invalid");
    }
    return {
      row: Number(point.row),
      id: text(point.id, 240, "observation-id"),
      x: finite(point.x, "observation-x"),
      y: finite(point.y, "observation-y"),
      z: finite(point.z, "observation-z"),
      residual: finite(point.residual, "observation-residual"),
    };
  });
  if (new Set(points.map((point) => point.row)).size !== points.length
    || new Set(points.map((point) => point.id)).size !== points.length
    || scienceNumericSurfaceSha256(points) !== observations.pointsSha256) {
    throw new Error("science-numeric-surface-observations-digest-invalid");
  }
  return { points, pointsSha256: String(observations.pointsSha256) };
}

function numericSurfaceV2Grid(
  value: unknown,
  observations: ScienceNumericSurfaceV2ArtifactPayload["observations"],
  supportValue: unknown,
): { grid: ScienceNumericSurfaceV2ArtifactPayload["grid"]; support: ScienceNumericSurfaceV2ArtifactPayload["support"] } {
  const gridRecord = record(value);
  if (!gridRecord) throw new Error("science-numeric-surface-grid-invalid");
  exactKeys(gridRecord, ["x", "y", "z", "valueCount", "zMin", "zMax", "gridSha256", "supportMask", "supportMaskSha256", "supportedValueCount"], "grid-v2");
  const baseGrid = numericSurfaceGrid(Object.fromEntries(Object.entries(gridRecord).filter(([key]) => !["supportMask", "supportMaskSha256", "supportedValueCount"].includes(key))));
  if (!Array.isArray(gridRecord.supportMask) || gridRecord.supportMask.length !== baseGrid.y.length
    || gridRecord.supportMask.some((row) => !Array.isArray(row) || row.length !== baseGrid.x.length || row.some((cell) => typeof cell !== "boolean"))) {
    throw new Error("science-numeric-surface-support-mask-invalid");
  }
  const supportMask = (gridRecord.supportMask as boolean[][]).map((row) => [...row]);
  const supportedValueCount = supportMask.flat().filter(Boolean).length;
  if (!Number.isSafeInteger(gridRecord.supportedValueCount) || gridRecord.supportedValueCount !== supportedValueCount
    || supportedValueCount < 1 || scienceNumericSurfaceSha256(supportMask) !== gridRecord.supportMaskSha256) {
    throw new Error("science-numeric-surface-support-mask-digest-invalid");
  }
  const support = record(supportValue);
  if (!support) throw new Error("science-numeric-surface-support-invalid");
  exactKeys(support, ["algorithm", "hull", "hullSha256", "maskRule", "receiptSha256"], "support");
  if (support.algorithm !== "monotone-chain-2d/v1" || support.maskRule !== "grid-point-inside-or-boundary/v1"
    || !Array.isArray(support.hull)) throw new Error("science-numeric-surface-support-invalid");
  const hull = support.hull.map((raw) => {
    const point = record(raw);
    if (!point) throw new Error("science-numeric-surface-support-hull-invalid");
    exactKeys(point, ["x", "y"], "support-hull-point");
    return { x: finite(point.x, "support-hull-x"), y: finite(point.y, "support-hull-y") };
  });
  const expectedHull = monotoneChain(observations.points.map((point) => ({ x: point.x, y: point.y })));
  if (scienceNumericSurfaceSha256(hull) !== scienceNumericSurfaceSha256(expectedHull)
    || scienceNumericSurfaceSha256(hull) !== support.hullSha256) {
    throw new Error("science-numeric-surface-support-hull-digest-invalid");
  }
  const expectedMask = baseGrid.y.map((y) => baseGrid.x.map((x) => pointInsideOrOnHull({ x, y }, hull)));
  if (scienceNumericSurfaceSha256(expectedMask) !== scienceNumericSurfaceSha256(supportMask)) {
    throw new Error("science-numeric-surface-support-mask-invalid");
  }
  const receiptCore = {
    algorithm: support.algorithm,
    hullSha256: support.hullSha256,
    maskRule: support.maskRule,
    supportMaskSha256: String(gridRecord.supportMaskSha256),
    supportedValueCount,
    pointsSha256: observations.pointsSha256,
  };
  if (scienceNumericSurfaceSha256(receiptCore) !== support.receiptSha256) {
    throw new Error("science-numeric-surface-support-receipt-invalid");
  }
  return {
    grid: {
      ...baseGrid,
      supportMask,
      supportMaskSha256: String(gridRecord.supportMaskSha256),
      supportedValueCount,
    },
    support: {
      algorithm: "monotone-chain-2d/v1",
      hull,
      hullSha256: String(support.hullSha256),
      maskRule: "grid-point-inside-or-boundary/v1",
      receiptSha256: String(support.receiptSha256),
    },
  };
}

export function validateScienceStatisticsNumericSurfaceSourcePayload(value: unknown): ScienceStatisticsNumericSurfaceSourcePayload {
  const root = record(value);
  if (!root) throw new Error("science-statistics-numeric-surface-source-invalid");
  exactKeys(root, ["schema", "chartFamily", "title", "grid", "observations", "support", "axes", "appearance", "viewState", "method", "model"], "statistics-source");
  if (root.schema !== SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA || root.chartFamily !== "surface3d"
    || root.method !== "response_surface_regression" || typeof root.model !== "string" || !SAFE_MODEL_RE.test(root.model)
    || /(?:\beval\s*\(|\bfunction\b|=>|\b(?:https?|file|data|javascript):|<script\b)/iu.test(root.model)) {
    throw new Error("science-statistics-numeric-surface-source-invalid");
  }
  const observations = numericSurfaceObservations(root.observations);
  const { grid, support } = numericSurfaceV2Grid(root.grid, observations, root.support);
  const appearance = numericSurfaceAppearance(root.appearance);
  if (appearance.showObservedPoints !== true) throw new Error("science-numeric-surface-observations-hidden");
  return {
    schema: SCIENCE_STATISTICS_NUMERIC_SURFACE_SOURCE_SCHEMA,
    chartFamily: "surface3d",
    title: text(root.title, 240, "statistics-source-title"),
    grid,
    observations,
    support,
    axes: numericSurfaceAxes(root.axes),
    appearance,
    viewState: validateScienceNumericSurfaceViewState(root.viewState),
    method: "response_surface_regression",
    model: root.model,
  };
}

export function validateScienceNumericSurfaceV2Payload(value: unknown): ScienceNumericSurfaceV2ArtifactPayload {
  const root = record(value);
  if (!root) throw new Error("science-numeric-surface-payload-invalid");
  exactKeys(root, ["schema", "renderer", "chartFamily", "title", "grid", "observations", "support", "axes", "appearance", "interaction", "viewState", "analysis", "payloadSha256"], "payload-v2");
  if (root.schema !== SCIENCE_NUMERIC_SURFACE_V2_SCHEMA || root.chartFamily !== "surface3d") throw new Error("science-numeric-surface-schema-invalid");
  const renderer = record(root.renderer);
  if (!renderer) throw new Error("science-numeric-surface-renderer-invalid");
  exactKeys(renderer, ["id", "version"], "renderer");
  if (renderer.id !== SCIENCE_NUMERIC_SURFACE_RENDERER_ID || renderer.version !== SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION) throw new Error("science-numeric-surface-renderer-invalid");
  const observations = numericSurfaceObservations(root.observations);
  const { grid, support } = numericSurfaceV2Grid(root.grid, observations, root.support);
  const appearance = numericSurfaceAppearance(root.appearance);
  if (appearance.showObservedPoints !== true) throw new Error("science-numeric-surface-observations-hidden");
  const interaction = record(root.interaction);
  if (!interaction) throw new Error("science-numeric-surface-interaction-invalid");
  exactKeys(interaction, ["rotate", "pan", "zoom", "persistViewState"], "interaction");
  if (interaction.rotate !== true || interaction.pan !== true || interaction.zoom !== true || interaction.persistViewState !== true) throw new Error("science-numeric-surface-interaction-invalid");
  const analysis = record(root.analysis);
  if (!analysis) throw new Error("science-numeric-surface-analysis-invalid");
  exactKeys(analysis, ["runId", "toolId", "toolVersion", "model", "inputSha256", "outputSha256"], "analysis");
  if (!UUID_RE.test(String(analysis.runId)) || !TOKEN_RE.test(String(analysis.toolId))
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/iu.test(String(analysis.toolVersion))
    || typeof analysis.model !== "string" || !SAFE_MODEL_RE.test(analysis.model)
    || /(?:\beval\s*\(|\bfunction\b|=>|\b(?:https?|file|data|javascript):|<script\b)/iu.test(analysis.model)
    || !SHA256_RE.test(String(analysis.inputSha256)) || !SHA256_RE.test(String(analysis.outputSha256))) {
    throw new Error("science-numeric-surface-analysis-invalid");
  }
  if (!SHA256_RE.test(String(root.payloadSha256)) || root.payloadSha256 !== scienceNumericSurfacePayloadSha256(root)) throw new Error("science-numeric-surface-payload-digest-invalid");
  return {
    schema: SCIENCE_NUMERIC_SURFACE_V2_SCHEMA,
    renderer: { id: SCIENCE_NUMERIC_SURFACE_RENDERER_ID, version: SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION },
    chartFamily: "surface3d",
    title: text(root.title, 240, "title"),
    grid,
    observations,
    support,
    axes: numericSurfaceAxes(root.axes),
    appearance,
    interaction: { rotate: true, pan: true, zoom: true, persistViewState: true },
    viewState: validateScienceNumericSurfaceViewState(root.viewState),
    analysis: analysis as unknown as ScienceNumericSurfaceArtifactPayload["analysis"],
    payloadSha256: String(root.payloadSha256),
  };
}

export function validateScienceNumericSurfacePayload(value: unknown): ScienceNumericSurfaceArtifactPayload {
  const root = record(value);
  if (!root) throw new Error("science-numeric-surface-payload-invalid");
  exactKeys(root, ["schema", "renderer", "chartFamily", "title", "grid", "axes", "appearance", "interaction", "viewState", "analysis", "payloadSha256"], "payload");
  if (root.schema !== SCIENCE_NUMERIC_SURFACE_SCHEMA || root.chartFamily !== "surface3d") throw new Error("science-numeric-surface-schema-invalid");

  const renderer = record(root.renderer);
  if (!renderer) throw new Error("science-numeric-surface-renderer-invalid");
  exactKeys(renderer, ["id", "version"], "renderer");
  if (renderer.id !== SCIENCE_NUMERIC_SURFACE_RENDERER_ID || renderer.version !== SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION) {
    throw new Error("science-numeric-surface-renderer-invalid");
  }

  const grid = numericSurfaceGrid(root.grid);
  const axes = numericSurfaceAxes(root.axes);
  const appearance = numericSurfaceAppearance(root.appearance);

  const interaction = record(root.interaction);
  if (!interaction) throw new Error("science-numeric-surface-interaction-invalid");
  exactKeys(interaction, ["rotate", "pan", "zoom", "persistViewState"], "interaction");
  if (interaction.rotate !== true || interaction.pan !== true || interaction.zoom !== true || interaction.persistViewState !== true) {
    throw new Error("science-numeric-surface-interaction-invalid");
  }

  const viewState = validateScienceNumericSurfaceViewState(root.viewState);

  const analysis = record(root.analysis);
  if (!analysis) throw new Error("science-numeric-surface-analysis-invalid");
  exactKeys(analysis, ["runId", "toolId", "toolVersion", "model", "inputSha256", "outputSha256"], "analysis");
  if (!UUID_RE.test(String(analysis.runId)) || !TOKEN_RE.test(String(analysis.toolId))
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/iu.test(String(analysis.toolVersion))
    || typeof analysis.model !== "string" || !SAFE_MODEL_RE.test(analysis.model)
    || /(?:\beval\s*\(|\bfunction\b|=>|\b(?:https?|file|data|javascript):|<script\b)/iu.test(analysis.model)
    || !SHA256_RE.test(String(analysis.inputSha256)) || !SHA256_RE.test(String(analysis.outputSha256))) {
    throw new Error("science-numeric-surface-analysis-invalid");
  }
  if (!SHA256_RE.test(String(root.payloadSha256)) || root.payloadSha256 !== scienceNumericSurfacePayloadSha256(root)) {
    throw new Error("science-numeric-surface-payload-digest-invalid");
  }

  return {
    schema: SCIENCE_NUMERIC_SURFACE_SCHEMA,
    renderer: { id: SCIENCE_NUMERIC_SURFACE_RENDERER_ID, version: SCIENCE_NUMERIC_SURFACE_RENDERER_VERSION },
    chartFamily: "surface3d",
    title: text(root.title, 240, "title"),
    grid,
    axes,
    appearance,
    interaction: { rotate: true, pan: true, zoom: true, persistViewState: true },
    viewState,
    analysis: analysis as unknown as ScienceNumericSurfaceArtifactPayload["analysis"],
    payloadSha256: String(root.payloadSha256),
  };
}
