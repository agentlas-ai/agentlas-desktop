"use strict";
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function allowedRef(ref, version) {
  return typeof version === "string" && SEMVER.test(version) && (ref === `v${version}` || ref === `os-v${version}`);
}
function allowedAsset(ref, version, asset) {
  return allowedRef(ref, version) && asset === (ref === `v${version}` ? `hephaestus-runtime-v${version}.tar.gz` : `agentlas-os-runtime-v${version}.tar.gz`);
}
function validPin(source, version) {
  return !!source && allowedAsset(source.ref, version, source.assetName) && /^[0-9a-f]{40}$/.test(source.commit || "") && /^[0-9a-f]{64}$/.test(source.assetSha256 || "");
}
module.exports = { allowedRef, allowedAsset, validPin };
