"use strict";
/**
 * electron-builder custom Windows signing hook: Azure Artifact Signing (formerly Trusted Signing).
 *
 * electron-builder calls this once per file it signs (the application executable, executables under
 * app.asar.unpacked, the NSIS uninstaller, the Setup installer and the Portable executable) and once per hash
 * algorithm. This hook exists, instead of electron-builder's built-in `azureSignOptions`, so that
 *   - the hash-pinned vendor runtimes that ship inside the package (Node, Python, the browser, the engine and the
 *     VC++ runtime) are never re-signed, because their bytes are verified against pins after packaging;
 *   - a release build FAILS CLOSED: when AGENTLAS_WINDOWS_SIGNING=required a missing setting, a failed signature, an
 *     invalid result or a missing timestamp throws and stops the build; there is no unsigned fallback;
 *   - a file that already carries a valid signature from its vendor (OpenConsole.exe in node-pty) is left as it is;
 *   - every signed file is recorded in a ledger (AGENTLAS_WINDOWS_SIGN_LEDGER) for the release gate and for the
 *     monthly signature quota count.
 *
 * Authentication is not handled here: the workflow signs in with GitHub OIDC (azure/login) and the TrustedSigning
 * PowerShell module reads that Azure CLI session (DefaultAzureCredential). No secret passes through this file.
 *
 * Settings (environment):
 *   AGENTLAS_WINDOWS_SIGNING              "required" for an official release build (set by the release workflow); anything else leaves local builds unsigned
 *   AZURE_ARTIFACT_SIGNING_ENDPOINT       for example https://krc.codesigning.azure.net
 *   AZURE_ARTIFACT_SIGNING_ACCOUNT        the signing account name
 *   AZURE_ARTIFACT_SIGNING_PROFILE        the certificate profile name (Public Trust)
 *   AGENTLAS_WINDOWS_SIGN_LEDGER          optional path; one JSON line is appended per signed file
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** Directories under resources/ whose bytes are pinned and must keep the vendor's own signature. */
const PINNED_RUNTIME_DIRS = new Set(["node-runtime", "python-runtime", "browser-runtime", "Hephaestus", "vc-redist"]);
const TIMESTAMP_SERVER = "http://timestamp.acs.microsoft.com";
/** A role assignment can take minutes to reach the signing service, so the very first signature may answer 403. One wait, one retry. */
const PERMISSION_DENIED = /\b403\b|Forbidden|AuthorizationFailed|not authorized|does not have authorization/i;
const PERMISSION_WAIT_MS = 120_000;

const baseName = (file) => String(file).split(/[\\/]/).pop();

function isPinnedRuntimePath(file) {
  const parts = path.normalize(file).split(/[\\/]+/);
  const resources = parts.lastIndexOf("resources");
  return resources !== -1 && parts.slice(resources + 1).some((part) => PINNED_RUNTIME_DIRS.has(part));
}

function readSettings(env) {
  const settings = {
    release: env.AGENTLAS_WINDOWS_SIGNING === "required",
    endpoint: (env.AZURE_ARTIFACT_SIGNING_ENDPOINT || "").trim(),
    account: (env.AZURE_ARTIFACT_SIGNING_ACCOUNT || "").trim(),
    profile: (env.AZURE_ARTIFACT_SIGNING_PROFILE || "").trim(),
    ledger: (env.AGENTLAS_WINDOWS_SIGN_LEDGER || "").trim(),
  };
  const missing = [
    ["AZURE_ARTIFACT_SIGNING_ENDPOINT", settings.endpoint],
    ["AZURE_ARTIFACT_SIGNING_ACCOUNT", settings.account],
    ["AZURE_ARTIFACT_SIGNING_PROFILE", settings.profile],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (settings.endpoint && !/^https:\/\/[a-z0-9.-]+\.codesigning\.azure\.net\/?$/i.test(settings.endpoint)) {
    missing.push("AZURE_ARTIFACT_SIGNING_ENDPOINT (not a *.codesigning.azure.net address)");
  }
  settings.missing = missing;
  return settings;
}

/**
 * One PowerShell run per file: sign with the TrustedSigning module, then read the signature back. Everything the
 * script needs arrives through environment variables so no file name is ever spliced into the command text.
 */
const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module TrustedSigning",
  "$file = $env:AGENTLAS_SIGN_FILE",
  // A file that already carries a valid signature (Microsoft's OpenConsole.exe inside node-pty) keeps its publisher's signature.
  "$pre = Get-AuthenticodeSignature -LiteralPath $file",
  "if ($pre.Status -eq 'Valid') { Write-Output ('KEPT-VENDOR-SIGNATURE subject=' + $pre.SignerCertificate.Subject); exit 0 }",
  "Invoke-TrustedSigning -Endpoint $env:AGENTLAS_SIGN_ENDPOINT -CodeSigningAccountName $env:AGENTLAS_SIGN_ACCOUNT" +
    " -CertificateProfileName $env:AGENTLAS_SIGN_PROFILE -Files $file -FileDigest SHA256" +
    ` -TimestampRfc3161 ${TIMESTAMP_SERVER} -TimestampDigest SHA256` +
    // Only the Azure CLI session that azure/login created may authenticate; every other credential type is switched off so a stray
    // environment variable, an unreachable managed-identity endpoint or an interactive prompt can neither be used nor slow the build.
    " -ExcludeEnvironmentCredential -ExcludeWorkloadIdentityCredential -ExcludeManagedIdentityCredential -ExcludeSharedTokenCacheCredential" +
    " -ExcludeVisualStudioCredential -ExcludeVisualStudioCodeCredential -ExcludeAzurePowerShellCredential -ExcludeAzureDeveloperCliCredential" +
    " -ExcludeInteractiveBrowserCredential",
  "$sig = Get-AuthenticodeSignature -LiteralPath $file",
  "if ($sig.Status -ne 'Valid') { throw \"signature status $($sig.Status) for $file\" }",
  "if ($null -eq $sig.TimeStamperCertificate) { throw \"no timestamp on $file\" }",
  "Write-Output ('SIGNED subject=' + $sig.SignerCertificate.Subject + ' thumbprint=' + $sig.SignerCertificate.Thumbprint)",
].join("; ");

function defaultRun(file, settings) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      AGENTLAS_SIGN_FILE: file,
      AGENTLAS_SIGN_ENDPOINT: settings.endpoint,
      AGENTLAS_SIGN_ACCOUNT: settings.account,
      AGENTLAS_SIGN_PROFILE: settings.profile,
    },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error };
}

/** Builds the signing function. `run`, `env` and `platform` are injectable so the decisions can be tested without Azure. */
function createSigner({ run = defaultRun, env = process.env, platform = process.platform, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const calls = [];
  let permissionRetried = false;
  async function sign(configuration) {
    const file = configuration.path;
    const settings = readSettings(env);
    if (!settings.release) {
      // A developer build on a Windows machine: electron-builder's own output stays unsigned, nothing is claimed.
      calls.push({ file, action: "skipped-not-release" });
      return;
    }
    if (platform !== "win32") throw new Error("windows-sign-azure: an official release must be signed on a Windows runner");
    if (settings.missing.length) throw new Error(`windows-sign-azure: missing settings: ${settings.missing.join(", ")}`);
    if (isPinnedRuntimePath(file)) {
      calls.push({ file, action: "skipped-pinned-runtime" });
      return;
    }
    // electron-builder asks once per configured hash algorithm; only SHA-256 is requested (signingHashAlgorithms).
    if (configuration.hash && String(configuration.hash).toLowerCase() !== "sha256") {
      throw new Error(`windows-sign-azure: unexpected hash algorithm ${configuration.hash}`);
    }
    const unsigned = (r) => r.error || r.status !== 0 || !/(SIGNED|KEPT-VENDOR-SIGNATURE) subject=/.test(r.stdout);
    let result = run(file, settings);
    if (unsigned(result) && !permissionRetried && PERMISSION_DENIED.test([result.stderr, result.stdout, result.error && result.error.message].filter(Boolean).join(" "))) {
      permissionRetried = true;
      calls.push({ file, action: "waiting-for-role-propagation" });
      await sleep(PERMISSION_WAIT_MS);
      result = run(file, settings);
    }
    if (!result.error && result.status === 0 && /KEPT-VENDOR-SIGNATURE subject=/.test(result.stdout)) {
      calls.push({ file, action: "kept-vendor-signature" });
      return;
    }
    if (result.error || result.status !== 0 || !/SIGNED subject=/.test(result.stdout)) {
      const detail = [result.error && result.error.message, result.stderr, result.stdout].filter(Boolean).join(" ").trim().slice(0, 600);
      throw new Error(`windows-sign-azure: signing failed for ${baseName(file)}: ${detail}`);
    }
    const subject = /subject=(.*?) thumbprint=/.exec(result.stdout)?.[1] ?? "";
    calls.push({ file, action: "signed", subject });
    if (settings.ledger) {
      fs.mkdirSync(path.dirname(settings.ledger), { recursive: true });
      fs.appendFileSync(settings.ledger, `${JSON.stringify({ file: baseName(file), path: file, subject, signedAt: now().toISOString() })}\n`);
    }
  }
  sign.calls = calls;
  return sign;
}

const sign = createSigner();
module.exports = sign;
module.exports.default = sign;
module.exports.createSigner = createSigner;
module.exports.isPinnedRuntimePath = isPinnedRuntimePath;
module.exports.readSettings = readSettings;
module.exports.PINNED_RUNTIME_DIRS = PINNED_RUNTIME_DIRS;
