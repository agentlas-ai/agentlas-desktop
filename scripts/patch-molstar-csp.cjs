#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const UPSTREAM_VERSION = "5.11.0";
const UPSTREAM_SHA256 = "7fad5561c74bc900930fb57d6ab028d1aafdda82223a901bf932b1098e84f1f3";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function replaceRegion(source, startNeedle, endNeedle, replacement) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`molstar-csp-patch-start-missing:${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end < 0) throw new Error(`molstar-csp-patch-end-missing:${endNeedle}`);
  if (source.indexOf(startNeedle, start + startNeedle.length) >= 0) {
    throw new Error(`molstar-csp-patch-start-ambiguous:${startNeedle}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function patchMolstar(source) {
  let output = source;
  output = replaceRegion(output, "function _e(P,V){", "function zt(P)", "function _e(P,V){return V}");
  output = replaceRegion(
    output,
    "function wy(P,V){",
    "var yse=",
    "function wy(P,V){P=Me(P);var Z=s[\"dynCall_\"+P];if(typeof Z!=\"function\")Pr(\"unknown function pointer with signature \"+P+\": \"+V);return function(){return Z.apply(null,[V].concat(Array.prototype.slice.call(arguments)))}}",
  );
  const stringCallback = 'typeof d!="function"&&(d=new Function(""+d));';
  if (!output.includes(stringCallback)) throw new Error("molstar-csp-string-callback-patch-missing");
  output = output.replace(stringCallback, 'if(typeof d!="function")throw new TypeError("callback must be a function");');
  output = replaceRegion(
    output,
    "function Sue(e,t){",
    "function Ru(e)",
    'function Sue(e,t){return e.replace(/\\$\\{([A-Za-z_$][A-Za-z0-9_$]*)\\}/g,function(r,n){return Object.prototype.hasOwnProperty.call(t,n)?String(t[n]):r})}',
  );
  if (output.includes("new Function")) throw new Error("molstar-csp-dynamic-function-remains");
  return output;
}

function main() {
  const input = path.resolve(process.argv[2] || require.resolve("molstar/build/viewer/molstar.js"));
  const output = path.resolve(process.argv[3] || path.join(process.cwd(), "molstar.csp.js"));
  const source = fs.readFileSync(input, "utf8");
  const inputSha256 = sha256(source);
  if (inputSha256 !== UPSTREAM_SHA256) throw new Error(`molstar-upstream-digest-mismatch:${inputSha256}`);
  const patched = patchMolstar(source);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, patched, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    version: UPSTREAM_VERSION,
    input,
    output,
    inputSha256,
    outputSha256: sha256(patched),
    dynamicFunctionCount: 0,
  })}\n`);
}

main();
