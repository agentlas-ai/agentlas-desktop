/*
 * Moving a locked bundle between a file and the network without holding it in memory twice (Agentlas 2.0 / bundles up to 100 MiB).
 * Plain module (node:fs / node:crypto / node:stream only): home.ts uses it for `move/bundle-put` / `move/bundle-get` and a gate measures the same code.
 *  - upload: the body is the file read in 1 MiB pieces (nothing but the piece is in memory); the progress callback gets (sent, total).
 *  - download: the response is written to a file piece by piece while the sha-256 is counted; the bytes are never a whole `ArrayBuffer`; a body longer than the declared / allowed size stops at the first byte over.
 * The time a request may take grows with the size (`requestTimeoutMs`): 100 MiB over a slow line takes minutes; a fixed 60 seconds would kill it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const MIB = 1024 * 1024;
/** 60 s plus 3 s per MiB (100 MiB: 6 minutes). */
export const requestTimeoutMs = (bytes: number): number => 60_000 + Math.ceil(Math.max(0, bytes) / MIB) * 3_000;

/** The request body for a file: an async stream of 1 MiB pieces that reports progress. Pass it to `fetch` with `duplex: "half"`. */
export function fileBody(file: string, onProgress?: (sent: number, total: number) => void): { body: Readable; size: number } {
  const size = fs.statSync(file).size;
  let sent = 0;
  async function* pieces(): AsyncGenerator<Buffer> {
    for await (const chunk of fs.createReadStream(file, { highWaterMark: MIB })) { sent += (chunk as Buffer).length; onProgress?.(sent, size); yield chunk as Buffer; }
  }
  return { body: Readable.from(pieces(), { objectMode: false }), size };
}

/**
 * Removes a half-written file, best effort (desktop repair 6, Windows W2): another program (a virus scanner, an indexer) may hold it open without delete sharing, and `fs.rmSync` then throws EBUSY / EPERM -
 * out of an event handler, where nothing catches it (the call never settled, or ended as a parse error). Four tries 40 ms apart; false when it is still there. The file sits in an owned staging folder, which
 * `discardStaged` and `reclaimStaleDirs` remove as a whole later, so a file that stays is cleaned by the existing road, never left for good. Never throws.
 */
export function removePartial(file: string): boolean {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { fs.rmSync(file, { force: true }); return true; } catch { /* held: wait a little */ }
    if (attempt < 3) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { /* no wait available */ } }
  }
  return false;
}

export type StreamedBody = { ok: true; bytes: number; sha256: string } | { ok: false; code: "bundle_too_large" | "bundle_short" | "write_failed" };
/** Writes a response body to `dest` (mode 0600), counting its sha-256. `declared` = the content-length the server announced (or null). Removes the file on any failure. */
export async function bodyToFile(body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null | undefined, dest: string, maxBytes: number, declared: number | null, onProgress?: (got: number, total: number | null) => void): Promise<StreamedBody> {
  if (!body) return { ok: false, code: "bundle_short" };
  const hash = crypto.createHash("sha256"); let got = 0;
  const reader = body.getReader(); let fd: number | null = null;
  try {
    fd = fs.openSync(dest, "w", 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      got += value.length;
      if (got > maxBytes || (declared !== null && got > declared)) { await reader.cancel().catch(() => undefined); fs.closeSync(fd); fd = null; removePartial(dest); return { ok: false, code: "bundle_too_large" }; }
      hash.update(value); fs.writeSync(fd, value); onProgress?.(got, declared);
    }
    fs.closeSync(fd); fd = null;
    if (declared !== null && got !== declared) { removePartial(dest); return { ok: false, code: "bundle_short" }; }
    return { ok: true, bytes: got, sha256: hash.digest("hex") };
  } catch {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ }
    removePartial(dest);
    return { ok: false, code: "write_failed" };
  }
}

/** The sha-256 and size of a file, read in 1 MiB pieces (never the whole file in memory); null when it cannot be read. */
export function fileSha(file: string): { sha256: string; size: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r"); const hash = crypto.createHash("sha256"); const buf = Buffer.allocUnsafe(MIB); let size = 0;
    for (;;) { const n = fs.readSync(fd, buf, 0, MIB, null); if (n <= 0) break; hash.update(buf.subarray(0, n)); size += n; }
    return { sha256: hash.digest("hex"), size };
  } catch { return null; } finally { try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ } }
}

/**
 * A request that really streams. `fetch` (undici) reads a stream body eagerly into its own queue and a response body faster than the consumer takes it: measured on 100 MiB, +180 MiB for an upload and +115 MiB for a
 * download above the bytes themselves. `node:http(s)` with `pipe` applies back-pressure: the file is read as the socket takes it, and a response is written to disk as it arrives. No redirect is followed (as the product's `fetch` call: `redirect: "error"`).
 */
function requestOf(url: string): typeof http.request {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad_scheme");
  return (u.protocol === "https:" ? https.request : http.request) as typeof http.request;
}
/** POST a file as the body; the answer (small JSON) is returned whole. `onProgress(sent, total)` counts the bytes the socket took. Rejects on a connection error or the time limit. */
export function httpPostFile(url: string, opts: { headers: Record<string, string>; file: string; timeoutMs: number; onProgress?: (sent: number, total: number) => void }): Promise<{ status: number; json(): unknown }> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(opts.file).size; let sent = 0; let done = false;
    const fail = (e: unknown): void => { if (!done) { done = true; reject(e); } };
    const req = requestOf(url)(url, { method: "POST", headers: { ...opts.headers, "content-length": String(size) }, timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = []; let total = 0;
      res.on("data", (c: Buffer) => { total += c.length; if (total <= 1 << 20) chunks.push(c); });
      res.on("end", () => { if (done) return; done = true; const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode ?? 0, json: () => { try { return JSON.parse(text) as unknown; } catch { return null; } } }); });
      res.on("error", fail);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", fail);
    const input = fs.createReadStream(opts.file, { highWaterMark: MIB });
    input.on("data", (c) => { sent += (c as Buffer).length; opts.onProgress?.(sent, size); });
    input.on("error", fail);
    input.pipe(req);
  });
}
/** POST a small JSON body; a 200 `application/octet-stream` answer is streamed to `dest` (size and sha-256 counted), anything else is read as a small JSON answer. */
export function httpPostJsonToFile(url: string, opts: { headers: Record<string, string>; json: string; dest: string; maxBytes: number; timeoutMs: number; onProgress?: (got: number, total: number | null) => void }): Promise<{ status: number; streamed: StreamedBody | null; json(): unknown }> {
  return new Promise((resolve, reject) => {
    let done = false; const fail = (e: unknown): void => { if (!done) { done = true; reject(e); } };
    const req = requestOf(url)(url, { method: "POST", headers: { ...opts.headers, "content-length": String(Buffer.byteLength(opts.json)) }, timeout: opts.timeoutMs }, (res) => {
      const type = String(res.headers["content-type"] ?? ""); const declaredRaw = Number(res.headers["content-length"] ?? NaN); const declared = Number.isFinite(declaredRaw) ? declaredRaw : null;
      if (res.statusCode === 200 && type.startsWith("application/octet-stream")) {
        if (declared !== null && declared > opts.maxBytes) { res.destroy(); done = true; resolve({ status: 200, streamed: { ok: false, code: "bundle_too_large" }, json: () => null }); return; }
        const hash = crypto.createHash("sha256"); let got = 0; let fd: number | null = null; let broke = false;
        // The call is settled FIRST and the half-written file removed after, never the other way round: a removal that fails must not keep the call from ending with its machine code (W2).
        const abort = (code: "bundle_too_large" | "write_failed"): void => { if (broke) return; broke = true; if (!done) { done = true; resolve({ status: 200, streamed: { ok: false, code }, json: () => null }); } try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ } fd = null; removePartial(opts.dest); try { res.destroy(); } catch { /* gone */ } };
        try { fd = fs.openSync(opts.dest, "w", 0o600); } catch { abort("write_failed"); return; }
        res.on("data", (c: Buffer) => {
          if (broke) return; got += c.length;
          if (got > opts.maxBytes || (declared !== null && got > declared)) { abort("bundle_too_large"); return; }
          try { hash.update(c); fs.writeSync(fd as number, c); } catch { abort("write_failed"); return; }
          opts.onProgress?.(got, declared);
        });
        res.on("end", () => {
          if (broke || done) return; done = true;
          try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ }
          if (declared !== null && got !== declared) { resolve({ status: 200, streamed: { ok: false, code: "bundle_short" }, json: () => null }); removePartial(opts.dest); return; }
          resolve({ status: 200, streamed: { ok: true, bytes: got, sha256: hash.digest("hex") }, json: () => null });
        });
        res.on("error", () => abort("write_failed"));
        // A socket the server cut raises no timeout and, on some systems, no error: its close without an end is the same failure (the call ends, it does not wait).
        res.on("close", () => { if (!broke && !done && !res.complete) abort("write_failed"); });
        return;
      }
      const chunks: Buffer[] = []; let total = 0;
      res.on("data", (c: Buffer) => { total += c.length; if (total <= 1 << 20) chunks.push(c); });
      res.on("end", () => { if (done) return; done = true; const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode ?? 0, streamed: null, json: () => { try { return JSON.parse(text) as unknown; } catch { return null; } } }); });
      res.on("error", fail);
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", fail);
    req.end(opts.json);
  });
}
