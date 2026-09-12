/** Build and display evidence remain separate from business verification. */
export interface ArtifactBuildProfile {
  schemaVersion: "agentlas.artifact-build-profile.v1";
  id: "html-static-v1" | "astryx-react-19-v1";
  profileDigest: string;
  dependencyLockDigest: string | null;
  compilerDigest: string;
  platform: string;
  arch: string;
}

export interface ArtifactFileDigest {
  path: string;
  sha256: string;
  byteLength: number;
}

export interface ArtifactBuildReceipt {
  schemaVersion: "agentlas.artifact-build-receipt.v1";
  artifactId: string;
  surfaceId: string;
  owner: { chatId: string; projectId: string | null; agentId: string };
  sourceDigest: string;
  sourceIdentityDigest: string;
  dataDigest: string;
  profile: ArtifactBuildProfile;
  files: ArtifactFileDigest[];
  bundleDigest: string;
  builtAt: string;
  state: "built";
}

export interface ArtifactRenderReceipt {
  schemaVersion: "agentlas.artifact-render-receipt.v1";
  artifactId: string;
  sourceDigest: string;
  bundleDigest: string;
  viewport: { width: number; height: number };
  screenshotDigest: string;
  observedAt: string;
  consoleFailures: string[];
  horizontalOverflow: number;
  state: "render_checked";
  businessVerification: "not_verified";
}

export interface ArtifactReadyRevision {
  schemaVersion: "agentlas.artifact-ready.v1";
  build: ArtifactBuildReceipt;
  render: ArtifactRenderReceipt;
  readyAt: string;
}
