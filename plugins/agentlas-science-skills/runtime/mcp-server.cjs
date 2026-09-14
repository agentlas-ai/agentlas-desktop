#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const { PLUGIN_VERSION, SkillError, skillsHere, findSkill, openSkill, listSkills } = require("./skills.cjs");

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

async function callTool(name, args) {
  if (name === "scientific_procedures_here") return toolResult(skillsHere(args));
  if (name === "find_scientific_skill") return toolResult(findSkill(args));
  if (name === "open_scientific_skill") return toolResult(openSkill(args));
  if (name === "list_scientific_skills") return toolResult(listSkills(args));
  throw new SkillError("science-skill-tool-not-found", `Unknown scientific-skills tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-science-skills", version: PLUGIN_VERSION } };
  }
  if (message.method === "tools/list") return { tools: toolCatalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments);
  throw new SkillError("science-skill-method-not-found", `Unknown method: ${message.method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  try {
    const result = await handle(message);
    if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    if (message.id !== undefined) {
      const code = error instanceof SkillError ? error.code : "science-skill-failed";
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `${code}: ${error.message}` } })}\n`);
    }
  }
});
