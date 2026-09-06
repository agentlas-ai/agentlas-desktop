const asar = require("@electron/asar");
const path = require("node:path");
const fs = require("node:fs");

// These are used by the main-process Science services, not just the web build.
// Resolve from the final archive so a development dependency cannot mask a
// missing production module. Native binaries must also exist outside ASAR.
function verifyScienceRuntimePackage(archive, platform, arch) {
  const files = new Set(asar.listPackage(archive).map((name) => name.replace(/^\//, "")));
  const manifest = JSON.parse(asar.extractFile(archive, "package.json").toString());
  const required = [
    "node_modules/sharp/package.json",
    "node_modules/molstar/package.json",
    "node_modules/molstar/lib/commonjs/mol-model/structure.js",
    "node_modules/molstar/lib/commonjs/mol-io/reader/pdb/parser.js",
    "node_modules/molstar/lib/commonjs/mol-io/reader/cif.js",
  ];
  for (const name of ["sharp", "molstar"]) {
    if (!manifest.dependencies?.[name]) throw new Error(`science-package-runtime-dependency-missing:${name}`);
  }
  for (const file of required) {
    if (!files.has(file)) throw new Error(`science-package-file-missing:${file}`);
  }
  const nativeRoot = `node_modules/@img/sharp-${platform}-${arch}/`;
  const nativeFiles = [...files].filter((name) => name.startsWith(nativeRoot) && name.endsWith(".node"));
  if (!nativeFiles.length) throw new Error(`science-package-sharp-native-missing:${platform}-${arch}`);
  for (const file of nativeFiles) {
    if (!fs.existsSync(path.join(`${archive}.unpacked`, file))) {
      throw new Error(`science-package-sharp-native-not-unpacked:${file}`);
    }
  }
  if (platform !== "win32") {
    const vipsRoot = `node_modules/@img/sharp-libvips-${platform}-${arch}/`;
    const libraries = [...files].filter((name) => name.startsWith(vipsRoot) && /\.(?:dylib|so(?:\.\d+)*)$/.test(name));
    if (!libraries.length || libraries.some((file) => !fs.existsSync(path.join(`${archive}.unpacked`, file)))) {
      throw new Error(`science-package-sharp-libvips-missing:${platform}-${arch}`);
    }
  }
  return { platform, arch, requiredFiles: required.length, nativeFiles: nativeFiles.length };
}

module.exports = { verifyScienceRuntimePackage };
