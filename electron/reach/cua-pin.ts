// The one Cua Driver release Reach runs. Everything about trust is pinned here, in reviewed source, not read from the network:
// a release that is re-uploaded or tampered with at the source cannot change what this table accepts.
//
// Measured 2026-10-23 on the real artifact: the macOS binary is signed "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)" with the
// hardened runtime and is NOT notarized (spctl: "Unnotarized Developer ID"). A file this app downloads itself carries no quarantine
// attribute, so Gatekeeper does not assess it; the team id and the SHA-256 are what Reach checks instead.

export interface CuaArtifact {
  name: string;
  bytes: number;
  sha256: string;
  archive: "tar.gz" | "zip";
  executable: string;
}

export const CUA_DRIVER_PIN = {
  version: "0.38.0",
  tag: "cua-driver-rs-v0.38.0",
  repository: "trycua/cua",
  macTeamId: "YCK386LBJ7",
  windowsSigner: "Cua AI, Inc.",
  artifacts: {
    "darwin-universal": {
      name: "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
      bytes: 53_208_248,
      sha256: "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
      archive: "tar.gz",
      executable: "cua-driver",
    },
    "linux-x64": {
      name: "cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz",
      bytes: 37_183_089,
      sha256: "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
      archive: "tar.gz",
      executable: "cua-driver",
    },
    "linux-arm64": {
      name: "cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
      bytes: 36_674_648,
      sha256: "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
      archive: "tar.gz",
      executable: "cua-driver",
    },
    "win32-x64": {
      name: "cua-driver-rs-0.38.0-windows-x86_64-binary.zip",
      bytes: 35_890_999,
      sha256: "5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5",
      archive: "zip",
      executable: "cua-driver.exe",
    },
    "win32-arm64": {
      name: "cua-driver-rs-0.38.0-windows-arm64-binary.zip",
      bytes: 33_682_556,
      sha256: "d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700",
      archive: "zip",
      executable: "cua-driver.exe",
    },
  } satisfies Record<string, CuaArtifact>,
} as const;

export type CuaPlatformKey = keyof typeof CUA_DRIVER_PIN.artifacts;

export function cuaPlatformKey(platform: string, arch: string): CuaPlatformKey | null {
  if (platform === "darwin") return "darwin-universal"; // one universal binary serves both architectures
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : arch === "x64" ? "linux-x64" : null;
  if (platform === "win32") return arch === "arm64" ? "win32-arm64" : arch === "x64" ? "win32-x64" : null;
  return null;
}

export function cuaArtifactUrl(artifact: CuaArtifact, pin: { repository: string; tag: string } = CUA_DRIVER_PIN): string {
  return `https://github.com/${pin.repository}/releases/download/${pin.tag}/${artifact.name}`;
}
