"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// pip 26.1.1 in the pinned Python 3.12.13 install-only archives.
const PIP_INPUTS = Object.freeze({
  "pip/__init__.py": "0fe48a0e72579d94957706f83d3ac2fd47716f72f4cddb201909c0be173526a2",
  "pip/_internal/cli/index_command.py": "3d370a49df89ddb51a9730cef6436f6779841a22578b1df64387cfc24c525c87",
  "pip/_internal/network/session.py": "ef32bb11e402491162a6ee19cdc5a5d55dc030a9225ddb46a85afb1af5362eb6",
});
const RECEIPT = "agentlas-python-public-trust.json";
const PIP_OUTPUTS = Object.freeze({
  indexSha256: "8bdb90b79e2988cca43ce559791dc6f871afafbc6ee241b3be6393900550483c",
  sessionSha256: "e878065501fdbd359623205872cb46ee6e2670d32e9f83486a8019cce7825f45",
});
const INDEX_OLD = "    ctx.load_verify_locations(certifi.where())\n";
const INDEX_NEW = `    # Use system trust only when the bundled public CA file is genuinely absent.\n    bundle = certifi.where()\n    try:\n        bundle_stat = os.lstat(bundle)\n    except FileNotFoundError:\n        if sys.platform not in ("darwin", "win32", "linux"):\n            raise\n    else:\n        import stat\n        if not stat.S_ISREG(bundle_stat.st_mode):\n            raise OSError("pip_bundle_path_untrusted")\n        ctx.load_verify_locations(bundle)\n`;
const SESSION_OLD = "        super().__init__(**kwargs)\n\n    def init_poolmanager(\n";
const SESSION_NEW = `        super().__init__(**kwargs)\n\n    def cert_verify(self, conn, url, verify, cert):\n        # A missing bundled CA may use only an authenticated native context.\n        if sys.platform in ("darwin", "win32", "linux") and self._ssl_context is not None and url.lower().startswith("https:") and verify is True:\n            from pip._vendor.requests.adapters import DEFAULT_CA_BUNDLE_PATH\n            try:\n                bundle_stat = os.lstat(DEFAULT_CA_BUNDLE_PATH)\n            except FileNotFoundError:\n                bundle_absent = True\n            else:\n                import stat\n                if not stat.S_ISREG(bundle_stat.st_mode):\n                    raise OSError("pip_bundle_path_untrusted")\n                bundle_absent = False\n            if bundle_absent:\n                import ssl\n                from pip._vendor import truststore\n                ctx = self._ssl_context\n                if isinstance(ctx, truststore.SSLContext) and ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname:\n                    from pip._vendor.requests.compat import basestring\n                    conn.cert_reqs = "CERT_REQUIRED"\n                    conn.ca_certs = None\n                    conn.ca_cert_dir = None\n                    if cert:\n                        if not isinstance(cert, basestring):\n                            conn.cert_file = cert[0]\n                            conn.key_file = cert[1]\n                        else:\n                            conn.cert_file = cert\n                            conn.key_file = None\n                        if conn.cert_file and not os.path.exists(conn.cert_file):\n                            raise OSError(f"Could not find the TLS certificate file, invalid path: {conn.cert_file}")\n                        if conn.key_file and not os.path.exists(conn.key_file):\n                            raise OSError(f"Could not find the TLS key file, invalid path: {conn.key_file}")\n                    return\n        return super().cert_verify(conn=conn, url=url, verify=verify, cert=cert)\n\n    def init_poolmanager(\n`;
function digest(b) { return crypto.createHash("sha256").update(b).digest("hex"); }
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) !== -1) throw new Error("[python-public-trust] source pattern mismatch");
  return text.slice(0, at) + after + text.slice(at + before.length);
}
function checkedRead(root, relative, expected) {
  const file = path.join(root, ...relative.split("/"));
  const realRoot = fs.realpathSync(root), parent = fs.realpathSync(path.dirname(file));
  if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) throw new Error("[python-public-trust] source escapes stage");
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("[python-public-trust] source identity invalid");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw new Error("[python-public-trust] source changed");
    const bytes = fs.readFileSync(fd);
    if (digest(bytes) !== expected) throw new Error("[python-public-trust] pinned pip source mismatch");
    return { file, before, text: bytes.toString("utf8") };
  } finally { fs.closeSync(fd); }
}
function writeReplacement(item, text) {
  const tmp = `${item.file}.agentlas-${crypto.randomUUID()}.partial`;
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), item.before.mode & 0o777);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const now = fs.lstatSync(item.file);
  if (now.dev !== item.before.dev || now.ino !== item.before.ino || !now.isFile()) throw new Error("[python-public-trust] source changed before replace");
  fs.renameSync(tmp, item.file);
}
function sitePackages(root, platform) { return platform === "win32" ? path.join(root, "Lib", "site-packages") : path.join(root, "lib", "python3.12", "site-packages"); }
function rejectExisting(file) {
  try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("[python-public-trust] certificate exists in staging runtime");
}
function transformPublicPython(root, platform, archiveSha256) {
  if (!["darwin", "win32", "linux"].includes(platform) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("[python-public-trust] invalid target");
  const site = sitePackages(root, platform);
  rejectExisting(path.join(site, "pip", "_vendor", "certifi", "cacert.pem"));
  const init = checkedRead(site, "pip/__init__.py", PIP_INPUTS["pip/__init__.py"]);
  if (!init.text.includes('__version__ = "26.1.1"')) throw new Error("[python-public-trust] pip version mismatch");
  const index = checkedRead(site, "pip/_internal/cli/index_command.py", PIP_INPUTS["pip/_internal/cli/index_command.py"]);
  const session = checkedRead(site, "pip/_internal/network/session.py", PIP_INPUTS["pip/_internal/network/session.py"]);
  const indexText = replaceOnce(replaceOnce(index.text, "import os\nfrom collections.abc", "import os\nimport sys\nfrom collections.abc"), INDEX_OLD, INDEX_NEW);
  const sessionText = replaceOnce(session.text, SESSION_OLD, SESSION_NEW);
  if (digest(Buffer.from(indexText)) !== PIP_OUTPUTS.indexSha256 || digest(Buffer.from(sessionText)) !== PIP_OUTPUTS.sessionSha256) throw new Error("[python-public-trust] transform identity mismatch");
  writeReplacement(index, indexText); writeReplacement(session, sessionText);
  const receipt = { schemaVersion: "agentlas.python-public-trust.v1", platform, archiveSha256, pipVersion: "26.1.1", indexSha256: digest(Buffer.from(indexText)), sessionSha256: digest(Buffer.from(sessionText)), policy: "native-system-trust" };
  fs.writeFileSync(path.join(root, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return receipt;
}
function forbiddenPublicName(name) {
  const lower = name.toLowerCase();
  return lower === "credentials" || lower === "signing" || lower === "relay.json" || lower.startsWith(".env")
    || /\.(?:pem|crt|cer|p12|pfx|der|key|img|qcow2)$/i.test(name);
}
function assertNoForbiddenPublicPaths(root, options = {}) {
  const absoluteRoot = fs.realpathSync(root);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(absoluteRoot, file).split(path.sep).join("/");
      const legacyCa = [options.legacyCa].flat().includes(relative);
      if (forbiddenPublicName(entry.name) && !legacyCa) throw new Error("[python-public-trust] prohibited public path detected");
      const st = fs.lstatSync(file);
      if (legacyCa && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw new Error("[python-public-trust] invalid legacy CA entry");
      if (st.isDirectory()) visit(file);
      else if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target)) throw new Error("[python-public-trust] absolute public symlink");
        const resolved = path.resolve(path.dirname(file), target);
        if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) throw new Error("[python-public-trust] public symlink escapes root");
        if (path.relative(absoluteRoot, resolved).split(path.sep).some(forbiddenPublicName)) throw new Error("[python-public-trust] prohibited symlink target");
      } else if (!st.isFile()) throw new Error("[python-public-trust] unsupported public entry");
    }
  };
  visit(absoluteRoot);
}
// These entries are intentionally omitted from the existing tree digest.
// Refuse them during cache reuse instead of treating untracked bytes as verified.
function assertNoUntrackedBytecode(root) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === "__pycache__" || /\.py[co]$/i.test(entry.name)) throw new Error("[python-public-trust] untracked bytecode in runtime cache");
      const file = path.join(dir, entry.name), st = fs.lstatSync(file);
      if (st.isDirectory()) visit(file);
    }
  };
  visit(root);
}
function verifyPublicPython(root, platform, archiveSha256) {
  assertNoForbiddenPublicPaths(root);
  assertNoUntrackedBytecode(root);
  const receiptFile = path.join(root, RECEIPT), st = fs.lstatSync(receiptFile);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("[python-public-trust] invalid receipt");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const expectedKeys = ["archiveSha256", "indexSha256", "pipVersion", "platform", "policy", "schemaVersion", "sessionSha256"];
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
    || receipt.schemaVersion !== "agentlas.python-public-trust.v1" || receipt.policy !== "native-system-trust"
    || receipt.pipVersion !== "26.1.1" || receipt.platform !== platform || receipt.archiveSha256 !== archiveSha256
    || receipt.indexSha256 !== PIP_OUTPUTS.indexSha256 || receipt.sessionSha256 !== PIP_OUTPUTS.sessionSha256) throw new Error("[python-public-trust] receipt mismatch");
  const site = sitePackages(root, platform);
  checkedRead(site, "pip/__init__.py", PIP_INPUTS["pip/__init__.py"]);
  checkedRead(site, "pip/_internal/cli/index_command.py", PIP_OUTPUTS.indexSha256);
  checkedRead(site, "pip/_internal/network/session.py", PIP_OUTPUTS.sessionSha256);
  return receipt;
}
module.exports = { assertNoUntrackedBytecode, PIP_INPUTS, PIP_OUTPUTS, RECEIPT, transformPublicPython, verifyPublicPython, assertNoForbiddenPublicPaths, forbiddenPublicName, sitePackages, checkedRead, digest };
