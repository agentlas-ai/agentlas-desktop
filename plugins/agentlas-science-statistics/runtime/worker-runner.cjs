"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { LIMITS, StatisticsError } = require("./engine.cjs");

function requestedTimeout(request) {
  const value = request && request.options && request.options.timeoutMs;
  return Number.isSafeInteger(value) && value >= 1 && value <= LIMITS.maxTimeoutMs
    ? value
    : LIMITS.defaultTimeoutMs;
}

function executeInWorker(request) {
  const timeoutMs = requestedTimeout(request);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "analysis-worker.cjs"), {
      workerData: { request },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().finally(() => {
        finish(reject, new StatisticsError("STAT_TIMEOUT", `analysis exceeded hard timeout of ${timeoutMs} ms`));
      });
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message) => {
      if (message && message.ok) finish(resolve, message.result);
      else finish(reject, new StatisticsError(message?.error?.code || "STAT_INTERNAL", message?.error?.message || "analysis worker failed", message?.error?.details));
      worker.terminate().catch(() => {});
    });
    worker.once("error", (error) => finish(reject, new StatisticsError("STAT_WORKER_FAILURE", "analysis worker crashed", { reason: error.message })));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(reject, new StatisticsError("STAT_WORKER_FAILURE", `analysis worker exited with code ${code}`));
    });
  });
}

module.exports = { executeInWorker };
