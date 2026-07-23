import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { UpdaterDiagnostic } from "../../shared/types";
import type { InstalledAppTrustResult } from "./controller";
import { updaterDiagnostic } from "./controller";

export interface MacReleaseSigningPolicy {
  schemaVersion: 1;
  bundleIdentifier: string;
  teamIdentifier: string;
  leafAuthorityPrefix: string;
  leafAuthority: string;
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

type CacheCandidate = {
  filePath: string;
  dev: number;
  ino: number;
  parents: Array<{ directoryPath: string; dev: number; ino: number; mode: number }>;
};

function decodeXmlText(value: string): string | null {
  // `plutil` owns plist decoding and `xmllint` owns XPath selection. This tiny
  // decoder handles only the XML text representation emitted by those tools;
  // raw markup or an unknown entity fails closed instead of becoming a path.
  if (
    /[<>]/.test(value)
    || /&(?!(?:amp|lt|gt|quot|apos);|#(?:[0-9]+|x[0-9a-fA-F]+);)/.test(value)
  ) return null;
  let valid = true;
  const decoded = value.replace(
    /&(?:amp|lt|gt|quot|apos);|&#(?:[0-9]+|x[0-9a-fA-F]+);/g,
    (entity) => {
      switch (entity) {
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&quot;": return '"';
        case "&apos;": return "'";
        default: {
          const hexadecimal = entity.startsWith("&#x");
          const digits = entity.slice(hexadecimal ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
          if (
            !Number.isInteger(codePoint)
            || codePoint < 0
            || codePoint > 0x10ffff
            || (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            valid = false;
            return "";
          }
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            valid = false;
            return "";
          }
        }
      }
    },
  );
  return valid ? decoded : null;
}

function topLevelPlistDictionaryKeys(
  plist: string,
  key: "files" | "files2",
  optional = false,
): string[] | null {
  if (optional) {
    try {
      const type = execFileSync("/usr/bin/plutil", ["-type", key, plist], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (type !== "dictionary") return null;
    } catch {
      // `files` is absent in some otherwise valid CodeResources versions.
      return [];
    }
  }
  try {
    const extracted = execFileSync(
      "/usr/bin/plutil",
      ["-extract", key, "xml1", "-expect", "dictionary", "-o", "-", plist],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const countText = execFileSync(
      "/usr/bin/xmllint",
      ["--nonet", "--xpath", "count(/plist/dict/key)", "-"],
      { input: extracted, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
    ).trim();
    const count = Number(countText);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (count === 0) return [];
    // Select only direct keys of the extracted dictionary. Nested `hash2`,
    // `cdhash`, and `requirement` keys are deliberately outside this XPath.
    const selected = execFileSync(
      "/usr/bin/xmllint",
      ["--nonet", "--xpath", "/plist/dict/key", "-"],
      { input: extracted, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const keys: string[] = [];
    const matcher = /<key>([\s\S]*?)<\/key>/g;
    let cursor = 0;
    for (const match of selected.matchAll(matcher)) {
      if (match.index === undefined || selected.slice(cursor, match.index).trim() !== "") return null;
      const decoded = decodeXmlText(match[1]);
      if (decoded === null || decoded.length === 0 || decoded.includes("\0")) return null;
      keys.push(decoded);
      cursor = match.index + match[0].length;
    }
    if (keys.length !== count || selected.slice(cursor).trim() !== "") return null;
    return keys;
  } catch {
    return null;
  }
}

function sealedResourcePaths(bundleRoot: string, contentsRoot: string): Set<string> | null {
  const signatureRoot = path.join(contentsRoot, "_CodeSignature");
  const codeResources = path.join(signatureRoot, "CodeResources");
  try {
    for (const directory of [bundleRoot, contentsRoot, signatureRoot]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const leaf = fs.lstatSync(codeResources);
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) return null;
    execFileSync("/usr/bin/plutil", ["-lint", codeResources], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    // CodeResources contains plist `data` values which JSON cannot represent.
    // Extract each dictionary as XML, then ask xmllint for direct keys only.
    const files = topLevelPlistDictionaryKeys(codeResources, "files", true);
    const files2 = topLevelPlistDictionaryKeys(codeResources, "files2");
    if (!files || !files2) return null;
    const sealed = new Set<string>();
    for (const entries of [files, files2]) {
      for (const name of entries) sealed.add(name.replaceAll("\\", "/"));
    }
    return sealed;
  } catch {
    return null;
  }
}

/**
 * Removes only generated Python bytecode from the two signed runtime roots.
 * This is intentionally narrower than a generic bundle repair: the official
 * identity is checked before this function is called, symlinks are never
 * followed, and every file inode is rechecked immediately before deletion.
 */
export async function repairMacInstalledAppGeneratedPythonCaches(input: {
  bundlePath: string;
  diagnostic: UpdaterDiagnostic;
}): Promise<boolean> {
  if (input.diagnostic.category !== "source-seal") return false;
  const bundleRoot = path.resolve(input.bundlePath);
  const contentsRoot = path.join(bundleRoot, "Contents");
  const resourcesRoot = path.join(contentsRoot, "Resources");
  try {
    for (const directory of [bundleRoot, contentsRoot, resourcesRoot]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
  } catch {
    return false;
  }
  const sealed = sealedResourcePaths(bundleRoot, contentsRoot);
  if (!sealed) return false;
  const files: CacheCandidate[] = [];
  let visited = 0;
  const visit = (candidate: string): void => {
    if (visited >= 100_000) throw new Error("Python cache repair scan limit exceeded");
    visited += 1;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    const relative = path.relative(resourcesRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
      return;
    }
    if (stat.isFile() && /\.py[co]$/i.test(path.basename(candidate))) {
      if (stat.nlink !== 1) throw new Error("Python cache repair candidate is hard-linked");
      const contentsRelative = path.relative(contentsRoot, candidate).split(path.sep).join("/");
      if (sealed.has(contentsRelative)) throw new Error("Python cache repair candidate is a signed resource");
      const parents: CacheCandidate["parents"] = [];
      let directoryPath = path.dirname(candidate);
      while (directoryPath.length >= resourcesRoot.length) {
        const parentStat = fs.lstatSync(directoryPath);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return;
        parents.push({
          directoryPath,
          dev: parentStat.dev,
          ino: parentStat.ino,
          mode: parentStat.mode & 0o777,
        });
        if (directoryPath === resourcesRoot) break;
        directoryPath = path.dirname(directoryPath);
      }
      files.push({ filePath: candidate, dev: stat.dev, ino: stat.ino, parents });
    }
  };

  try {
    for (const name of ["Hephaestus", "python-runtime"]) {
      const root = path.join(resourcesRoot, name);
      if (!fs.existsSync(root)) continue;
      const rootStat = fs.lstatSync(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue;
      visit(root);
    }
    let removed = 0;
    for (const candidate of files) {
      const parentsStable = candidate.parents.every((parent) => {
        const current = fs.lstatSync(parent.directoryPath);
        return current.isDirectory()
          && !current.isSymbolicLink()
          && current.dev === parent.dev
          && current.ino === parent.ino;
      });
      if (!parentsStable) continue;
      const immediateParent = candidate.parents[0];
      if (!immediateParent) continue;
      const temporaryParentMode = immediateParent.mode | 0o300;
      const restoreParentMode = temporaryParentMode !== immediateParent.mode;
      let parentFd: number | null = null;
      let parentModeChanged = false;
      try {
        parentFd = fs.openSync(
          immediateParent.directoryPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const openedParent = fs.fstatSync(parentFd);
        if (
          !openedParent.isDirectory()
          || openedParent.dev !== immediateParent.dev
          || openedParent.ino !== immediateParent.ino
        ) {
          continue;
        }
        if (restoreParentMode) {
          fs.fchmodSync(parentFd, temporaryParentMode);
          parentModeChanged = true;
        }
        const currentParent = fs.lstatSync(immediateParent.directoryPath);
        if (
          !currentParent.isDirectory()
          || currentParent.isSymbolicLink()
          || currentParent.dev !== immediateParent.dev
          || currentParent.ino !== immediateParent.ino
        ) {
          continue;
        }
        const current = fs.lstatSync(candidate.filePath);
        if (
          !current.isFile()
          || current.isSymbolicLink()
          || current.nlink !== 1
          || current.dev !== candidate.dev
          || current.ino !== candidate.ino
        ) {
          continue;
        }
        fs.unlinkSync(candidate.filePath);
        removed += 1;
      } finally {
        if (parentFd !== null) {
          try {
            if (parentModeChanged) fs.fchmodSync(parentFd, immediateParent.mode);
          } finally {
            fs.closeSync(parentFd);
          }
        }
      }
    }
    // Empty generated-cache directories do not participate in the code seal.
    // Leave them in place so repairing a previously read-only install never
    // requires widening a signed ancestor merely to remove an empty entry.
    return removed > 0;
  } catch {
    return false;
  }
}

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
      raw.leafAuthority !== `Developer ID Application: Jeongmin Kim (${raw.teamIdentifier})` ||
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

function isSignedBundleSealFailure(output: string): boolean {
  // `codesign --verify -R=...` checks the resource seal and requirement in one
  // pass. Keep the successful path to one invocation, while classifying the
  // stable macOS diagnostics emitted when signed bundle contents were added,
  // removed, or changed after packaging. Raw output never leaves Main.
  return /(?:a\s+sealed\s+resource\s+is\s+missing\s+or\s+invalid|code\s+or\s+signature\s+have\s+been\s+modified|invalid\s+signature|unsealed\s+contents\s+present|resource\s+envelope\s+is\s+obsolete|file\s+(?:added|modified|missing)|code\s+object\s+is\s+not\s+signed\s+at\s+all)/i.test(output);
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
  if (actualAuthorities[0] !== policy.leafAuthority) {
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
    return {
      ok: false,
      diagnostic: updaterDiagnostic(
        isSignedBundleSealFailure(verified.output)
          ? "source-seal"
          : "source-designated-requirement",
      ),
    };
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
