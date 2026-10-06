#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const contract = require("../build-resources/embedded-core-contract.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sourceRoot = path.resolve(process.env.HEPHAESTUS_DIR || path.join(root, "Hephaestus"));
const stageRoot = path.resolve(process.env.AGENTLAS_EMBEDDED_CORE_DIR || path.join(root, contract.EMBEDDED_CORE_STAGE_RELATIVE));
const temporaryRoot = `${stageRoot}.tmp-${process.pid}`;

function replaceExactly(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one pinned-source fragment`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function transformTextFile(filePath, transform) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = transform(before);
  if (after !== before) fs.writeFileSync(filePath, after, "utf8");
}

function transformBootstrap(filePath) {
  transformTextFile(filePath, (source) => {
    // Core v1.2.1 already retired this surface upstream. Keep the Desktop
    // projection compatible with both the last pre-retirement source and the
    // already-transformed runtime instead of requiring a second removal.
    if (!source.includes('    ".agentlas/super-ontology-*",\n') && !/super[-_ ]ontology/i.test(source)) return source;
    let next = replaceExactly(source, '    ".agentlas/super-ontology-*",\n', "", `${filePath}: privacy pattern`);
    next = replaceExactly(
      next,
      '    template_root = _template_root()\n    if template_root:\n        for template in sorted(template_root.glob("super-ontology-*.tpl")):\n            relative = ".agentlas/" + template.name.removesuffix(".tpl")\n            rendered = _render_template(template.name, replacements)\n            if rendered is not None:\n                _write_missing(root / relative, rendered, created, root)\n    else:\n        warnings.append("template_root_missing:super_ontology_not_seeded")\n',
      "",
      `${filePath}: project generator`,
    );
    return next;
  });
}

function transformAgentOs(filePath) {
  transformTextFile(filePath, (source) => {
    if (!/super[-_ ]ontology|verify_enforcement|load_kernel|ENFORCED_SEEDS/i.test(source)) return source;
    let next = source;
    const replacements = [
      ["  the AO graph + kernel enforcement + interchange formats, with a content hash.", "  the AO graph + interchange formats, with a content hash."],
      ["from .kernel import verify_enforcement\n", ""],
      [
        '    kernel = verify_enforcement(project_root)\n\n    fingerprint = json.dumps(\n        {"counts": counts, "capabilities": caps, "kernel": kernel["fully_enforced_count"]},\n        sort_keys=True,\n        ensure_ascii=False,\n    )',
        '    validation = validate_graph(project_root)\n    fingerprint = json.dumps(\n        {"format": PACK_FORMAT, "graph": graph, "grammar": context.get("grammar") or {}},\n        sort_keys=True,\n        ensure_ascii=False,\n        separators=(",", ":"),\n    )',
      ],
      ['        "kernel": {\n            "runtime_enforced_seeds": kernel["fully_enforced_count"],\n            "all_enforced": kernel["all_enforced"],\n        },\n', ""],
      ['        "content_hash": content_hash,\n        "installable": bool(counts.get("agents")),', '        "content_hash": content_hash,\n        "source_status": context.get("status"),\n        "valid": bool(validation.get("valid")),\n        "installable": bool(counts.get("agents")) and bool(validation.get("valid")),'],
      ['    kernel = verify_enforcement(project_root)\n    validation = validate_graph(project_root)\n', '    validation = validate_graph(project_root)\n    grammar = context.get("grammar") or {}\n    axiom_count = sum(len(grammar.get(kind) or []) for kind in ("deny", "require"))\n'],
      ['            "subsystem": "super-ontology kernel + AO deny/require axioms",\n            "live": bool(kernel["all_enforced"]),\n            "detail": f"{kernel[\'fully_enforced_count\']} seed contracts runtime-enforced",', '            "subsystem": "AO deny/require axioms",\n            "live": bool(validation.get("valid")),\n            "detail": f"{axiom_count} AO access axioms validated",'],
      ["ABI-compatible with the Agent OS (they inherit the kernel, memory discipline,", "ABI-compatible with the Agent OS (they inherit AO, memory discipline,"],
      ['            "super_ontology_kernel (default-deny axioms)",', '            "ao_access_axioms (deny/require)",'],
    ];
    for (const [before, after] of replacements) next = replaceExactly(next, before, after, `${filePath}: agentos`);
    return next;
  });
}

function transformAgentGraphInit(filePath) {
  transformTextFile(filePath, (source) => {
    if (!/from \.kernel import|ENFORCED_SEEDS|load_kernel|verify_enforcement/.test(source)) return source;
    let next = replaceExactly(source, "from .kernel import ENFORCED_SEEDS, load_kernel, verify_enforcement\n", "", `${filePath}: import`);
    for (const name of ["ENFORCED_SEEDS", "load_kernel", "verify_enforcement"]) {
      next = replaceExactly(next, `    "${name}",\n`, "", `${filePath}: export ${name}`);
    }
    return next;
  });
}

function transformCatalog(filePath) {
  transformTextFile(filePath, (source) => {
    if (!/super ontology|kernel_enforced|kernel's public-export invariant/i.test(source)) return source;
    let next = replaceExactly(source, "(redaction-safe) per the kernel's public-export invariant.", "(redaction-safe) under the public-export invariant.", `${filePath}: docs`);
    next = replaceExactly(next, '        "kernel_enforced": pack["kernel"]["all_enforced"],', '        "ao_validated": pack["valid"],', `${filePath}: result`);
    return next;
  });
}

function transformCli(filePath) {
  transformTextFile(filePath, (source) => {
    if (!/super[-_ ]ontology|load_kernel|verify_enforcement|ENFORCED_SEEDS/.test(source)) return source;
    let next = replaceExactly(
      source,
      '    ao_kernel = ao_sub.add_parser("kernel", help="Super-ontology kernel status (runtime-enforced seed contracts)")\n    ao_kernel.add_argument("project", nargs="?", default=".")\n',
      "",
      `${filePath}: parser`,
    );
    next = replaceExactly(
      next,
      '        if args.ao_command == "kernel":\n            from .agent_graph import load_kernel, verify_enforcement\n\n            kernel = load_kernel(args.project)\n            verification = verify_enforcement(args.project)\n            emit({"kernel": kernel, "verification": verification})\n            return 0 if verification.get("all_enforced") else 1\n',
      "",
      `${filePath}: command`,
    );
    next = replaceExactly(next, "            # ontology and career-graph SQLite databases, 20+ super-ontology\n            # contracts, project-soul-memory.md, credentials/ and signing/", "            # ontology and career-graph SQLite databases, project-soul-memory.md,\n            # credentials/ and signing/", `${filePath}: bootstrap comment`);
    return next;
  });
}

function transformPackageContract(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(payload.artifacts)) throw new Error(`${filePath}: missing artifacts array`);
  // v1.2.4 may carry the retired ontology as several package entries. The
  // desktop projection owns the retirement boundary, so remove the complete
  // retired family rather than assuming it is represented by one seed.
  payload.artifacts = payload.artifacts.filter((artifact) => !/super[-_ ]ontology/i.test(JSON.stringify(artifact)));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function transformActivation(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(payload.seedFiles)) throw new Error(`${filePath}: missing seedFiles`);
  // The upstream activation contract contains one entry per retired ontology
  // seed. All matching entries belong to the same retirement boundary and
  // must be removed together for the prepared runtime to be internally
  // consistent.
  payload.seedFiles = payload.seedFiles.filter((entry) => !/super[-_ ]ontology/i.test(String(entry)));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function transformGrounding(filePath) {
  transformTextFile(filePath, (source) => source
    .replaceAll("the super ontology", "the local semantic ontology")
    .replaceAll('The project-local "super ontology"', 'The project-local "semantic ontology"')
    .replaceAll("super-ontology signals", "ontology signals")
    .replaceAll('"super_ontology"', '"semantic_ontology"'));
}

function copyPinnedTrackedTree() {
  contract.verifyPinnedSource(sourceRoot, pkg);
  const tracked = execFileSync("git", ["-C", sourceRoot, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.mkdirSync(temporaryRoot, { recursive: true });
  for (const relative of tracked) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    const target = path.join(temporaryRoot, ...relative.split("/"));
    const stat = fs.lstatSync(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else if (stat.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(target, stat.mode & 0o777);
    } else throw new Error(`unsupported tracked Core entry: ${relative}`);
  }
}

// Keep the canonical runtime instructions while omitting an upstream historical
// contributor-only/benchmark narrative. Hash-pin mirrors before projecting;
// upstream drift must be reviewed instead of silently changing a new paragraph.
function transformRuntimeInstructions(files) {
  const expected = ["AGENTS.md", "claude/plugins/agentlas-core-engine-meta-agent/AGENTS.md", "codex/plugins/agentlas-core-engine-meta-agent/AGENTS.md"];
  const actual = files.filter(file => path.basename(file) === "AGENTS.md")
    .map(file => path.relative(temporaryRoot, file).replaceAll("\\", "/")).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error("embedded Core runtime instruction mirror count/path mismatch");
  }
  for (const relative of expected) {
    const file = path.join(temporaryRoot, relative);
    let source = fs.readFileSync(file, "utf8");
    const digest = require("node:crypto").createHash("sha256").update(source).digest("hex");
    if (digest !== "3f490e2e24e05c0fb8c85de2ac9377bcb405c78baa7d6b39ccb738bab9849c60") {
      throw new Error(`embedded Core runtime instruction source checksum mismatch: ${relative}`);
    }
    function replaceSpan(startText, endText, replacement) {
      const start = source.indexOf(startText);
      const end = source.indexOf(endText, start + startText.length);
      if (start < 0 || end <= start || source.indexOf(startText, start + 1) >= 0
          || source.indexOf(endText, end + 1) >= 0) {
        throw new Error("embedded Core nonruntime paragraph boundary mismatch");
      }
      source = source.slice(0, start) + replacement + source.slice(end);
    }
    source = replaceExactly(source,
      "> **Asked to install this repo, not to work on it?** This file is the\n> contributor constitution and will not help you. Read the install block at the",
      "> **Asked to install this repo, not to work on it?** Read the install block at the", "runtime install entry");
    replaceSpan("\n## Repository Constitution: Local Main Only\n", "\n## Public Release Allowlist (Hard Rule)\n", "");
    replaceSpan("## Source Code & Commit Language\n", "\nExempt from this rule",
      "## Generated Code Comment Language\n\nGenerated code comments must be written in English, regardless of the language\nof the requesting session or the user's instructions.\n");
    replaceSpan("It is mandatory for the same reason the\n", "Do not report\n", "It is mandatory. ");
    replaceSpan("18. For development changes to the engine ontology runtime, run\n", "19. For long-running or multi-file execution work", "");
    const outputDigest = require("node:crypto").createHash("sha256").update(source).digest("hex");
    if (outputDigest !== "470427c6ff736f32bb62f86c8dba5256911beb2596a1eef1781998cfa4425a34") throw new Error("embedded Core projected instruction checksum mismatch");
    fs.writeFileSync(file, source);

  }
}

function transformPreparedTree() {
  const files = contract.scanRetiredRuntime(temporaryRoot);
  void files;
  const all = [];
  const queue = [temporaryRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else all.push(absolute);
    }
  }

  for (const filePath of all) {
    const normalized = filePath.replaceAll("\\", "/");
    const base = path.basename(filePath);
    if (
      /super[-_]ontology/i.test(base)
      || /\/agentlas_cloud\/agent_graph\/kernel\.py$/.test(normalized)
      || normalized.endsWith("/scripts/verify-package.sh")
    ) {
      fs.rmSync(filePath, { force: true });
    }
  }

  const remaining = all.filter((filePath) => fs.existsSync(filePath));
  transformRuntimeInstructions(remaining);
  for (const filePath of remaining) {
    const normalized = filePath.replaceAll("\\", "/");
    const base = path.basename(filePath);
    if (normalized.endsWith("/agentlas_cloud/project_bootstrap.py")) transformBootstrap(filePath);
    else if (normalized.endsWith("/agentlas_cloud/agent_graph/agentos.py")) transformAgentOs(filePath);
    else if (normalized.endsWith("/agentlas_cloud/agent_graph/__init__.py")) transformAgentGraphInit(filePath);
    else if (normalized.endsWith("/agentlas_cloud/agent_graph/catalog.py")) transformCatalog(filePath);
    else if (normalized.endsWith("/agentlas_cloud/cli.py")) transformCli(filePath);
    else if (base === "package-contract.json") transformPackageContract(filePath);
    else if (base === "activation.json.tpl") transformActivation(filePath);
    else if (/\/agentlas_cloud\/networking\/(?:hub_invocation|policy|router)\.py$/.test(normalized)) transformGrounding(filePath);
  }

  const retired = contract.scanRetiredRuntime(temporaryRoot);
  if (retired.length > 0) throw new Error(`retirement transform incomplete: ${retired.slice(0, 12).join(", ")}`);
  contract.assertRetainedCapabilities(temporaryRoot);
}

try {
  copyPinnedTrackedTree();
  transformPreparedTree();
  contract.writeReceipt(temporaryRoot, {
    sourceCommit: pkg.agentlasBundledRuntimeSource.commit,
    sourceVersion: pkg.agentlasUpdateCompatibility.bundledRuntimeVersion,
  });
  contract.verifyReceipt(temporaryRoot, pkg);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.renameSync(temporaryRoot, stageRoot);
  console.log(`[embedded-core] prepared ${path.relative(root, stageRoot)} from ${pkg.agentlasBundledRuntimeSource.commit.slice(0, 12)} (${contract.RETIREMENT_TRANSFORM_ID})`);
} catch (error) {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  throw error;
}
