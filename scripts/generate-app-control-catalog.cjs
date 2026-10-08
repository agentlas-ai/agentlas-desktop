#!/usr/bin/env node
"use strict";
// Generates electron/app-control/catalog.generated.ts: every request/response operation the renderer can call
// (electron/preload.ts `api`, and the Science view's electron/science-preload.ts bridge), with its IPC channel, how its parameters map onto the IPC arguments, and the
// signature and doc comment from shared/types.ts AgentlasIpc. One operates Agentlas through this same surface
// (owner 2026-10-04: "사소한 설정과 기능 심지어 사이언스도 조작이 되야"). Policy (what One may call) lives in
// electron/app-control/policy.ts, not here.
//   node scripts/generate-app-control-catalog.cjs          write the file
//   node scripts/generate-app-control-catalog.cjs --check  exit 1 when the file is stale
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const OUT = path.join(root, "electron/app-control/catalog.generated.ts");
const typesSource = fs.readFileSync(path.join(root, "shared/types.ts"), "utf8");
const types = ts.createSourceFile("types.ts", typesSource, ts.ScriptTarget.Latest, true);

const unwrap = (node) => {
  let value = node;
  for (;;) {
    if (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || ts.isSatisfiesExpression?.(value)) value = value.expression;
    // Object.freeze({...}) — the Science bridge freezes every level.
    else if (ts.isCallExpression(value) && value.expression.getText() === "Object.freeze" && value.arguments.length === 1) value = value.arguments[0];
    else return value;
  }
};

function apiObject(source, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (name === "api" && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "api" && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    // contextBridge.exposeInMainWorld("agentlasScience", Object.freeze({...}))
    if (name !== "api" && ts.isCallExpression(node) && /exposeInMainWorld$/.test(node.expression.getText(source))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) {
      const init = unwrap(node.arguments[1]);
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`${name} bridge object not found`);
  return found;
}

function invokeCall(fn, source) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "invoke" && /ipcRenderer$/.test(node.expression.expression.getText(source))) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return calls.length === 1 ? calls[0] : null;
}

// How one IPC argument is built from the bridge function's parameters. Anything else is not callable from a JSON
// argument list and is skipped (listed in the generator output).
function encodeArg(node, params, source) {
  const value = unwrap(node);
  if (ts.isIdentifier(value) && params.includes(value.text)) return { param: value.text };
  // The Science bridge sends its own extension id; Main fills it in.
  if (ts.isIdentifier(value) && value.text === "extensionId") return { extensionId: true };
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return { literal: value.text };
  if (ts.isNumericLiteral(value)) return { literal: Number(value.text) };
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return { literal: value.kind === ts.SyntaxKind.TrueKeyword };
  if (value.kind === ts.SyntaxKind.NullKeyword) return { literal: null };
  if (ts.isBinaryExpression(value) && ts.isIdentifier(value.left) && params.includes(value.left.text)) {
    if (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const fallback = encodeArg(value.right, [], source);
      return fallback ? { param: value.left.text, fallback } : null;
    }
    if (value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && value.right.kind === ts.SyntaxKind.TrueKeyword) return { param: value.left.text, isTrue: true };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const fields = [];
    for (const property of value.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const field = encodeArg(property.name, params, source);
        if (!field) return null;
        fields.push([property.name.text, field]);
      } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        const field = encodeArg(property.initializer, params, source);
        if (!field) return null;
        fields.push([property.name.text, field]);
      } else return null;
    }
    return { object: fields };
  }
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 0) return { literal: [] };
  return null;
}

const operations = [];
const skipped = [];
function walk(object, prefix, source, surface) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
    const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (!key) continue;
    const at = prefix ? `${prefix}.${key}` : key;
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : property;
    if (ts.isObjectLiteralExpression(value)) { walk(value, at, source, surface); continue; }
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value) && !ts.isMethodDeclaration(value)) continue;
    const call = invokeCall(value, source);
    if (!call) continue;
    // A bridge function that insists on a live user gesture is the owner's own act (a folder pick, an answer).
    if (/userActivation/.test(value.body.getText(source))) { skipped.push(`${at}: owner gesture`); continue; }
    const [channelArg, ...rest] = call.arguments;
    if (!channelArg || !ts.isStringLiteral(channelArg)) { skipped.push(`${at}: dynamic channel`); continue; }
    const params = value.parameters.map((parameter) => parameter.name.getText(source));
    const invokeArgs = rest.map((arg) => encodeArg(arg, params, source));
    if (invokeArgs.some((arg) => !arg)) { skipped.push(`${at}: transformed arguments`); continue; }
    operations.push({ path: at, surface, channel: channelArg.text, params, invokeArgs,
      bridgeSignature: `(${value.parameters.map((parameter) => parameter.getText(source)).join(", ")})` });
  }
}
const preloadSource = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");
const preload = ts.createSourceFile("preload.ts", preloadSource, ts.ScriptTarget.Latest, true);
walk(apiObject(preload, "api"), "", preload, "desktop");
const scienceSource = fs.readFileSync(path.join(root, "electron/science-preload.ts"), "utf8");
const science = ts.createSourceFile("science-preload.ts", scienceSource, ts.ScriptTarget.Latest, true);
walk(apiObject(science, "agentlasScience"), "science", science, "science");

// Signatures and doc comments from AgentlasIpc (best effort: an operation without a typed member keeps its names).
const typed = new Map();
function docOf(node) {
  const ranges = ts.getLeadingCommentRanges(typesSource, node.getFullStart()) ?? [];
  const text = ranges.map((range) => typesSource.slice(range.pos, range.end)).join("\n")
    .replace(/^\s*\/\*\*?|\*\/\s*$/gm, "").replace(/^\s*\*\s?/gm, "").replace(/^\s*\/\/\s?/gm, "").replace(/\s+/g, " ").trim();
  return text.slice(0, 280);
}
function walkType(members, prefix) {
  for (const member of members) {
    if (!member.name) continue;
    const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
    if (!key) continue;
    const at = prefix ? `${prefix}.${key}` : key;
    const typeNode = ts.isPropertySignature(member) ? member.type : null;
    if (typeNode && ts.isTypeLiteralNode(typeNode)) { walkType(typeNode.members, at); continue; }
    const signature = ts.isMethodSignature(member)
      ? `(${member.parameters.map((p) => p.getText(types)).join(", ")})`
      : typeNode && ts.isFunctionTypeNode(typeNode) ? `(${typeNode.parameters.map((p) => p.getText(types)).join(", ")})` : null;
    if (signature) typed.set(at, { signature: signature.replace(/\s+/g, " ").slice(0, 320), doc: docOf(member) });
  }
}
let ipcInterface = null;
ts.forEachChild(types, (node) => { if (ts.isInterfaceDeclaration(node) && node.name.text === "AgentlasIpc") ipcInterface = node; });
if (!ipcInterface) throw new Error("AgentlasIpc interface not found");
walkType(ipcInterface.members, "");
// Field names of the shared types an operation takes or returns, so "sound" finds runAlerts.set (Partial<RunAlertSettings>).
const typeFields = new Map();
ts.forEachChild(types, (node) => {
  if (ts.isInterfaceDeclaration(node)) typeFields.set(node.name.text, node.members.map((member) => member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null).filter(Boolean));
  else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) typeFields.set(node.name.text, node.type.members.map((member) => member.name && ts.isIdentifier(member.name) ? member.name.text : null).filter(Boolean));
});
function returnTypeText(path) {
  const segments = path.split(".");
  let members = ipcInterface.members;
  let found = null;
  for (const [index, segment] of segments.entries()) {
    const member = members.find((candidate) => candidate.name && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === segment);
    if (!member) return "";
    if (index === segments.length - 1) { found = member; break; }
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeLiteralNode(member.type)) return "";
    members = member.type.members;
  }
  if (!found) return "";
  if (ts.isMethodSignature(found)) return found.type ? found.type.getText(types) : "";
  return found.type && ts.isFunctionTypeNode(found.type) ? found.type.type.getText(types) : "";
}
for (const operation of operations) {
  const info = operation.surface === "desktop" ? typed.get(operation.path) : null;
  const referenced = `${info?.signature ?? ""} ${operation.surface === "desktop" ? returnTypeText(operation.path) : ""}`.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? [];
  const keywords = [...new Set(referenced.flatMap((name) => typeFields.get(name) ?? []))].slice(0, 24);
  if (keywords.length) operation.keywords = keywords;
  operation.signature = (info?.signature ?? operation.bridgeSignature).replace(/\s+/g, " ").slice(0, 320);
  operation.doc = info?.doc ?? "";
  delete operation.bridgeSignature;
}
operations.sort((a, b) => a.path.localeCompare(b.path));

const body = [
  "// Generated by scripts/generate-app-control-catalog.cjs from electron/preload.ts, electron/science-preload.ts and shared/types.ts. Do not edit.",
  "// Regenerate after changing the preload API: node scripts/generate-app-control-catalog.cjs",
  "export type AppControlInvokeArg =",
  "  | { param: string; fallback?: AppControlInvokeArg; isTrue?: true }",
  "  | { literal: string | number | boolean | null | [] }",
  "  | { extensionId: true }",
  "  | { object: Array<[string, AppControlInvokeArg]> };",
  "export interface AppControlCatalogEntry { path: string; surface: \"desktop\" | \"science\"; channel: string; params: string[]; invokeArgs: AppControlInvokeArg[]; signature: string; doc: string; keywords?: string[] }",
  `export const APP_CONTROL_CATALOG: readonly AppControlCatalogEntry[] = ${JSON.stringify(operations, null, 0)
    .replace(/\},\{"path"/g, "},\n  {\"path\"").replace(/^\[/, "[\n  ").replace(/\]$/, ",\n]")};`,
  "",
].join("\n");

const schemaCount = require("./generate-app-control-schemas.cjs").generateAppControlSchemas({ root, operations, check: process.argv.includes("--check") });

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== body) { console.error("app-control catalog is stale: run node scripts/generate-app-control-catalog.cjs"); process.exit(1); }
  console.log(`app-control catalog fresh: ${operations.length} operations, ${schemaCount} argument schemas`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`wrote ${path.relative(root, OUT)}: ${operations.length} operations, ${skipped.length} skipped (${skipped.slice(0, 6).join("; ")}${skipped.length > 6 ? "; …" : ""})`);
}
