#!/usr/bin/env node
"use strict";

// Tiny Electron store seeder used only by the production-route QA harness.
// Store modules intentionally stay Main-only; Playwright's Electron evaluate
// context does not expose Node require, so seeding happens before the tested
// app window is opened.
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..");
const input = JSON.parse(process.env.AGENTLAS_QA_SEED_JSON || "{}");
const userData = path.resolve(String(input.userData || ""));
if (!userData) throw new Error("QA seed userData is required");
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);

app.whenReady().then(() => {
  const store = require(path.join(root, "dist/electron/store/db.js"));
  store.initStore({});
  const chats = require(path.join(root, "dist/electron/store/chats.js"));
  const surfaces = require(path.join(root, "dist/electron/store/agent-surfaces.js"));
  const tasks = require(path.join(root, "dist/electron/store/tasks.js"));
  const runEvents = require(path.join(root, "dist/electron/store/run-events.js"));
  const oneSurfaceResults = require(path.join(root, "dist/electron/store/one-surface-results.js"));
  const oneDomainEvents = require(path.join(root, "dist/electron/one/domain-events.js"));
  const artifactPreview = require(path.join(root, "dist/electron/one/artifact-preview.js"));
  const chat = input.chatId ? chats.getChat(input.chatId) : chats.createChat(input.chat || {});
  if (!chat) throw new Error(`QA seed chat not found: ${input.chatId}`);
  for (const row of input.messages || []) chats.appendChatMessage(chat.id, row.role, row.text);
  let task = null;
  if (input.ensureTask || input.oneSurface) {
    task = tasks.ensureCanonicalTaskForChat(chat.id);
    if (!task) throw new Error(`QA seed task could not be created for chat: ${chat.id}`);
  }
  let surface = null;
  if (input.surface) {
    surface = surfaces.recordAgentSurface({
      id: input.surface.id,
      chatId: chat.id,
      agentId: chat.agentId,
      manifest: input.surface.manifest,
    });
  }
  let oneRunId = null;
  let artifactCount = 0;
  if (input.oneSurface) {
    oneRunId = String(input.oneSurface.runId || `qa-one-run-${Date.now()}`);
    const manifest = { ...input.oneSurface.manifest, taskId: task.id };
    const artifactPaths = Array.isArray(input.oneSurface.artifactPaths) ? input.oneSurface.artifactPaths : [];
    const boundRuntimeArtifacts = artifactPreview.bindOneRuntimeToolArtifacts({
      taskId: task.id,
      taskVersion: task.version,
      chatId: chat.id,
      runId: oneRunId,
      toolId: "qa-artifact-open",
      paths: artifactPaths,
    }).map((artifact) => ({
      taskId: task.id,
      taskVersion: task.version,
      chatId: chat.id,
      runId: oneRunId,
      manifestId: artifact.manifestId,
      artifactRef: artifact.artifactRef,
      label: artifact.label,
      type: artifact.type,
      sizeBytes: artifact.sizeBytes,
    }));
    artifactCount = boundRuntimeArtifacts.length;
    runEvents.recordRunEvent({
      runId: oneRunId,
      kind: "invoke_started",
      chatId: chat.id,
      agentId: chat.agentId,
      payload: { chatId: chat.id, taskId: task.id, permissions: "full", prompt: "실시간 지도 결과를 보여줘." },
    });
    oneDomainEvents.recordOneDomainEvent({
      eventId: `qa-domain-start-${oneRunId}`,
      eventType: "run.started",
      actor: "one",
      entityId: oneRunId,
      taskId: task.id,
      version: 1,
      visibility: "personal",
      entries: [
        { name: "runId", value: oneRunId },
        { name: "policyVersion", value: "qa-live-renderer-1" },
      ],
    });
    if (boundRuntimeArtifacts.length > 0) {
      runEvents.recordRunEvent({
        runId: oneRunId,
        kind: "mcp_tool-use",
        chatId: chat.id,
        agentId: chat.agentId,
        payload: {
          toolName: "write_file",
          toolId: "qa-artifact-open",
          toolResultPreview: "created",
          oneArtifacts: boundRuntimeArtifacts,
        },
      });
    }
    oneSurfaceResults.recordDurableOneSurfaceResult({ runId: oneRunId, chatId: chat.id, manifest });
    runEvents.recordRunEvent({
      runId: oneRunId,
      kind: "invoke_completed",
      chatId: chat.id,
      agentId: chat.agentId,
      payload: { taskId: task.id, resultSummary: manifest.summary, oneArtifacts: boundRuntimeArtifacts },
    });
    task = tasks.setCanonicalTaskStatus(
      task.id,
      input.oneSurface.taskStatus === "partial" ? "partial" : "completed",
    );
  }
  process.stdout.write(`${JSON.stringify({ chat, surface, task, runId: oneRunId, artifactCount })}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
