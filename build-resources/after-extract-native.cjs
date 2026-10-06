"use strict";

const { stripNodePtyDebug } = require("./before-pack-prepare.cjs");

// electron-builder has rebuilt native dependencies at this boundary, but has
// not yet captured their ASAR sizes/integrity or signed the application.
module.exports = function afterExtractNative(context) {
  stripNodePtyDebug(context.packager.projectDir, context.electronPlatformName);
};
