#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const page = read("renderer/app/(shell)/cloud/page.tsx");
const preload = read("electron/preload.ts");
const ipc = read("electron/ipc.ts");
const types = read("shared/types.ts");
const packager = read("electron/cloud-agents/package.ts");
const {
  cloudRegistrationPreconditionHeaders,
} = require("../dist/electron/cloud-agents/package.js");

assert.match(page, /api\.cloudAgents\.savePrivate\(\{ rootGrant \}\)/);
assert.match(page, /api\.cloudAgents\.publishPublic\(\{ rootGrant \}\)/);
assert.doesNotMatch(page, /cloudAgents\.(?:savePrivate|publishPublic)\(\{ rootPath:/);
assert.doesNotMatch(page, /api\.hephaestus\.publish/);
assert.match(page, /Agent Cloud 비공개 저장/);
assert.match(page, /Agentlas Hub 공개 발행/);

assert.match(preload, /savePrivate: \(input\) => ipcRenderer\.invoke\("cloudAgents:savePrivate", input\)/);
assert.match(preload, /saveBuiltPrivate: \(input\) => ipcRenderer\.invoke\("cloudAgents:saveBuiltPrivate", input\)/);
assert.match(preload, /publishPublic: \(input\) => ipcRenderer\.invoke\("cloudAgents:publishPublic", input\)/);
assert.match(ipc, /ipcMain\.handle\("cloudAgents:savePrivate"[\s\S]*?visibility: "private-link"/);
assert.match(ipc, /ipcMain\.handle\("cloudAgents:saveBuiltPrivate"[\s\S]*?resolveFsReadPath\(input\.folder, input\.scope\)[\s\S]*?visibility: "private-link"[\s\S]*?reviewMode: "static-only"/);
assert.match(ipc, /ipcMain\.handle\("cloudAgents:publishPublic"[\s\S]*?visibility: "marketplace"/);
assert.match(ipc, /resolveCloudAgentPackageRequest\(input\)/);
assert.match(types, /rootGrant: FsPathGrant/);
assert.match(types, /savePrivate: \(input: CloudAgentPrivateSaveRequest\)/);
assert.match(types, /saveBuiltPrivate: \(input: CloudAgentBuiltPrivateSaveRequest\)/);
assert.match(types, /publishPublic: \(input: CloudAgentHubPublishRequest\)/);

assert.match(packager, /input\.visibility \?\? "private-link"/);
assert.match(packager, /if \(isPublicHubPublish\) \{[\s\S]*?readRoutingCard/);
assert.match(packager, /privateSaveSafetyFindings\(scan\.findings\)/);
assert.deepEqual(cloudRegistrationPreconditionHeaders(), { "if-none-match": "*" });
assert.deepEqual(
  cloudRegistrationPreconditionHeaders({
    cloudId: "cloud_exact_agent",
    slug: "exact-agent",
    scope: "owner-private",
    packageHash: "a".repeat(64),
    packageHashVersion: "path-sha256-v1",
    revision: `rev_${"b".repeat(32)}`,
  }),
  {
    "if-match": `"rev_${"b".repeat(32)}"`,
    "x-agentlas-cloud-id": "cloud_exact_agent",
  },
);
assert.match(packager, /\.\.\.cloudRegistrationPreconditionHeaders\(input\.baseRegistration\)/);
assert.match(packager, /cloud_agent_revision_conflict/);
assert.match(packager, /writeCloudAgentRegistrationMarker/);
assert.match(page, /cloud_agent_revision_conflict|changed on another machine|다른 (?:PC|기기)/);

console.log("cloud private-save/public-publish contract: PASS");
