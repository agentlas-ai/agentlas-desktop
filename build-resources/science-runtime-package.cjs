const asar = require("@electron/asar");
const path = require("node:path");
const fs = require("node:fs");

// Packaged Linux targets use GNU libc; Windows targets use MSVC bindings.
const SCIENCE_NATIVE_CANVAS = {
  "darwin:arm64": ["@napi-rs/canvas-darwin-arm64", "skia.darwin-arm64.node"],
  "darwin:x64": ["@napi-rs/canvas-darwin-x64", "skia.darwin-x64.node"],
  "linux:x64": ["@napi-rs/canvas-linux-x64-gnu", "skia.linux-x64-gnu.node"],
  "win32:x64": ["@napi-rs/canvas-win32-x64-msvc", "skia.win32-x64-msvc.node"],
  "win32:arm64": ["@napi-rs/canvas-win32-arm64-msvc", "skia.win32-arm64-msvc.node"],
};

function scienceNativeTarget(platform, arch) {
  const canvas = SCIENCE_NATIVE_CANVAS[`${platform}:${arch}`];
  if (!canvas) throw new Error(`science-native-target-unsupported:${platform}:${arch}`);
  return {
    dependencies: [
      `@img/sharp-${platform}-${arch}`,
      ...(platform === "win32" ? [] : [`@img/sharp-libvips-${platform}-${arch}`]),
      canvas[0],
    ],
    canvasPackage: canvas[0],
    canvasBinding: canvas[1],
  };
}

// These are used by the main-process Science services, not just the web build.
// Resolve from the final archive so a development dependency cannot mask a
// missing production module. Native binaries must also exist outside ASAR.
function verifyScienceRuntimePackage(archive, platform, arch) {
  const target = scienceNativeTarget(platform, arch);
  const files = new Set(asar.listPackage(archive).map((name) => name.replace(/\\/g, "/").replace(/^\/+/, "")));
  const manifest = JSON.parse(asar.extractFile(archive, "package.json").toString());
  const required = [
    "node_modules/@napi-rs/canvas/package.json",
    "node_modules/@napi-rs/canvas/index.js",
    "node_modules/@napi-rs/canvas/js-binding.js",
    `node_modules/${target.canvasPackage}/package.json`,
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
  // ASAR lookups use the build host's path separator, including cross-target packages.
  const canvas = JSON.parse(asar.extractFile(archive, path.normalize("node_modules/@napi-rs/canvas/package.json")).toString());
  const bindingManifest = JSON.parse(asar.extractFile(archive, path.normalize(`node_modules/${target.canvasPackage}/package.json`)).toString());
  if (canvas.name !== "@napi-rs/canvas" || !canvas.version
    || bindingManifest.name !== target.canvasPackage || bindingManifest.version !== canvas.version
    || canvas.optionalDependencies?.[target.canvasPackage] !== bindingManifest.version
    || !bindingManifest.os?.includes(platform) || !bindingManifest.cpu?.includes(arch)) {
    throw new Error(`science-package-canvas-native-identity-mismatch:${platform}-${arch}`);
  }
  const canvasFile = `node_modules/${target.canvasPackage}/${target.canvasBinding}`;
  if (!files.has(canvasFile)) throw new Error(`science-package-canvas-native-missing:${platform}-${arch}`);
  const unpackedCanvas = path.join(`${archive}.unpacked`, canvasFile);
  if (!asar.statFile(archive, path.normalize(canvasFile), false).unpacked || !fs.existsSync(unpackedCanvas)
    || !fs.lstatSync(unpackedCanvas).isFile() || fs.lstatSync(unpackedCanvas).isSymbolicLink()) {
    throw new Error(`science-package-canvas-native-not-unpacked:${canvasFile}`);
  }
  return { platform, arch, requiredFiles: required.length, nativeFiles: nativeFiles.length };
}

module.exports = { verifyScienceRuntimePackage, scienceNativeTarget };
