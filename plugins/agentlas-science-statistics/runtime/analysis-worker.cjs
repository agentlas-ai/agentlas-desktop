"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { analyze, publicError } = require("./engine.cjs");

if (!parentPort) throw new Error("analysis-worker must run inside a Worker");

try {
  parentPort.postMessage({ ok: true, result: analyze(workerData.request) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: publicError(error) });
}
