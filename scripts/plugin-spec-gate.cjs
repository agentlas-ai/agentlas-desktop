#!/usr/bin/env node
"use strict";
/*
 * plugin-spec-gate — verifies that an agentlas.plugin/v2 package actually satisfies
 * G1..G15 of the canonical spec (docs/PLUGIN-SPEC.md).
 *
 * A specification kept only as prose drifts. This gate is what holds the document
 * and the packages together. When a rule in the spec changes, change it here in the
 * same commit — a rule without a gate is a hope, not a rule.
 *
 *   node scripts/plugin-spec-gate.cjs [<package-dir> ...]
 *   (with no arguments: every directory under plugins/)
 *
 * Exit code 1 on any violation.
 */
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "agentlas.plugin/v2";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/** Closed list owned by the host. A resolver outside it does not exist. */
const HOST_RESOLVERS = new Set(["browser-cdp", "computer-use", "system-time", "hephaestus-cli"]);
/** Capabilities the host actually provides. `requires.tools` is valid only inside this set. */
const HOST_CAPABILITIES = new Set(["browser", "computer-use", "agent-routing", "time", "data", "custom"]);
const TOOL_KINDS = new Set(["stdio", "builtin", "http"]);
/** §2.4 — three executable forms. Unifying them makes one of them lose its guarantee. */
const TOOL_FORMS = new Set(["materialized", "inline", "provisioned"]);
const IMPLICIT = new Set(["never", "router", "always"]);
const CATEGORIES = new Set(["design", "dev", "data", "web", "productivity", "communication", "custom"]);
/** node's process.platform values — "win64" and "macos" are not among them. */
const OS_VALUES = new Set(["darwin", "win32", "linux"]);
const PREREQ_PROVIDERS = new Set(["app", "user", "os"]);

const HOST_CHANNEL_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const UPSTREAM_RESOLUTION = "host-injected-at-materialize";
const UPSTREAM_ON_MISSING = "fail-loud";

/** A skill claiming outputs must say what verifies the claim (G7). */
const OUTPUT_CLAIM_RE = /^#{1,3}\s*Outputs\b/im;
const VERIFICATION_RE = /^#{1,3}\s*Verification\b/im;

const SECRET_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.p12|.*credentials.*|.*secret.*)$/i;

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function checkPackage(dir) {
  const v = [];
  const fail = (gate, msg) => v.push(`${gate}: ${msg}`);
  const manifestPath = path.join(dir, "plugin.json");
  if (!fs.existsSync(manifestPath)) return [`G0: no plugin.json in ${dir}`];

  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return [`G0: plugin.json failed to parse — ${e.message}`];
  }

  // ── schema basics ──────────────────────────────────────────
  if (m.schema !== SCHEMA) fail("G0", `schema is not "${SCHEMA}" (got ${m.schema})`);
  if (!SLUG_RE.test(m.slug || "")) fail("G0", `slug violates [a-z0-9][a-z0-9-]{1,63} (got ${m.slug})`);
  if (path.basename(dir) !== m.slug) fail("G0", `directory name (${path.basename(dir)}) != slug (${m.slug})`);
  if (!SEMVER_RE.test(m.version || "")) fail("G0", `version is not semver (got ${m.version})`);
  if (m.invocation?.implicit && !IMPLICIT.has(m.invocation.implicit)) {
    fail("G0", `invocation.implicit must be never|router|always (got ${m.invocation.implicit})`);
  }

  const files = walk(dir);
  const provides = m.provides || {};
  const tools = Array.isArray(provides.tools) ? provides.tools : [];
  const skills = provides.skills || null;

  // ── G1: provides is non-empty ──────────────────────────────
  if (!tools.length && !skills) fail("G1", "provides is empty — a name-only plugin cannot be installed");

  // ── G2: router exists and carries a description ────────────
  if (skills) {
    const routerRel = skills.router || "skills/index/SKILL.md";
    const routerAbs = path.join(dir, routerRel);
    if (!fs.existsSync(routerAbs)) {
      fail("G2", `router not found (${routerRel})`);
    } else {
      const fm = frontmatter(fs.readFileSync(routerAbs, "utf8"));
      if (!fm) fail("G2", `router has no frontmatter (${routerRel})`);
      else if (!fm.description) fail("G2", "router frontmatter.description is empty — nothing will ever open this plugin");
    }
    for (const w of skills.workflows || []) {
      if (!fs.existsSync(path.join(dir, "skills", w, "SKILL.md"))) {
        fail("G2", `workflows declares skills/${w}/SKILL.md, which does not exist`);
      }
    }
  }

  // ── G3 / G7: skill bodies ──────────────────────────────────
  const skillFiles = files.filter((f) => f.startsWith("skills/") && f.endsWith("SKILL.md"));
  const skillNames = new Set(skillFiles.map((f) => f.split("/")[1]));
  const refNames = new Set(
    files.filter((f) => f.startsWith("references/") && f.endsWith(".md")).map((f) => path.basename(f, ".md")),
  );
  for (const rel of skillFiles) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    for (const ref of text.matchAll(/\$([a-z][a-z0-9-]*)/g)) {
      if (!skillNames.has(ref[1]) && !refNames.has(ref[1])) {
        fail("G3", `${rel}: $${ref[1]} does not resolve to a real skill or reference`);
      }
    }
    if (OUTPUT_CLAIM_RE.test(text) && !VERIFICATION_RE.test(text)) {
      fail("G7", `${rel} claims Outputs but has no Verification section`);
    }
  }

  // ── G4: integrity (builtin is vouched for by the signed app bundle) ──
  if (!m.builtin) {
    const declared = new Set((m.integrity?.files || []).map((f) => f.path));
    if (!declared.size) fail("G4", "integrity.files is missing (required for non-builtin packages)");
    for (const f of files) {
      if (f === "plugin.json" || f.startsWith(".")) continue;
      if (!declared.has(f)) fail("G4", `file not covered by integrity: ${f}`);
    }
  }

  // ── G5: credentials ────────────────────────────────────────
  for (const t of tools) {
    for (const k of t.envKeys || []) {
      if (typeof k !== "string") fail("G5", `${t.id}: envKeys holds names as strings only`);
      else if (/[=:]/.test(k)) fail("G5", `${t.id}: envKeys carries a value (${k})`);
    }
  }
  for (const f of files) if (SECRET_FILE_RE.test(f)) fail("G5", `credential-looking file in package: ${f}`);

  // ── G6: requires.tools capabilities exist ──────────────────
  for (const cap of m.requires?.tools || []) {
    if (!HOST_CAPABILITIES.has(cap)) fail("G6", `requires.tools "${cap}" is not a host capability`);
  }

  // ── G8: .state/ is not shipped ─────────────────────────────
  if (files.some((f) => f.startsWith(".state/"))) fail("G8", ".state/ is in the distribution package — it would overwrite user data");

  // ── G9..G14: per-tool ──────────────────────────────────────
  for (const t of tools) {
    const id = t.id || "<no id>";
    if (!t.id) fail("G9", "a tools[] entry has no id");
    if (!TOOL_KINDS.has(t.kind)) fail("G9", `${id}: kind must be stdio|builtin|http (got ${t.kind})`);
    if (!HOST_CAPABILITIES.has(t.capability)) fail("G9", `${id}: capability "${t.capability}" is not a host capability`);
    if (t.kind === "builtin") {
      if (!m.builtin) fail("G9", `${id}: kind="builtin" is allowed only inside a builtin:true package`);
      if (!HOST_RESOLVERS.has(t.resolver)) fail("G9", `${id}: resolver "${t.resolver}" is not in the host's closed list`);
    }
    if (t.kind === "stdio" && !t.command) fail("G9", `${id}: kind="stdio" without a command`);
    if (t.kind === "http" && !t.url) fail("G9", `${id}: kind="http" without a url`);

    // G10: a builtin must state its executable form (§2.4)
    if (t.kind === "builtin") {
      if (!TOOL_FORMS.has(t.form)) {
        fail("G10", `${id}: kind="builtin" must declare form as materialized|inline|provisioned (got ${t.form})`);
      }
      // G11: materialized needs a contract version (INV-7)
      if (t.form === "materialized" && !Number.isInteger(t.contract)) {
        fail("G11", `${id}: form="materialized" needs an integer contract — without it a downgrade cannot be refused`);
      }
      // G11: provisioned must name who puts it there (two-writer runtime home)
      if (t.form === "provisioned" && !t.provisionedBy) {
        fail("G11", `${id}: form="provisioned" needs provisionedBy — the runtime home is written by an installer and an updater`);
      }
      // INV-1: for the inline form, the absence of a disk path IS the guarantee
      if (t.form === "inline" && (t.command || t.args || t.upstream)) {
        fail("G10", `${id}: form="inline" carries no command/args/upstream — that would break the argv-inline guarantee`);
      }
    }

    // G12: upstream resolution (INV-8)
    if (t.upstream) {
      if (t.upstream.resolution !== UPSTREAM_RESOLUTION) {
        fail("G12", `${id}: upstream.resolution must be "${UPSTREAM_RESOLUTION}" — resolving at run time causes version drift`);
      }
      if (t.upstream.onMissing !== UPSTREAM_ON_MISSING) {
        fail("G12", `${id}: upstream.onMissing must be "${UPSTREAM_ON_MISSING}" — a missing upstream must not pass quietly`);
      }
      if (!t.upstream.package) fail("G12", `${id}: upstream.package is missing`);
    }

    // G13: gate and recipes (INV-9)
    if (t.gate !== undefined) {
      if (!m.builtin) fail("G13", `${id}: gate may be declared only in a builtin:true package`);
      if (typeof t.gate !== "string" || t.gate.includes("/") || path.isAbsolute(String(t.gate))) {
        fail("G13", `${id}: gate is a gate name, not a path — the host injects the approval channel`);
      }
    }
    if (t.recipes !== undefined && !m.builtin) {
      fail("G13", `${id}: recipes may be declared only in a builtin:true package`);
    }

    // G16: host-injected capability channels (§2.9)
    if (t.hostChannels !== undefined) {
      if (!m.builtin) fail("G16", `${id}: hostChannels may be declared only in a builtin:true package`);
      if (!Array.isArray(t.hostChannels)) {
        fail("G16", `${id}: hostChannels must be an array`);
      } else {
        for (const ch of t.hostChannels) {
          if (!ch || typeof ch !== "object") { fail("G16", `${id}: a hostChannels entry is not an object`); continue; }
          if (!ch.id) fail("G16", `${id}: a hostChannels entry has no id`);
          if (!HOST_CHANNEL_ENV_RE.test(String(ch.env || ""))) {
            fail("G16", `${id}: hostChannels.env must be an env var NAME (got ${JSON.stringify(ch.env)})`);
          }
          if (String(ch.env || "").includes("/") || path.isAbsolute(String(ch.env || ""))) {
            fail("G16", `${id}: hostChannels.env carries a path — the host decides the path, the manifest names the variable`);
          }
          if (ch.mode !== "read-only") {
            fail("G16", `${id}: hostChannels.mode must be "read-only" (got ${ch.mode})`);
          }
          if (ch.path || ch.value) fail("G16", `${id}: hostChannels must not carry a path or value`);
        }
      }
    }

    // G14: per-tool surface — the host builds the catalog row from it (§2.8)
    const s = t.surface;
    if (!s || typeof s !== "object") {
      fail("G14", `${id}: no surface — the host cannot build a catalog row without one`);
    } else {
      for (const field of ["name", "description", "brandColor", "mark"]) {
        if (!s[field]) fail("G14", `${id}: surface.${field} is missing`);
      }
      if (!CATEGORIES.has(s.category)) fail("G14", `${id}: surface.category "${s.category}" is not a known category`);
      if (s.mark && String(s.mark).length > 2) fail("G14", `${id}: surface.mark is a 1-2 character monogram (got "${s.mark}")`);
      if (s.brandColor && !/^#[0-9a-fA-F]{6}$/.test(s.brandColor)) fail("G14", `${id}: surface.brandColor must be #RRGGBB (got ${s.brandColor})`);
    }
  }

  // ── G15: requires.os / requires.prereq shape ───────────────
  // Authored by hand or by a model, these two drift into plausible-looking wrong
  // values ("win64", a bare string prereq). They are declarations the host acts on.
  for (const os of m.requires?.os || []) {
    if (!OS_VALUES.has(os)) fail("G15", `requires.os "${os}" is not a process.platform value (darwin|win32|linux)`);
  }
  for (const p of m.requires?.prereq || []) {
    if (typeof p !== "object" || p === null) {
      fail("G15", `requires.prereq entries are objects, not strings (got ${JSON.stringify(p)})`);
      continue;
    }
    if (!p.id) fail("G15", "a requires.prereq entry has no id");
    if (!PREREQ_PROVIDERS.has(p["provided-by"])) {
      fail("G15", `prereq "${p.id}": provided-by must be app|user|os (got ${p["provided-by"]}) — the host has to know who supplies it`);
    }
  }

  return v;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = args.length
    ? args
    : fs.readdirSync("plugins", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join("plugins", e.name));

  let failed = 0;
  for (const dir of dirs) {
    const v = checkPackage(dir);
    if (v.length) {
      failed += v.length;
      console.log(`FAIL ${dir}`);
      for (const line of v) console.log(`  · ${line}`);
    } else {
      console.log(`PASS ${dir}`);
    }
  }
  console.log(failed ? `\n${failed} violation(s)` : `\nall ${dirs.length} package(s) passed`);
  process.exit(failed ? 1 : 0);
}

main();
