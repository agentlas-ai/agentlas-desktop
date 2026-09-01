#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { ENGINE, LIMITS, publicError } = require("../runtime/engine.cjs");
const { REQUEST_INPUT_SCHEMA } = require("../runtime/contracts.cjs");
const { executeInWorker } = require("../runtime/worker-runner.cjs");

const TOOL_NAME = "run_statistical_analysis";
let pending = Promise.resolve();
let queued = 0;
const MAX_QUEUED_REQUESTS = 8;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function errorResponse(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function toolsList() {
  return {
    tools: [{
      name: TOOL_NAME,
      title: "Run Statistical Analysis",
      description: "Run a bounded, deterministic local statistical analysis and return publication-table and Vega-Lite artifacts with content-hash receipts.",
      inputSchema: REQUEST_INPUT_SCHEMA,
    }],
  };
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    errorResponse(message?.id ?? null, -32600, "Invalid Request");
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "initialize") {
    response(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agentlas-science-statistics", version: ENGINE.version } });
    return;
  }
  if (message.method === "ping") {
    response(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    response(message.id, toolsList());
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== TOOL_NAME) {
      errorResponse(message.id, -32602, `Unknown tool: ${String(message.params?.name)}`);
      return;
    }
    try {
      const result = await executeInWorker(message.params?.arguments);
      response(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      const safe = publicError(error);
      response(message.id, { content: [{ type: "text", text: JSON.stringify({ error: safe }) }], structuredContent: { error: safe }, isError: true });
    }
    return;
  }
  errorResponse(message.id, -32601, `Method not found: ${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > LIMITS.maxRequestBytes) {
    errorResponse(null, -32600, `request exceeds ${LIMITS.maxRequestBytes} bytes`);
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    errorResponse(null, -32700, "Parse error");
    return;
  }
  if (queued >= MAX_QUEUED_REQUESTS) {
    errorResponse(message?.id ?? null, -32000, "statistics server queue is full");
    return;
  }
  queued += 1;
  pending = pending
    .then(() => handle(message))
    .catch(() => { errorResponse(message?.id ?? null, -32603, "Internal error"); })
    .finally(() => { queued -= 1; });
});
