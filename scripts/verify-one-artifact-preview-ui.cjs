#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const component = read("renderer/components/one/OneAdaptiveResult.tsx");
const css = read("renderer/components/one/OneAdaptiveResult.module.css");
const artifactMain = read("electron/one/artifact-preview.ts");
const main = read("electron/main.ts");
const ipc = read("electron/ipc.ts");
const preload = read("electron/preload.ts");
const service = read("electron/invocation/service.ts");
const shared = read("shared/one-artifacts.ts");
const surface = read("shared/one-surface.ts");
const durable = read("shared/one-surface-durable.ts");
const mobileWire = read("shared/mobile-bridge.ts");
const mobileProjector = read("electron/mobile-bridge/projector.ts");
const i18n = read("renderer/lib/i18n.tsx");
const schema = fs.readFileSync(path.resolve(root, "../Agentlas_One/contracts/schemas/one-surface-manifest.v1.schema.json"), "utf8");

assert.match(component, /DESKTOP_NATIVE_BLOCK_TYPES[\s\S]*"Gallery"[\s\S]*"Media"/);
assert.match(component, /function GalleryBlock/);
assert.match(component, /function MediaBlock/);
assert.match(component, /<img[\s\S]*alt=/);
assert.match(component, /<video aria-label=/);
assert.match(component, /<audio aria-label=/);
assert.match(component, /loading="lazy"/);
assert.match(component, /referrerPolicy="no-referrer"/);
assert.match(component, /playsInline/);
assert.match(component, /preload="metadata"/);
assert.match(component, /mediaSkeleton/);
assert.match(component, /mediaUnavailable/);
assert.match(component, /tFor\(locale, "one\.res\.view_in_work"\)/);
assert.match(i18n, /Work에서 보기|View in Work/);
assert.match(component, /isOneArtifactPreviewCapabilityV1/);
assert.match(component, /oneArtifacts\.issuePreview/);
assert.match(component, /oneArtifacts\.revokePreview/);
assert.match(component, /oneArtifacts\.open/);
assert.doesNotMatch(component, /agentlas:\/\/localfile|searchParams|get\("p"\)/);

const mediaOutputBody = component.slice(component.indexOf("function MediaOutput"), component.indexOf("function DocumentBlock"));
assert.doesNotMatch(mediaOutputBody, /useArtifactPreview|issuePreview/, "open-only output rows must not mint preview tokens");
assert.match(mediaOutputBody, /oneArtifacts\.open/);

assert.match(css, /\.galleryGrid[\s\S]*grid-template-columns/);
assert.match(css, /\.primaryMedia[\s\S]*max-height:\s*520px/);
assert.match(css, /\.mediaMeta button,[\s\S]*\.workFallbackButton[\s\S]*min-height:\s*44px/);
assert.match(css, /audio\s*\{[^}]*min-height:\s*44px/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /focus-visible/);

assert.match(shared, /^const CAPABILITY_URL_RE = \/\^agentlas:/m);
assert.match(shared, /\[a-f0-9\]\{64\}/);
assert.match(artifactMain, /randomBytes\(32\)\.toString\("hex"\)/);
assert.match(artifactMain, /O_NOFOLLOW/);
assert.match(artifactMain, /createHash\("sha256"\)/);
assert.match(artifactMain, /ONE_ARTIFACT_PREVIEW_TTL_MS/);
assert.match(artifactMain, /ONE_ARTIFACT_MAX_RANGE_BYTES/);
assert.match(artifactMain, /Accept-Ranges/);
assert.match(artifactMain, /X-Content-Type-Options/);
assert.match(artifactMain, /Content-Security-Policy/);
assert.match(artifactMain, /getOneValueClosureState/);
assert.match(artifactMain, /evidence\.kind === "result_acceptance"/);
assert.match(artifactMain, /evidence\.sourceRunRef === row\.run_id/);
assert.doesNotMatch(artifactMain, /UPDATE one_artifact_bindings SET task_version/);

assert.match(main, /url\.hostname === "one-artifact"[\s\S]*serveOneArtifactProtocolRequest/);
assert.match(ipc, /oneArtifacts:issuePreview/);
assert.match(ipc, /oneArtifacts:revokePreview/);
assert.match(ipc, /oneArtifacts:open/);
assert.match(preload, /oneArtifacts:[\s\S]*issuePreview[\s\S]*revokePreview[\s\S]*open/);
assert.match(service, /rawSurfaceForArtifactBinding/);
assert.match(service, /bindOneSurfaceArtifacts/);
const rawSurfaceStripStart = service.indexOf("// One and Mobile never receive the raw legacy manifest");
const rawSurfaceStripEnd = service.indexOf("observableStepSequence += 1", rawSurfaceStripStart);
assert.ok(rawSurfaceStripStart >= 0 && rawSurfaceStripEnd > rawSurfaceStripStart);
const rawSurfaceStrip = service.slice(rawSurfaceStripStart, rawSurfaceStripEnd);
assert.match(rawSurfaceStrip, /requestedOneMode \|\| runWorkspaceBinding/);
assert.match(rawSurfaceStrip, /event\.kind === "surface" && event\.surface/);
assert.match(rawSurfaceStrip, /surface:\s*undefined/);
assert.match(rawSurfaceStrip, /!event\.oneSurface[\s\S]*status:/);

for (const [name, text] of [["mobile wire", mobileWire], ["mobile projector", mobileProjector]]) {
  assert.doesNotMatch(text, /agentlas:\/\/one-artifact|capabilityUrl|oneArtifacts|source_path/i, `${name} must remain capability/path-free`);
}

for (const [name, text] of [["surface type", surface], ["durable validator", durable], ["schema", schema], ["renderer validator", component]]) {
  assert.match(text, /unknown_source/, `${name} must preserve unknown provenance honestly`);
}
assert.match(surface, /return "unknown_source"/);
assert.doesNotMatch(surface, /return "user_original";\s*\n\}/, "unknown legacy provenance must not default to user_original");

console.log(JSON.stringify({
  ok: true,
  nativeGalleryMedia: true,
  actualMediaElements: true,
  accessibleFallbacks: true,
  opaqueMainCapability: true,
  openOnlyOutputs: true,
  mobileCapabilityFree: true,
  honestUnknownProvenance: true,
}));
