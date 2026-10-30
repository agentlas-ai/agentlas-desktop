"use strict";

// Bounded, polite HTTP for public scientific APIs: host allowlist, one request at a time per host with a minimum
// interval, retry only on transient statuses (Retry-After honoured up to a cap), a total deadline per tool call,
// byte-bounded reads, and a receipt per attempt. Headers carry only the plugin User-Agent and Accept — never an owner
// identity, e-mail, token or cookie.

const crypto = require("node:crypto");

class PluginHttpError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createPoliteHttp(policy) {
  const hosts = new Map(Object.entries(policy.hosts));
  const lastStart = new Map();
  const chains = new Map();

  async function slot(host) {
    const minimum = hosts.get(host).minimumRequestIntervalMs;
    const prior = chains.get(host) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    chains.set(host, prior.then(() => mine));
    await prior;
    const wait = Math.max(0, (lastStart.get(host) || 0) + minimum - Date.now());
    if (wait) await pause(wait);
    lastStart.set(host, Date.now());
    return release;
  }

  function checkedUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new PluginHttpError("http-url-invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.has(url.hostname)) {
      throw new PluginHttpError("http-endpoint-denied", `Endpoint not allowed: ${url.hostname}`);
    }
    return url;
  }

  async function readBounded(response, maximum) {
    const declared = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > maximum) throw new PluginHttpError("http-response-too-large", null, { maximum, declared });
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => {});
        throw new PluginHttpError("http-response-too-large", null, { maximum });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  /**
   * One logical request with bounded retries. `deadlineAt` is the tool call's absolute deadline (epoch ms).
   */
  async function request({ url: rawUrl, method = "GET", json, accept, maxBytes, deadlineAt }) {
    const url = checkedUrl(rawUrl);
    const host = hosts.get(url.hostname);
    const attempts = [];
    const maxAttempts = policy.maximumAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadlineAt - Date.now();
      if (remaining < 500) throw new PluginHttpError("http-deadline-exceeded", null, { attempts });
      const release = await slot(url.hostname);
      const started = Date.now();
      const record = { attempt, url: url.toString(), method, status: null, contentType: null, byteLength: 0, rawSha256: null, retryAfterMs: null, errorCode: null, elapsedMs: 0 };
      attempts.push(record);
      let response;
      let released = false;
      const releaseOnce = () => { if (!released) { released = true; release(); } };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(host.timeoutMs || policy.requestTimeoutMs, Math.max(1, deadlineAt - Date.now())));
        try {
          response = await fetch(url, {
            method,
            redirect: "follow",
            signal: controller.signal,
            headers: {
              accept: accept.join(", "),
              "user-agent": policy.userAgent,
              ...(json === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          });
          const finalHost = new URL(response.url || url.toString()).hostname;
          if (!hosts.has(finalHost)) throw new PluginHttpError("http-redirect-denied", `Redirect left the allowlist: ${finalHost}`);
          record.status = response.status;
          record.contentType = response.headers.get("content-type");
          const retryable = policy.retryableStatuses.includes(response.status);
          if (retryable) {
            const header = Number(response.headers.get("retry-after"));
            const backoff = Number.isFinite(header) && header >= 0 ? header * 1000 : 400 * 2 ** (attempt - 1);
            record.retryAfterMs = Math.min(policy.maximumRetryAfterMs, Math.round(backoff));
            await response.body?.cancel().catch(() => {});
            record.errorCode = `http-status-${response.status}`;
          } else {
            const bytes = await readBounded(response, maxBytes);
            record.byteLength = bytes.length;
            record.rawSha256 = sha256(bytes);
            if (response.status === 404) throw new PluginHttpError("http-not-found", `Not found: ${url.pathname}`, { attempts });
            if (response.status < 200 || response.status >= 300) {
              throw new PluginHttpError(`http-status-${response.status}`, bytes.toString("utf8").slice(0, 300), { attempts });
            }
            const mime = String(record.contentType || "").split(";")[0].trim().toLowerCase();
            if (bytes.length > 0 && accept.length && !accept.some((wanted) => wanted === "*/*" || wanted === mime)) {
              throw new PluginHttpError("http-mime-unexpected", `Unexpected content type ${mime}`, { attempts });
            }
            return { status: response.status, contentType: record.contentType, bytes, sha256: record.rawSha256, attempts };
          }
        } finally {
          clearTimeout(timer);
          record.elapsedMs = Date.now() - started;
          releaseOnce();
        }
      } catch (error) {
        if (error instanceof PluginHttpError) throw error;
        record.errorCode = error && error.name === "AbortError" ? "http-timeout" : "http-network-error";
        record.retryAfterMs = Math.min(policy.maximumRetryAfterMs, 400 * 2 ** (attempt - 1));
      }
      releaseOnce();
      if (attempt < maxAttempts && Date.now() + record.retryAfterMs < deadlineAt - 500) await pause(record.retryAfterMs);
      else break;
    }
    throw new PluginHttpError("http-retries-exhausted", null, { attempts });
  }

  async function getJson(url, options) {
    const result = await request({ url, accept: ["application/json"], maxBytes: options.maxBytes, deadlineAt: options.deadlineAt });
    try { return { ...result, value: JSON.parse(result.bytes.toString("utf8")) }; }
    catch { throw new PluginHttpError("http-json-invalid", null, { attempts: result.attempts }); }
  }

  async function postJson(url, body, options) {
    const result = await request({ url, method: "POST", json: body, accept: ["application/json"], maxBytes: options.maxBytes, deadlineAt: options.deadlineAt });
    if (result.status === 204 || result.bytes.length === 0) return { ...result, value: null };
    try { return { ...result, value: JSON.parse(result.bytes.toString("utf8")) }; }
    catch { throw new PluginHttpError("http-json-invalid", null, { attempts: result.attempts }); }
  }

  return { request, getJson, postJson };
}

module.exports = { createPoliteHttp, PluginHttpError, sha256 };
