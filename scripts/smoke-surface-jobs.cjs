#!/usr/bin/env node
const assert = require("node:assert/strict");
const { summarizeSurfaceJobRecords } = require("../dist/electron/store/agent-surface-jobs.js");

const jobs = [
  {
    id: "surface-1:generate-hero",
    chatId: "chat-1",
    projectId: null,
    agentId: "creative-agent",
    surfaceId: "surface-1",
    jobId: "generate-hero",
    label: "Generate hero image",
    status: "queued",
    costEstimate: 1.25,
    costSpent: null,
    currency: "usd",
    resumable: true,
    manifestJob: {
      id: "generate-hero",
      label: "Generate hero image",
      status: "queued",
      costEstimate: 1.25,
      currency: "USD",
      resumable: true,
    },
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
  },
  {
    id: "surface-1:render-variants",
    chatId: "chat-1",
    projectId: null,
    agentId: "creative-agent",
    surfaceId: "surface-1",
    jobId: "render-variants",
    label: "Render variants",
    status: "running",
    costEstimate: 0.5,
    costSpent: 0.25,
    currency: "USD",
    resumable: true,
    manifestJob: {
      id: "render-variants",
      label: "Render variants",
      status: "running",
      costEstimate: 0.5,
      costSpent: 0.25,
      currency: "USD",
      resumable: true,
    },
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
  },
];

const summary = summarizeSurfaceJobRecords(jobs, {
  currency: "USD",
  limit: 3,
  approvalThreshold: 1,
});

assert.equal(summary.currency, "USD");
assert.equal(summary.jobCount, 2);
assert.equal(summary.queuedCount, 1);
assert.equal(summary.runningCount, 1);
assert.equal(summary.resumableCount, 2);
assert.equal(summary.costEstimate, 1.75);
assert.equal(summary.costSpent, 0.25);
assert.equal(summary.budgetLimit, 3);
assert.equal(summary.needsApproval, true);
assert.equal(summary.overLimit, false);

const overLimit = summarizeSurfaceJobRecords(jobs, { currency: "USD", limit: 1 });
assert.equal(overLimit.overLimit, true);

console.log("surface-jobs smoke passed");
