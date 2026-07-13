#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AGENTLAS_E2E = "1";
const { app } = require("electron");

function response(body, status = 200, revision = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(revision ? { etag: `"${revision}"` } : {}),
    },
  });
}

function requestHeader(init, name) {
  const headers = new Headers(init.headers || {});
  return headers.get(name);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-experience-cloud-exchange-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const dbModule = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const experience = require("../dist/electron/experience/store.js");
  const portable = require("../dist/electron/experience/portable.js");
  const operationalGeneralization = require("../dist/electron/experience/operational-generalization.js");
  const cloud = require("../dist/electron/experience/cloud.js");
  const routes = require("../dist/electron/agents/routes.js");
  dbModule.initStore();
  const db = dbModule.getDb();

  try {
    const canonicalTemp = fs.realpathSync.native(temp);
    const now = "2026-07-12T12:00:00.000Z";
    db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, ?, ?, '', '[]', '[]', NULL, 'A', ?, 'blue', 0, 'visible', 'agent')`,
    ).run("agent-a", "agent-a", "Base Agent Author A", "Base Agent Author A", "A", "A", now);
    const baseHash = "a".repeat(64);
    const agentRoot = path.join(canonicalTemp, "base-agent-a");
    fs.mkdirSync(agentRoot, { recursive: true });
    routes.setRoute({
      agentId: "agent-a",
      path: agentRoot,
      runtime: "codex",
      labels: ["codex"],
      kind: "agent",
      importedAt: now,
      source: "local-import",
      packageHash: baseHash,
    });

    const createPromotedPack = (label, content) => {
      const project = path.join(canonicalTemp, label.replace(/[^a-z0-9]+/gi, "-"));
      fs.mkdirSync(project, { recursive: true });
      const pack = experience.createExperiencePack({
        agentId: "agent-a",
        name: label,
        description: "Portable owner Experience",
        projectPath: project,
        environment: { platform: process.platform, arch: process.arch, runtimeKind: "codex" },
      });
      const entry = memory.insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content,
        projectPath: project,
        agentId: "agent-a",
        confidence: "high",
        sensitivity: "internal",
        requestContext: { triggerTerms: ["browser", "publish", "verify"] },
      });
      const candidate = experience.captureExperienceCandidate({ packId: pack.id, sourceMemoryId: entry.id });
      experience.promoteExperienceCandidate({
        candidateId: candidate.id,
        explicitConsent: true,
        verification: { status: "attested", method: "user-attested", evidenceRefs: [`ui:${candidate.id}`] },
        publicSafe: false,
      });
      return { pack, entry, candidate, project };
    };

    const safe = createPromotedPack(
      "카페 게시 경험",
      "카페 게시물을 작성한 뒤 사용자가 승인한 제목과 본문만 발행하고 화면에서 결과를 다시 확인합니다. 🧭",
    );
    const privacyFixture = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "../../Agentlas-OS/tests/fixtures/experience-privacy-v1-cross-surface.json"),
      "utf8",
    ));
    for (const privacyCase of privacyFixture.freeTextCases.filter((entry) => entry.expected.length > 0)) {
      assert.ok(
        experience.publicExperienceSafetyIssues(privacyCase.value).length > 0,
        `Desktop must reject cross-surface private material: ${privacyCase.id}`,
      );
    }
    const secretSentinel = "sk-secret-value-must-never-enter-experience-bundle";
    process.env.BROWSER_API_KEY = secretSentinel;
    db.prepare(`
      INSERT INTO mcp_servers (
        id, catalog_id, name, name_en, transport, command, args_json, url,
        env_keys_json, enabled, installed_at
      ) VALUES (?, ?, ?, ?, 'stdio', 'npx', '[]', NULL, '["BROWSER_API_KEY"]', 1, ?)
    `).run("mcp-browser-test", "browser-mcp", "Browser MCP", "Browser MCP", now);
    db.prepare("UPDATE experience_packs SET mcp_requirements_json = ? WHERE id = ?").run(
      JSON.stringify([{ catalogId: "browser-mcp", required: false, alternatives: [] }]),
      safe.pack.id,
    );

    const requests = [];
    const receiptById = new Map();
    const bundleById = new Map();
    let privateReceipt = null;
    let publicReceipt = null;
    let publicPostLost = false;
    let offline = false;

    const makeReceipt = (bundle, status, uploadId, revision, owner = "workspace:experience-owner") => ({
      schema: "agentlas.experience-upload-receipt.v1",
      uploadId,
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      experiencePackId: bundle.pack.experiencePackId,
      experienceReleaseId: bundle.pack.releaseId,
      ownerWorkspaceRef: owner,
      status,
      requestedVisibility: bundle.requestedVisibility,
      revision,
      createdAt: now,
      updatedAt: now,
    });

    const fetchMock = async (input, init = {}) => {
      if (offline) throw new TypeError("offline");
      const url = new URL(String(input));
      const method = init.method || "GET";
      requests.push({ url: url.pathname + url.search, method, headers: new Headers(init.headers || {}), body: init.body });
      assert.equal(requestHeader(init, "cookie"), "agentlas_session=test-session-123");
      assert.equal(requestHeader(init, "origin"), "http://127.0.0.1:43123");

      if (url.pathname.endsWith("/base-releases/resolve") && method === "POST") {
        const body = JSON.parse(init.body);
        assert.equal(body.slug, "agent-a");
        assert.equal(body.packageHash, baseHash);
        return response({
          schema: "agentlas.experience-base-resolution.v1",
          agentDefinitionId: `agd_${"c".repeat(48)}`,
          agentReleaseId: `agr_${"d".repeat(48)}`,
          packageHash: baseHash,
          packageHashVersion: "path-sha256-executable-v2",
          cloudId: "cloud:base-agent-a",
          slug: "agent-a",
        });
      }

      if (url.pathname.endsWith("/uploads") && method === "POST") {
        const body = JSON.parse(init.body);
        const bundle = body.bundle;
        assert.equal(Object.keys(body).join(","), "bundle");
        assert.ok(requestHeader(init, "Idempotency-Key"));
        const serialized = JSON.stringify(bundle);
        for (const forbidden of [safe.project, safe.entry.id, "sourceMemoryId", "projectPath", "rawEvidence", secretSentinel]) {
          assert.equal(serialized.includes(forbidden), false, `portable upload leaked ${forbidden}`);
        }
        assert.equal(bundle.privacy.rawLocalPathsIncluded, false);
        assert.equal(bundle.privacy.rawPromptIncluded, false);
        assert.equal(bundle.pack.ownerRef, "owner:authenticated");
        bundleById.set(bundle.bundleId, bundle);
        if (bundle.requestedVisibility === "private") {
          if (!privateReceipt) {
            assert.equal(requestHeader(init, "If-None-Match"), "*");
            privateReceipt = makeReceipt(bundle, "draft-saved", `exu_${"1".repeat(48)}`, `rev_${"1".repeat(32)}`);
            receiptById.set(privateReceipt.uploadId, privateReceipt);
          } else {
            assert.equal(requestHeader(init, "If-None-Match"), "*", "same-key replay must remain create-only safe");
          }
          return response(privateReceipt, 200, privateReceipt.revision);
        }
        assert.equal(bundle.requestedVisibility, "public");
        assert.equal(requestHeader(init, "If-None-Match"), "*");
        publicReceipt = makeReceipt(bundle, "verification-requested", `exu_${"2".repeat(48)}`, `rev_${"2".repeat(32)}`);
        receiptById.set(publicReceipt.uploadId, publicReceipt);
        if (!publicPostLost) {
          publicPostLost = true;
          throw new TypeError("response lost after commit");
        }
        return response(publicReceipt, 200, publicReceipt.revision);
      }

      if (url.pathname.endsWith("/uploads") && method === "GET") {
        const isPublic = String(requestHeader(init, "Idempotency-Key")).includes(":public:");
        const receipt = isPublic ? publicReceipt : privateReceipt;
        if (!receipt) return response({ code: "not_found" }, 404);
        return response(receipt, 200, receipt.revision);
      }

      const exportMatch = url.pathname.match(/\/uploads\/([^/]+)\/export$/);
      if (exportMatch && method === "GET") {
        const receipt = receiptById.get(decodeURIComponent(exportMatch[1]));
        const localBundle = receipt && bundleById.get(receipt.bundleId);
        const bundle = localBundle && {
          ...localBundle,
          requestedVisibility: "private",
          pack: {
            ...localBundle.pack,
            ownerRef: receipt.ownerWorkspaceRef,
            visibility: "private",
            status: "draft",
          },
        };
        return response({ bundle, receipt }, 200, receipt.revision);
      }

      const statusMatch = url.pathname.match(/\/uploads\/([^/]+)$/);
      if (statusMatch && method === "GET") {
        const receipt = receiptById.get(decodeURIComponent(statusMatch[1]));
        return receipt ? response(receipt, 200, receipt.revision) : response({ code: "not_found" }, 404);
      }

      if (statusMatch && method === "DELETE") {
        const id = decodeURIComponent(statusMatch[1]);
        const current = receiptById.get(id);
        if (requestHeader(init, "If-Match") !== `"${current.revision}"`) {
          return response({ receipt: current, errorCode: "stale_revision" }, 412, current.revision);
        }
        const withdrawn = { ...current, status: "withdrawn", revision: `rev_${"4".repeat(32)}`, updatedAt: "2026-07-12T12:05:00.000Z" };
        receiptById.set(id, withdrawn);
        return response(withdrawn, 200, withdrawn.revision);
      }
      return response({ code: "not_found" }, 404);
    };

    const deps = {
      baseUrl: "http://127.0.0.1:43123",
      cookieHeader: "agentlas_session=test-session-123",
      fetch: fetchMock,
      now: () => new Date(now),
    };

    let exfiltrationFetchCalled = false;
    for (const maliciousBase of ["https://evil.example", "https://agentlas.cloud.evil.example"]) {
      await assert.rejects(
        cloud.saveExperienceToCloud({ packId: safe.pack.id, requestedVisibility: "private" }, {
          ...deps,
          baseUrl: maliciousBase,
          fetch: async () => {
            exfiltrationFetchCalled = true;
            throw new Error("must not be called");
          },
        }),
        /not an approved official/,
      );
    }
    assert.equal(exfiltrationFetchCalled, false, "session cookie could be sent to an attacker-controlled HTTPS origin");
    assert.throws(
      () => new cloud.ExperienceCloudHttpClient({
        baseUrl: "http://127.0.0.1:43123",
        cookieHeader: "agentlas_session=test-session-123",
        fetch: fetchMock,
      }),
      /not an approved official/,
      "loopback must require an explicit injected-test allowance",
    );

    const privateSaved = await cloud.saveExperienceToCloud({ packId: safe.pack.id, requestedVisibility: "private" }, deps);
    assert.equal(privateSaved.state, "private-saved");
    assert.equal(privateSaved.receipt.status, "draft-saved");
    assert.equal(privateSaved.receipt.ownerWorkspaceRef, "workspace:experience-owner");
    assert.ok(privateSaved.bundle.items.every((item) => item.taskSignatures.every((task) => task.startsWith("agentlas.task.v1/"))));
    assert.ok(privateSaved.bundle.items.every((item) => item.environmentConstraints.includes(`agentlas.env.v1/arch/${process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "unknown"}`)));
    assert.equal(JSON.stringify(privateSaved.bundle).includes("tsk:"), false);
    assert.equal(JSON.stringify(privateSaved.bundle).includes("general"), false);
    assert.notEqual(privateSaved.receipt.ownerWorkspaceRef, "agent-a", "Experience owner must be separate from base Agent identity");
    assert.equal(privateSaved.bundle.pack.visibility, "private");
    assert.equal(privateSaved.bundle.pack.status, "draft");
    assert.equal(privateSaved.bundle.pack.mcpRequirements[0].requiresKey, true);
    assert.deepEqual(privateSaved.bundle.pack.mcpRequirements[0].credentialMetadata.env, ["BROWSER_API_KEY"]);
    assert.equal(JSON.stringify(privateSaved.bundle).includes(secretSentinel), false);
    assert.equal(privateSaved.bundle.items[0].instructions.join(""), safe.candidate.summary);
    assert.equal(privateSaved.bundle.bundleHash, portable.portableExperienceBundleHash(privateSaved.bundle));

    assert.throws(
      () => cloud.validateExperienceCloudReceipt({ ...privateSaved.receipt, uploadId: "exu_bad" }),
      /upload id is invalid/,
      "malformed server upload ids must fail closed",
    );
    assert.throws(
      () => cloud.validateExperienceCloudReceipt(privateSaved.receipt, { bundleHash: `sha256:${"f".repeat(64)}` }),
      /bundle hash mismatch/,
      "hash-mismatched receipts must fail closed",
    );
    assert.throws(
      () => cloud.validateExperienceCloudReceipt({ ...privateSaved.receipt, createdAt: "2026-07-12" }),
      /createdAt is invalid/,
      "date-only timestamps are not RFC3339 date-time receipts",
    );
    assert.throws(
      () => cloud.validateExperienceBaseResolution({
        schema: "agentlas.experience-base-resolution.v1",
        agentDefinitionId: `agd_${"c".repeat(48)}`,
        agentReleaseId: `agr_${"d".repeat(48)}`,
        packageHash: baseHash,
        packageHashVersion: "path-sha256-evil-v9",
        cloudId: "cloud:base-agent-a",
        slug: "Agent A/../../bad",
      }, { packageHash: baseHash }),
      /hash version is invalid|slug is invalid/,
      "base wire values need exact slug/hash-version contracts",
    );
    assert.equal(
      cloud.validateExperienceCloudReceipt({ ...privateSaved.receipt, futureServerField: { version: 2 } }).uploadId,
      privateSaved.receipt.uploadId,
      "unknown response fields should remain forward-compatible",
    );
    assert.throws(
      () => cloud.validateExperienceCloudReceipt(privateSaved.receipt, { experiencePackId: "pack_wrong_authority" }),
      /Pack id mismatch/,
      "a receipt for another Experience Pack must not become local authority",
    );
    assert.throws(
      () => cloud.validateExperienceCloudReceipt(privateSaved.receipt, { experienceReleaseId: "release_wrong_authority" }),
      /release id mismatch/,
      "a receipt for another Experience release must not become local authority",
    );
    assert.throws(
      () => cloud.validateExperienceCloudReceipt(
        { ...privateSaved.receipt, status: "public-active" },
        { allowedStatuses: new Set(["draft-saved", "withdrawn", "rejected", "conflict"]) },
      ),
      /lifecycle transition is not legal/,
      "private upload receipts must not be allowed to self-activate public rental",
    );

    const unsafeOwnerSecret = structuredClone(privateSaved.bundle);
    unsafeOwnerSecret.pack.ownerRef = "owner:sk-secret-owner-value-123456789";
    assert.throws(
      () => portable.validatePortableExperienceBundle(unsafeOwnerSecret),
      /non-portable raw material/,
      "typed owner references must not bypass secret scanning",
    );
    const unsafeOwnerEmail = structuredClone(privateSaved.bundle);
    unsafeOwnerEmail.pack.ownerRef = "owner:person@example.com";
    assert.throws(
      () => portable.validatePortableExperienceBundle(unsafeOwnerEmail),
      /non-portable raw material/,
      "typed owner references must not bypass personal identifier scanning",
    );

    for (const privateLocation of [
      "/opt/customer/private.txt",
      "path:/etc/passwd",
      "~/customer/private.txt",
      "../customer/private.txt",
      "C:\\customer\\private.txt",
      "\\\\fileserver\\customer\\private.txt",
    ]) {
      const unsafePathBundle = structuredClone(privateSaved.bundle);
      unsafePathBundle.items[0].instructions[0] = `Read ${privateLocation} before continuing.`;
      unsafePathBundle.pack.contentHash = portable.portableExperiencePackContentHash(unsafePathBundle);
      unsafePathBundle.bundleHash = portable.portableExperienceBundleHash(unsafePathBundle);
      unsafePathBundle.bundleId = portable.portableExperienceBundleId(unsafePathBundle);
      assert.throws(
        () => portable.validatePortableExperienceBundle(unsafePathBundle),
        /non-portable raw material/,
        `private location must be rejected before Cloud transport: ${privateLocation}`,
      );
    }

    const setupUrlBundle = structuredClone(privateSaved.bundle);
    setupUrlBundle.pack.mcpRequirements[0].credentialMetadata.setupUrl = "https://provider.example/connect";
    setupUrlBundle.pack.mcpRequirements[0].credentialMetadata.brokerMode = "manual-provider-page";
    setupUrlBundle.pack.contentHash = portable.portableExperiencePackContentHash(setupUrlBundle);
    setupUrlBundle.bundleHash = portable.portableExperienceBundleHash(setupUrlBundle);
    setupUrlBundle.bundleId = portable.portableExperienceBundleId(setupUrlBundle);
    assert.equal(
      portable.validatePortableExperienceBundle(setupUrlBundle).pack.mcpRequirements[0].credentialMetadata.setupUrl,
      "https://provider.example/connect",
      "a value-free HTTPS provider setup page should remain portable",
    );
    for (const badSetupUrl of [
      "https://user:pass@provider.example/connect",
      "https://provider.example:8443/connect",
      "https://provider.example/connect?token=abc",
      "https://provider.example/connect#secret",
    ]) {
      const invalidSetupUrlBundle = structuredClone(setupUrlBundle);
      invalidSetupUrlBundle.pack.mcpRequirements[0].credentialMetadata.setupUrl = badSetupUrl;
      invalidSetupUrlBundle.pack.contentHash = portable.portableExperiencePackContentHash(invalidSetupUrlBundle);
      invalidSetupUrlBundle.bundleHash = portable.portableExperienceBundleHash(invalidSetupUrlBundle);
      invalidSetupUrlBundle.bundleId = portable.portableExperienceBundleId(invalidSetupUrlBundle);
      assert.throws(
        () => portable.validatePortableExperienceBundle(invalidSetupUrlBundle),
        /setupUrl must be an HTTPS hostname\/path URL/,
        `unsafe provider setup URL must be rejected: ${badSetupUrl}`,
      );
    }
    const nonCanonicalTaskBundle = structuredClone(privateSaved.bundle);
    nonCanonicalTaskBundle.items[0].taskSignatures = ["general"];
    nonCanonicalTaskBundle.pack.contentHash = portable.portableExperiencePackContentHash(nonCanonicalTaskBundle);
    nonCanonicalTaskBundle.bundleHash = portable.portableExperienceBundleHash(nonCanonicalTaskBundle);
    nonCanonicalTaskBundle.bundleId = portable.portableExperienceBundleId(nonCanonicalTaskBundle);
    assert.throws(
      () => portable.validatePortableExperienceBundle(nonCanonicalTaskBundle),
      /non-canonical task signature/,
      "portable items must use the exact shared task taxonomy",
    );
    const nonCanonicalEnvironmentBundle = structuredClone(privateSaved.bundle);
    const osIndex = nonCanonicalEnvironmentBundle.items[0].environmentConstraints
      .findIndex((value) => value.startsWith("agentlas.env.v1/os/"));
    nonCanonicalEnvironmentBundle.items[0].environmentConstraints[osIndex] = "agentlas.env.v1/os/private-fork";
    nonCanonicalEnvironmentBundle.pack.contentHash = portable.portableExperiencePackContentHash(nonCanonicalEnvironmentBundle);
    nonCanonicalEnvironmentBundle.bundleHash = portable.portableExperienceBundleHash(nonCanonicalEnvironmentBundle);
    nonCanonicalEnvironmentBundle.bundleId = portable.portableExperienceBundleId(nonCanonicalEnvironmentBundle);
    assert.throws(
      () => portable.validatePortableExperienceBundle(nonCanonicalEnvironmentBundle),
      /non-canonical environment profile/,
      "portable items must use the exact shared environment taxonomy",
    );

    const webErrorClient = new cloud.ExperienceCloudHttpClient({
      baseUrl: "http://127.0.0.1:43123",
      cookieHeader: "agentlas_session=test-session-123",
      allowLoopback: true,
      fetch: async () => response({ error: "exact_base_missing" }, 409),
    });
    await assert.rejects(
      webErrorClient.resolveBase({ slug: "agent-a", packageHash: baseHash }),
      (error) => error instanceof cloud.ExperienceCloudHttpError && error.code === "exact_base_missing",
      "Web error payloads must retain their machine-readable error code",
    );

    const replayed = await cloud.saveExperienceToCloud({ packId: safe.pack.id, requestedVisibility: "private" }, deps);
    assert.equal(replayed.id, privateSaved.id);
    assert.equal(replayed.idempotencyKey, privateSaved.idempotencyKey);
    assert.equal(replayed.attemptCount, 2);
    assert.ok(
      requests
        .filter((entry) => entry.method === "POST" && entry.url.endsWith("/uploads"))
        .every((entry) => entry.headers.get("If-None-Match") === "*"),
      "all upload attempts, including same-key replays, must stay create-only safe",
    );

    const exported = await cloud.exportExperienceFromCloud(privateSaved.id, deps);
    assert.equal(exported.bundle.bundleHash, privateSaved.bundleHash);
    assert.equal(exported.receipt.uploadId, `exu_${"1".repeat(48)}`);
    assert.equal(exported.bundle.pack.ownerRef, exported.receipt.ownerWorkspaceRef);
    assert.notEqual(exported.bundle.pack.ownerRef, privateSaved.bundle.pack.ownerRef, "server export must bind authenticated owner without changing the hash");

    const resolvedPack = experience.listExperiencePacks({ agentId: "agent-a" })
      .find((item) => item.id === safe.pack.id);
    const generalized = operationalGeneralization.saveOperationalPublicProjection({
      packId: safe.pack.id,
      sourceCandidateIds: [safe.candidate.id],
      title: "게시 완료 상태를 안전하게 확인",
      instructions: ["게시 작업 뒤 렌더링된 목적지를 확인합니다.", "예상 상태가 없으면 한 번 새로 고친 뒤 마지막 동작만 반복합니다."],
      taskSignatures: [safe.candidate.taskSignatures[0]],
      environmentConstraints: resolvedPack.environmentProfile.constraints,
    });
    operationalGeneralization.confirmOperationalPublicProjection({
      projectionId: generalized.projectionId,
      proposalHash: generalized.proposalHash,
      explicitConsent: true,
    });

    const publicRequested = await cloud.saveExperienceToCloud({ packId: safe.pack.id, requestedVisibility: "public" }, deps);
    assert.notEqual(publicRequested.id, privateSaved.id, "a generalized public projection must never overwrite the raw private draft lifecycle");
    assert.ok(publicRequested.bundle.items.every((item) => item.privacyScope === "public-safe"));
    assert.equal(JSON.stringify(publicRequested.bundle).includes(safe.candidate.summary), false);
    assert.equal(publicRequested.state, "verification-requested");
    assert.equal(publicRequested.receipt.status, "verification-requested");
    assert.notEqual(publicRequested.state, "public-active", "client request must not self-activate public rental");
    assert.notEqual(publicRequested.idempotencyKey, privateSaved.idempotencyKey, "private save and public request need separate idempotency scopes");
    assert.equal(publicPostLost, true, "lost response path was not exercised");

    // Server advances independently. A stale withdraw must preserve local data,
    // surface conflict, and accept the current authoritative receipt only.
    const pending = { ...publicReceipt, status: "verification-pending", revision: `rev_${"3".repeat(32)}`, updatedAt: "2026-07-12T12:03:00.000Z" };
    receiptById.set(`exu_${"2".repeat(48)}`, pending);
    const conflicted = await cloud.withdrawExperienceFromCloud({ localUploadId: publicRequested.id }, deps);
    assert.equal(conflicted.state, "conflict");
    assert.equal(conflicted.remoteRevision, `rev_${"3".repeat(32)}`);
    assert.equal(conflicted.receipt.status, "verification-pending");
    assert.equal(experience.listExperienceCandidates(safe.pack.id).length, 1, "stale Cloud CAS must not delete local Experience");

    const reconciled = await cloud.reconcileExperienceCloudUpload(publicRequested.id, deps);
    assert.equal(reconciled.state, "verification-pending");
    const withdrawn = await cloud.withdrawExperienceFromCloud({ localUploadId: publicRequested.id }, deps);
    assert.equal(withdrawn.state, "withdrawn");
    assert.equal(experience.listExperiencePromotionReceipts(safe.pack.id).length, 1, "withdrawal must preserve local receipts");

    offline = true;
    const offlineRecord = await cloud.reconcileExperienceCloudUpload(publicRequested.id, deps);
    assert.equal(offlineRecord.state, "offline");
    assert.equal(offlineRecord.receipt.uploadId, `exu_${"2".repeat(48)}`, "offline failure must retain last valid receipt");
    offline = false;
    assert.equal((await cloud.reconcileExperienceCloudUpload(publicRequested.id, deps)).state, "withdrawn");

    const oversized = await cloud.reconcileExperienceCloudUpload(publicRequested.id, {
      ...deps,
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(5 * 1024 * 1024) },
      }),
    });
    assert.equal(oversized.state, "error", "oversized server data is a contract/security error, not offline");
    assert.equal(oversized.errorCode, "invalid_server_response");
    assert.equal((await cloud.reconcileExperienceCloudUpload(publicRequested.id, deps)).state, "withdrawn");

    // The first POST can fail before it reaches the server. The next same-key
    // attempt must still carry the create-only precondition and be accepted.
    const neverReached = createPromotedPack(
      "First POST never reached server",
      "브라우저 게시 전에 승인된 제목과 본문을 확인하고 결과 화면을 다시 검증합니다.",
    );
    let neverReachedPostCount = 0;
    let neverReachedGetCount = 0;
    const neverReachedHeaders = [];
    const neverReachedFetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method || "GET";
      if (url.pathname.endsWith("/base-releases/resolve") && method === "POST") {
        return response({
          schema: "agentlas.experience-base-resolution.v1",
          agentDefinitionId: `agd_${"e".repeat(48)}`,
          agentReleaseId: `agr_${"f".repeat(48)}`,
          packageHash: baseHash,
          packageHashVersion: "path-sha256-executable-v2",
          cloudId: "cloud:base-agent-a",
          slug: "agent-a",
        });
      }
      if (url.pathname.endsWith("/uploads") && method === "GET") {
        neverReachedGetCount += 1;
        return response({ error: "not_found" }, 404);
      }
      if (url.pathname.endsWith("/uploads") && method === "POST") {
        neverReachedPostCount += 1;
        neverReachedHeaders.push(requestHeader(init, "If-None-Match"));
        if (neverReachedPostCount === 1) throw new TypeError("socket failed before request write");
        const bundle = JSON.parse(init.body).bundle;
        const receipt = makeReceipt(bundle, "draft-saved", `exu_${"5".repeat(48)}`, `rev_${"5".repeat(32)}`);
        return response(receipt, 200, receipt.revision);
      }
      return response({ error: "not_found" }, 404);
    };
    const neverReachedDeps = { ...deps, fetch: neverReachedFetch };
    const firstNeverReached = await cloud.saveExperienceToCloud(
      { packId: neverReached.pack.id, requestedVisibility: "private" },
      neverReachedDeps,
    );
    assert.equal(firstNeverReached.state, "offline");
    assert.equal(firstNeverReached.attemptCount, 1);
    const recoveredNeverReached = await cloud.saveExperienceToCloud(
      { packId: neverReached.pack.id, requestedVisibility: "private" },
      neverReachedDeps,
    );
    assert.equal(recoveredNeverReached.state, "private-saved");
    assert.equal(recoveredNeverReached.attemptCount, 2);
    assert.ok(neverReachedGetCount >= 2, "both lost-response recovery checks should observe server absence");
    assert.deepEqual(neverReachedHeaders, ["*", "*"], "retry after a never-received POST must stay If-None-Match: *");

    const raw = createPromotedPack(
      "Unsafe raw material",
      "Review the visible result once before publishing.",
    );
    db.prepare("UPDATE experience_candidates SET summary = ? WHERE id = ?")
      .run("Copy the result from /Users/mason/private-project before publishing.", raw.candidate.id);
    db.prepare(`
      UPDATE experience_packs
      SET base_agent_definition_id = ?, base_agent_release_id = ?, base_package_hash_version = ?
      WHERE id = ?
    `).run(`agd_${"c".repeat(48)}`, `agr_${"d".repeat(48)}`, "path-sha256-executable-v2", raw.pack.id);
    assert.throws(
      () => portable.materializePortableExperienceBundle(raw.pack.id, "private"),
      /local, personal, secret, prompt, transcript, or opaque raw material/,
      "private Cloud save must reject raw local material too",
    );

    const uploadRows = db.prepare("SELECT canonical_bundle_json FROM experience_cloud_uploads").all();
    for (const row of uploadRows) {
      assert.equal(row.canonical_bundle_json.includes(temp), false);
      assert.equal(row.canonical_bundle_json.includes(safe.entry.id), false);
      assert.equal(row.canonical_bundle_json.includes("sourceMemoryId"), false);
    }

    assert.ok(requests.some((entry) => entry.method === "GET" && entry.url.includes("?bundleId=")), "lost response recovery query missing");
    assert.ok(requests.some((entry) => entry.method === "DELETE"), "CAS withdrawal request missing");
    console.log(`portable Experience Cloud exchange: ${requests.length} mocked requests PASS`);
  } finally {
    delete process.env.BROWSER_API_KEY;
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
