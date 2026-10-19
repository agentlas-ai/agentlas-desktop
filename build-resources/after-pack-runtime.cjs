"use strict";

const cleanup = require("./after-pack-clean.cjs");
const { prepareLinuxRuntimePermissions } = require("./linux-runtime-permissions.cjs");

exports.default = async function afterPackRuntime(context) {
  // Preserve every original archive, runtime, source-map and platform gate.
  await cleanup.default(context);
  const prepared = await prepareLinuxRuntimePermissions(context);
  if (!prepared.skipped) console.log(`[afterPack] verified Linux unpacked dependency permissions ${JSON.stringify(prepared)}`);
};
