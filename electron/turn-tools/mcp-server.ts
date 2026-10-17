import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
import path from "node:path";
import { BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS, defineBuiltinMcpLaunch } from "../mcp-tools/builtin-mcp-launch";
import { MEMORY_KINDS, MEMORY_SCOPES } from "../architecture/manifest";

/*
 * agentlas-turn: per-run built-in MCP server holding the typed replacements for the text control blocks a model used
 * to append to its reply (owner 2026-10-13: "we do not depend on prompts"). The child holds no authority: each call is
 * forwarded to Main's loopback control server (control-server.ts), which re-checks the run capability and feeds the
 * SAME pipeline the parsed block fed. The text parsers stay as the fallback for runtimes without this tool.
 *
 * Tools now: memory_note (replaces the `## Memory Events` envelope; the per-turn receipt/turn_summary is host-built),
 * ask_form (replaces the `<<agentlas-ask>>` block; attended runs only).
 *
 * Must not import electron (the daemon loads it). The audited source launches through a file the child checks for its
 * exact length and hash before running it (same contract as every built-in, mcp-tools/builtin-mcp-launch.ts).
 */
export const AGENTLAS_TURN_CATALOG_ID = "agentlas-turn";
export const AGENT_TURN_CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
export const AGENTLAS_TURN_TOOL_NAMES = ["memory_note", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi", "ask_form", "harness_search", "harness_describe", "harness_call"] as const;
/** The harness gateway (electron/harness/capability-ports.ts): inert discovery plus one dispatcher, on every run with this server. */
export const TURN_TOOLS_HARNESS = ["harness_search", "harness_describe", "harness_call"] as const;
/** Offered on every turn this server is attached to. The goal tools are added on Goal turns only (capability `tools`). */
export const TURN_TOOLS_BASE = ["memory_note"] as const;
export const TURN_TOOLS_GOAL = ["memory_note", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi"] as const;
/** Attended runs (a person can answer) also get ask_form; unattended and mobile-durable runs never list it. */
export const TURN_TOOLS_ASK = ["memory_note", "ask_form"] as const;
export const TURN_TOOLS_GOAL_ASK = ["memory_note", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi", "ask_form"] as const;
export function turnToolsFor(goal: boolean, ask: boolean): readonly string[] {
  return [...(goal ? (ask ? TURN_TOOLS_GOAL_ASK : TURN_TOOLS_GOAL) : (ask ? TURN_TOOLS_ASK : TURN_TOOLS_BASE)), ...TURN_TOOLS_HARNESS];
}
/** The plan tools replace the `<<agentlas-tactic>>` / `<<agentlas-plan-op>>` / `<<agentlas-kpi>>` marker lines. */
export const GOAL_PLAN_TOOL_MARKERS = { goal_tactic: "<<agentlas-tactic>>", goal_plan_op: "<<agentlas-plan-op>>", goal_kpi: "<<agentlas-kpi>>" } as const;
export const TACTIC_BLOCK_CAUSE_VALUES = ["tool_missing", "tool_refused", "resource_busy", "effect_uncertain", "unknown", "boundary"] as const;
export const TACTIC_BOUNDARY_VALUES = ["payment", "credential", "security_consent", "owner_stop", "purpose_change"] as const;
export const GOAL_WAIT_SUBJECT_KINDS = ["invocation", "artifact", "automation", "timer"] as const;
export const GOAL_WAIT_CONDITIONS = ["terminal", "changed", "due"] as const;

/** Scopes the tool offers: "agent_team" is only a legacy alias the text parser still maps to team_memory. */
export const MEMORY_NOTE_SCOPES = MEMORY_SCOPES.filter((scope) => scope !== "agent_team");
const idString = { type: "string", maxLength: 500 };

// Tool definitions are prompt tokens too (owner 2026-10-13): the schema carries the enums, the host validates and
// screens; the description says only what the schema cannot.
export const MEMORY_NOTE_DESCRIPTION =
  "Save one durable learning to curated memory. content in English; owner wording in content_native; no secrets.";

export const AGENTLAS_TURN_TOOLS = ([
  {
    name: "memory_note",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: MEMORY_NOTE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 4000 },
        content_native: { type: "string", maxLength: 4000 },
        memory_kind: { type: "string", enum: [...MEMORY_KINDS] },
        suggested_scope: { type: "string", enum: [...MEMORY_NOTE_SCOPES] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        evidence: { type: "array", items: idString, maxItems: 20 },
        supersedes: { type: "string", pattern: "^h:[0-9a-f]{16}$" },
        request_context: { type: "object" },
      },
      required: ["content", "memory_kind", "suggested_scope"],
      additionalProperties: false,
    },
  },
  {
    name: "goal_wait",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Pause the Goal until an invocation ends, an artifact/automation output changes, or a time arrives; then end the turn. Observed IDs only.",
    inputSchema: {
      type: "object",
      properties: {
        subject_kind: { type: "string", enum: [...GOAL_WAIT_SUBJECT_KINDS] },
        condition: { type: "string", enum: [...GOAL_WAIT_CONDITIONS], description: "invocation=terminal, artifact/automation=changed, timer=due." },
        invocation_run_id: idString,
        chat_id: idString,
        artifact_id: idString,
        automation_id: idString,
        not_before: { type: "string", description: "Timer: future ISO timestamp." },
        next_action: { type: "string", minLength: 1, maxLength: 2000 },
        deadline: { type: "string", description: "Optional ISO timestamp." },
      },
      required: ["subject_kind", "condition", "next_action"],
      additionalProperties: false,
    },
  },
  {
    name: "goal_complete",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Declare every acceptance criterion verified; not while work remains.",
    inputSchema: {
      type: "object",
      properties: { evidence: { type: "string", maxLength: 240, description: "What was verified and where." }, summary: { type: "string", maxLength: 240 } },
      additionalProperties: false,
    },
  },
{
    name: "goal_tactic",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Report done_when proven by evidence, or a blocker. pending_host is queued; turn-end Main revalidates the current plan before applying.",
    inputSchema: {
      type: "object",
      properties: {
        id: idString,
        status: { type: "string", enum: ["done", "blocked"] },
        evidence: { type: "string", maxLength: 2000 },
        cause: { type: "string", enum: [...TACTIC_BLOCK_CAUSE_VALUES] },
        boundary: { type: "string", enum: [...TACTIC_BOUNDARY_VALUES] },
      },
      required: ["id", "status", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "goal_plan_op",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Propose a plan change within owner intent. done_when needs observable proof; prerequisites met needs verified evidence. pending_host is queued, not applied.",
    inputSchema: {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "op": {
              "const": "replace_tactic"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Exact current observed plan ID; host parser/current plan remain authoritative."
            },
            "with": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "description": {
                    "type": "string",
                    "minLength": 1
                  },
                  "done_when": {
                    "type": "string",
                    "minLength": 1
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "one_off",
                      "recurring"
                    ],
                    "description": "Absent defaults to one_off in existing parser."
                  },
                  "depends_on": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Exact current observed plan ID; host parser/current plan remain authoritative."
                    }
                  },
                  "prerequisites": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Stable identifier of this prerequisite."
                        },
                        "state": {
                          "type": "string",
                          "enum": [
                            "met",
                            "unmet",
                            "unknown"
                          ]
                        },
                        "evidence_refs": {
                          "type": "array",
                          "items": {
                            "type": "string"
                          }
                        },
                        "blocks": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "prepare",
                              "local_write",
                              "external_effect"
                            ]
                          }
                        }
                      },
                      "required": [
                        "id",
                        "state",
                        "evidence_refs",
                        "blocks"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "description",
                  "done_when"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "op",
            "id",
            "with"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "op": {
              "const": "add_tactic"
            },
            "strategy_id": {
              "type": [
                "string",
                "null"
              ]
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "done_when": {
              "type": "string",
              "minLength": 1
            },
            "kind": {
              "type": "string",
              "enum": [
                "one_off",
                "recurring"
              ],
              "description": "Absent defaults to one_off in existing parser."
            },
            "depends_on": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "description": "Exact current observed plan ID; host parser/current plan remain authoritative."
              }
            },
            "prerequisites": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Stable identifier of this prerequisite."
                  },
                  "state": {
                    "type": "string",
                    "enum": [
                      "met",
                      "unmet",
                      "unknown"
                    ]
                  },
                  "evidence_refs": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  "blocks": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "prepare",
                        "local_write",
                        "external_effect"
                      ]
                    }
                  }
                },
                "required": [
                  "id",
                  "state",
                  "evidence_refs",
                  "blocks"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "op",
            "description",
            "done_when"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "op": {
              "const": "retire_strategy"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "description": "Exact current observed plan ID; host parser/current plan remain authoritative."
            },
            "evidence": {
              "type": "string"
            }
          },
          "required": [
            "op",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "op": {
              "const": "add_strategy"
            },
            "hypothesis": {
              "type": "string",
              "minLength": 1
            },
            "serves_krs": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "kpi": {
              "type": "string"
            },
            "timebox_hours": {
              "type": "number"
            },
            "observation_window_hours": {
              "type": "number"
            },
            "actions_per_day": {
              "type": [
                "number",
                "null"
              ],
              "description": "Planner cadence target, not authority or tool/turn admission cap; only real owner boundaries constrain effects."
            },
            "tactics": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "description": {
                    "type": "string",
                    "minLength": 1
                  },
                  "done_when": {
                    "type": "string",
                    "minLength": 1
                  },
                  "kind": {
                    "type": "string",
                    "enum": [
                      "one_off",
                      "recurring"
                    ],
                    "description": "Absent defaults to one_off in existing parser."
                  },
                  "depends_on": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "description": "Exact current observed plan ID; host parser/current plan remain authoritative."
                    }
                  },
                  "prerequisites": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "description": "Stable identifier of this prerequisite."
                        },
                        "state": {
                          "type": "string",
                          "enum": [
                            "met",
                            "unmet",
                            "unknown"
                          ]
                        },
                        "evidence_refs": {
                          "type": "array",
                          "items": {
                            "type": "string"
                          }
                        },
                        "blocks": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "prepare",
                              "local_write",
                              "external_effect"
                            ]
                          }
                        }
                      },
                      "required": [
                        "id",
                        "state",
                        "evidence_refs",
                        "blocks"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "description",
                  "done_when"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "op",
            "hypothesis",
            "tactics"
          ],
          "additionalProperties": false
        }
      ],
      "description": "Full payload variants from existing shared plan parser; omitted optional values keep existing parser defaults. Existing draft truncation/text/ID/DAG rules remain host checks, not newly invented task quotas.",
      "type": "object"
    },
  },
  {
    name: "goal_kpi",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Record an actual source observation now; evidence must identify what was observed. Pending host application is not a saved KPI.",
    inputSchema: {
      "type": "object",
      "properties": {
        "kpi": {
          "type": "string",
          "minLength": 1,
          "description": "Stable KPI identifier: existing, or new with name, unit and direction."
        },
        "value": {
          "type": "number"
        },
        "observed_at": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "evidence": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "unit": {
          "type": "string"
        },
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down"
          ]
        }
      },
      "required": [
        "kpi",
        "value",
        "observed_at",
        "source",
        "evidence"
      ],
      "additionalProperties": false
    },
  },
  {
    name: "ask_form",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Show a choice card for a real fork with no safe default, then end the turn; the pick arrives as the next message.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1, maxLength: 4000 },
              header: { type: "string", maxLength: 200 },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: {
                  type: "object",
                  properties: { label: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 1000 } },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "harness_search",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Find plugins, skills, connectors, catalog tools, operations, features by words; returns ids. Inert.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 500 }, kind: { type: "string", enum: ["plugin", "skill", "connector", "tool", "operation", "feature"] } },
      additionalProperties: false,
    },
  },
  {
    name: "harness_describe",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Detail for one harness_search id: skill text+revision, plugin skills+router, connector auth state, operation fields.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 500 } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "harness_call",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Run one harness operation (skill.activate, connector.connect, auth.ensure, auth.login, plugin.enable, media.listen: hear a local audio/video file for you, ...); returns ok | refused | unavailable + reason.",
    inputSchema: { type: "object", properties: { operation: { type: "string", minLength: 1, maxLength: 100 }, args: { type: "object" } }, required: ["operation"], additionalProperties: false },
  },
] as const).map(tool => {
  purposePrompt([{ id: `tool.agentlas-turn.${tool.name}.schema`, revision: 1, stability: "fixed-policy", changeTriggers: ["release"], text: JSON.stringify(tool.inputSchema) }]);
  return { ...tool, description: purposePrompt([
  // revision 3 (2026-10-17): harness_call names media.listen. Dev replay r06 stopped before upload on the owner's "직접 청취"
  // gate with the host listening port unused; real-model A/B (claude sonnet low, codex gpt-6.1-sol; 8 runs per arm) called it
  // 8/8 with this line and 0/8 without (/tmp/prompt-audit/listen-ab).
  { id: `tool.agentlas-turn.${tool.name}.description`, revision: tool.name === "harness_call" ? 3 : 2, stability: "fixed-policy", changeTriggers: ["release"], text: tool.description },
]) };
});

// MCP server instructions: Claude Code defers MCP tool definitions (ToolSearch), so a teammate sees only the names
// harness_search/harness_describe/harness_call, never the harness_call menu. Dev replay r08 (2026-10-17): Film Production
// Director (claude-code) wrote "I cannot listen to the audio", recorded its QA as FAIL and the run uploaded nothing, with
// media.listen unused. Claude Code shows server instructions in its system prompt even when tools are deferred. Real-model
// A/B in that channel (claude sonnet low, product Claude home, ENABLE_TOOL_SEARCH=true; /tmp/prompt-audit/listen-ab2):
// media.listen was called in 0/6 runs without this line and 5/6 with it. Sent only while harness_call is one of this run's tools.
const AGENTLAS_TURN_INSTRUCTIONS = purposePrompt([{ id: "tool.agentlas-turn.server-instructions", revision: 1, stability: "fixed-policy",
  changeTriggers: ["release"], text: "harness_call media.listen hears a local audio or video file for you." }]);

const SOURCE_HEAD = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
const MAX_REQUEST_BYTES = 768 * 1024;
`;
const SOURCE_TAIL = String.raw`function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Turn tools are not connected in this run.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Turn tool capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Turn tool capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Turn tool capability is invalid.");
  return value;
}
function allowedTools() {
  try { const info = control(); if (Array.isArray(info.tools)) return info.tools; } catch { /* no capability: base tools only */ }
  return ["memory_note"];
}
function request(operation, args) {
  const info = control();
  const body = JSON.stringify({ operation, args, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Turn tool request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/turn", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 30000 }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= MAX_REQUEST_BYTES) chunks.push(chunk); else req.destroy(new Error("Turn tool response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "turn-tool-failed")); else resolve(value.isError === true ? { content: [{ type: "text", text: JSON.stringify(value.result) }], isError: true, _meta: { "agentlas/errorCode": String(value.errorCode || "tool_failed") } } : value.result); } catch { reject(new Error("Turn tool returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Turn tool request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-turn", version: "1.0.0" }, ...(allowedTools().includes("harness_call") ? { instructions } : {}) };
  if (requestValue.method === "notifications/initialized") return undefined;
  if (requestValue.method === "ping") return {};
  if (requestValue.method === "tools/list") return { tools: tools.filter((tool) => allowedTools().includes(tool.name)) };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (!tools.some((tool) => tool.name === name) || !allowedTools().includes(name)) return Promise.resolve(error("Unknown agentlas-turn tool."));
  return request(name, args);
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    const wireResult = parsed.method === "tools/call" ? (result && result.content ? result : text(result)) : result;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: wireResult }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error((err && err.message) || "turn-tool-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE = `${SOURCE_HEAD}const tools = ${JSON.stringify(AGENTLAS_TURN_TOOLS)};\nconst instructions = ${JSON.stringify(AGENTLAS_TURN_INSTRUCTIONS)};\n${SOURCE_TAIL}`;
// The source is a file the child verifies before running it (mcp-tools/builtin-mcp-launch.ts); argv stays short.
const LAUNCH = defineBuiltinMcpLaunch("agentlas-turn", SOURCE);

export function turnToolsMcpLaunchArgs(): string[] {
  return LAUNCH.launchArgs();
}

/** Gate assertion only (not part of authenticity): the launch is a fixed loader and a path, whatever the source size. */
export function turnToolsMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(turnToolsMcpLaunchArgs()).length <= BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS;
}

export function turnToolsMcpSourceDigest(): string { return LAUNCH.sourceSha256; }

/** This executable, the pinned loader, and the canonical source file holding exactly the audited source. */
export function isAuthenticTurnToolsMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  return LAUNCH.isAuthenticArgs(args);
}

export function isCanonicalTurnToolsMcpServer(server: {
  catalogId: string | null;
  configurationValid?: boolean;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  envKeys: readonly string[];
}): boolean {
  return server.catalogId === AGENTLAS_TURN_CATALOG_ID &&
    server.configurationValid !== false &&
    server.transport === "stdio" &&
    server.url === null &&
    server.envKeys.length === 0 &&
    isAuthenticTurnToolsMcpLaunch(server.command, server.args);
}
