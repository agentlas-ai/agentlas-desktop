import { execFile } from "node:child_process";
import fs from "node:fs";
import type { InstalledAppTrustResult } from "./controller";
import { updaterDiagnostic } from "./controller";

export interface MacReleaseSigningPolicy {
  schemaVersion: 1;
  bundleIdentifier: string;
  teamIdentifier: string;
  leafAuthorityPrefix: string;
  designatedRequirement: string;
}
export interface MacTrustCommandResult {
  ok: boolean;
  output: string;
}

export type MacTrustCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<MacTrustCommandResult>;

function readSigningPolicy(file: string): MacReleaseSigningPolicy | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MacReleaseSigningPolicy>;
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.bundleIdentifier !== "string" ||
      !/^[A-Za-z0-9.-]+$/.test(raw.bundleIdentifier) ||
      typeof raw.teamIdentifier !== "string" ||
      !/^[A-Z0-9]{10}$/.test(raw.teamIdentifier) ||
      raw.leafAuthorityPrefix !== "Developer ID Application:" ||
      typeof raw.designatedRequirement !== "string" ||
      !raw.designatedRequirement.includes(`identifier \"${raw.bundleIdentifier}\"`) ||
      !raw.designatedRequirement.includes("anchor apple generic") ||
      !raw.designatedRequirement.includes("1.2.840.113635.100.6.1.13") ||
      !raw.designatedRequirement.includes("1.2.840.113635.100.6.2.6") ||
      !raw.designatedRequirement.includes(raw.teamIdentifier)
    ) {
      return null;
    }
    return raw as MacReleaseSigningPolicy;
  } catch {
    return null;
  }
}

function defaultCommandRunner(command: string, args: readonly string[]): Promise<MacTrustCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          // This output is classified locally and never crosses the main/renderer boundary.
          output: [stdout, stderr].filter(Boolean).join("\n").slice(0, 1024 * 1024),
        });
      },
    );
  });
}

function metadataValue(output: string, key: string): string | null {
  const prefix = `${key}=`;
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function authorities(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length).trim());
}

/**
 * Main-only trust gate for the currently running macOS app. Runtime update
 * eligibility uses the exact production Developer ID policy plus Gatekeeper.
 * Raw command output is discarded and only fixed diagnostics reach renderer.
 */
export async function inspectMacInstalledAppTrust(input: {
  bundlePath: string;
  policyPath: string;
  runCommand?: MacTrustCommandRunner;
}): Promise<InstalledAppTrustResult> {
  const policy = readSigningPolicy(input.policyPath);
  if (!policy) {
    return { ok: false, diagnostic: updaterDiagnostic("source-verification-unavailable") };
  }
  const run = input.runCommand ?? defaultCommandRunner;
  const displayed = await run("codesign", ["-d", "-r-", "--verbose=4", input.bundlePath]);
  if (!displayed.ok) {
    return { ok: false, diagnostic: updaterDiagnostic("source-signature-class") };
  }

  const identifier = metadataValue(displayed.output, "Identifier");
  const teamIdentifier = metadataValue(displayed.output, "TeamIdentifier");
  if (identifier !== policy.bundleIdentifier || teamIdentifier !== policy.teamIdentifier) {
    return { ok: false, diagnostic: updaterDiagnostic("source-identity") };
  }
  const actualAuthorities = authorities(displayed.output);
  if (!actualAuthorities[0]?.startsWith(policy.leafAuthorityPrefix)) {
    return { ok: false, diagnostic: updaterDiagnostic("source-signature-class") };
  }

  const verified = await run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=${policy.designatedRequirement}`,
    input.bundlePath,
  ]);
  if (!verified.ok) {
    return { ok: false, diagnostic: updaterDiagnostic("source-designated-requirement") };
  }
  const gatekeeper = await run("spctl", [
    "-a",
    "-t",
    "execute",
    "--context",
    "context:primary-signature",
    "-vv",
    input.bundlePath,
  ]);
  if (!gatekeeper.ok) {
    return { ok: false, diagnostic: updaterDiagnostic("source-gatekeeper") };
  }
  return { ok: true };
}
