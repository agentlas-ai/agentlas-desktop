#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-fresh-mac-connect-"));
const originalHomedir = os.homedir;
os.homedir = () => temp;

(async () => {
  try {
    process.env.NODE_ENV = "development";
    const installer = require(path.join(root, "dist/electron/runtime/install-cli.js"));
    const managedNode = require(path.join(root, "dist/electron/runtime/managed-node.js"));
    const cliDir = path.join(temp, "Agentlas Managed CLI", "bin");
    fs.mkdirSync(cliDir, { recursive: true });
    const provider = path.join(cliDir, "provider-probe");
    fs.writeFileSync(
      provider,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
      { mode: 0o700 },
    );
    fs.chmodSync(provider, 0o700);

    if (process.platform !== "win32") {
      const packagedRoot = path.join(root, "build-resources", "node-runtime");
      const packaged = managedNode.validateManagedNodeRuntimeRoot(packagedRoot);
      assert.equal(packaged.ok, true, packaged.reason);
      const nodeDir = path.dirname(packaged.runtime.node);
      if (process.platform === "darwin") {
        const systemOnly = spawnSync("node", ["--version"], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        assert.notEqual(systemOnly.status, 0,
          "fresh-Mac fixture is invalid: its minimal system PATH unexpectedly contains Node");
        const withoutPackagedNode = spawnSync(provider, ["login"], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });
        assert.notEqual(withoutPackagedNode.status, 0,
          "negative control is invalid: the provider launcher worked without any Node on PATH");
      }
      const command = installer.buildPosixCliLoginCommand(
        provider,
        ["login", "argument with spaces"],
        [cliDir, nodeDir],
        "Agentlas login probe",
      );
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Agentlas login probe/);
      assert.match(result.stdout, /\["login","argument with spaces"\]/);

      const manualInstall = installer.manualInstallCommand("kimi");
      assert.match(manualInstall, /^export PATH=/,
        "the manual first-install fallback must give npm lifecycle scripts a Node PATH");
      assert.ok(manualInstall.includes(packaged.runtime.node));
      assert.ok(manualInstall.includes(packaged.runtime.npmCli));
      assert.match(manualInstall, /'--userconfig'/,
        "the manual fallback must not load a user-controlled scoped registry");
      assert.match(manualInstall, /'--globalconfig'/,
        "the manual fallback must not load a user-controlled global registry");

      const maliciousNpmrc = path.join(temp, "malicious-user.npmrc");
      const isolatedUserNpmrc = path.join(temp, "isolated-user.npmrc");
      const isolatedGlobalNpmrc = path.join(temp, "isolated-global.npmrc");
      fs.writeFileSync(maliciousNpmrc, "@moonshot-ai:registry=https://example.invalid/\n");
      fs.writeFileSync(isolatedUserNpmrc, "registry=https://registry.npmjs.org/\n");
      fs.writeFileSync(isolatedGlobalNpmrc, "registry=https://registry.npmjs.org/\n");
      const isolatedRegistry = spawnSync(packaged.runtime.node, [
        packaged.runtime.npmCli,
        "config",
        "get",
        "@moonshot-ai:registry",
        "--userconfig",
        isolatedUserNpmrc,
        "--globalconfig",
        isolatedGlobalNpmrc,
        "--registry",
        "https://registry.npmjs.org/",
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", NPM_CONFIG_USERCONFIG: maliciousNpmrc },
      });
      assert.equal(isolatedRegistry.status, 0, isolatedRegistry.stderr);
      assert.notEqual(isolatedRegistry.stdout.trim(), "https://example.invalid/",
        "the manual fallback isolation must override a malicious scoped registry");

      const refused = await installer.spawnTerminalVerified(
        "/bin/sh",
        ["-c", "exit 73"],
        { stdio: "ignore" },
      );
      assert.equal(refused.ok, false,
        "an immediate osascript/TCC-style refusal must not be reported as an opened login window");
      assert.match(refused.reason, /exit 73/);

      const delayedRefusal = await installer.spawnTerminalVerified(
        "/bin/sh",
        ["-c", "sleep 1; exit 74"],
        { stdio: "ignore" },
        { requireExit: true, timeoutMs: 5_000 },
      );
      assert.equal(delayedRefusal.ok, false,
        "a delayed macOS automation refusal must not be reported as an opened login window");
      assert.match(delayedRefusal.reason, /exit 74/);
    }

    const settings = fs.readFileSync(path.join(root, "renderer/app/(shell)/settings/page.tsx"), "utf8");
    assert.match(settings, /if \(!result\?\.ok\)/,
      "Settings must render a returned login failure instead of showing the success hint");
    assert.match(settings, /settings\.cli\.login_failed/,
      "Settings must expose a useful login failure state");

    console.log("fresh Mac CLI connection contract passed");
  } finally {
    os.homedir = originalHomedir;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
