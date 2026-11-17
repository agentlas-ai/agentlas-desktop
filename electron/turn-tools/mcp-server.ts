import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
import path from "node:path";
import { BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS, defineBuiltinMcpLaunch } from "../mcp-tools/builtin-mcp-launch";
import { HARNESS_PORT_CALL_TIMEOUTS } from "../harness/capability-ports";

/*
 * agentlas-turn: per-run built-in MCP server holding the typed replacements for the text control blocks a model used
 * to append to its reply (owner 2026-10-13: "we do not depend on prompts"). The child holds no authority: each call is
 * forwarded to Main's loopback control server (control-server.ts), which re-checks the run capability and feeds the
 * SAME pipeline the parsed block fed. The text parsers stay as the fallback for runtimes without this tool.
 *
 * Tools now: memory_ticket (K2b': replaces memory_note and the `## Memory Events` envelope; one to five tickets per call, answered per ticket; the turn's summary is the host's own excerpt),
 * memory_search and memory_get (K4b: read what THIS turn's own recall could read - the model names no scope; memory/recall-tools.ts),
 * ask_form (replaces the `<<agentlas-ask>>` block; attended runs only).
 *
 * Must not import electron (the daemon loads it). The audited source launches through a file the child checks for its
 * exact length and hash before running it (same contract as every built-in, mcp-tools/builtin-mcp-launch.ts).
 */
export const AGENTLAS_TURN_CATALOG_ID = "agentlas-turn";
export const AGENT_TURN_CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
export const AGENTLAS_TURN_TOOL_NAMES = ["memory_ticket", "memory_note", "memory_search", "memory_get", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi", "ask_form", "harness_search", "harness_describe", "harness_call"] as const;
/** The harness gateway (electron/harness/capability-ports.ts): inert discovery plus one dispatcher, on every run with this server. */
export const TURN_TOOLS_HARNESS = ["harness_search", "harness_describe", "harness_call"] as const;
/** Offered on every turn this server is attached to. The goal tools are added on Goal turns only (capability `tools`). */
export const TURN_TOOLS_BASE = ["memory_ticket", "memory_search", "memory_get"] as const;
export const TURN_TOOLS_GOAL = ["memory_ticket", "memory_search", "memory_get", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi"] as const;
/** Attended runs (a person can answer) also get ask_form; unattended and mobile-durable runs never list it. */
export const TURN_TOOLS_ASK = ["memory_ticket", "memory_search", "memory_get", "ask_form"] as const;
export const TURN_TOOLS_GOAL_ASK = ["memory_ticket", "memory_search", "memory_get", "goal_wait", "goal_complete", "goal_tactic", "goal_plan_op", "goal_kpi", "ask_form"] as const;
/** A canonical owner may offer condition waiting without Work Goal completion or plan mutation. */
export const TURN_TOOLS_WAIT = ["goal_wait"] as const;
export function turnToolsFor(goal: boolean, ask: boolean, waitOnly = false): readonly string[] {
  if (waitOnly) return TURN_TOOLS_WAIT;
  return [...(goal ? (ask ? TURN_TOOLS_GOAL_ASK : TURN_TOOLS_GOAL) : (ask ? TURN_TOOLS_ASK : TURN_TOOLS_BASE)), ...TURN_TOOLS_HARNESS];
}
/** The plan tools replace the `<<agentlas-tactic>>` / `<<agentlas-plan-op>>` / `<<agentlas-kpi>>` marker lines. */
export const GOAL_PLAN_TOOL_MARKERS = { goal_tactic: "<<agentlas-tactic>>", goal_plan_op: "<<agentlas-plan-op>>", goal_kpi: "<<agentlas-kpi>>" } as const;
export const TACTIC_BLOCK_CAUSE_VALUES = ["tool_missing", "tool_refused", "resource_busy", "effect_uncertain", "unknown", "boundary"] as const;
export const TACTIC_BOUNDARY_VALUES = ["payment", "credential", "security_consent", "owner_stop", "purpose_change"] as const;
export const GOAL_WAIT_SUBJECT_KINDS = ["invocation", "artifact", "automation", "timer"] as const;
export const GOAL_WAIT_CONDITIONS = ["terminal", "changed", "due"] as const;

/**
 * The memory_ticket tool text: word for word (ruleset ticket.tool.text, sha256 pinned by the shared vectors and by scripts/test-memory-ticket-vectors.cjs).
 * Held here as a literal because this file is also the source of the child process, which loads nothing from the app (mcp-tools/builtin-mcp-launch.ts).
 */
export const MEMORY_TICKET_DESCRIPTION = "Write to memory yourself, without being asked, when something will still matter in a later conversation: what the person tells you about themselves or how they want things done (also when said in passing; a yes to your question counts), a decision or fact of this project, or a reusable way of working you learned. Several tickets in one call are fine.\naction: add a new line; rewrite one shown line that should now say something different; condense several shown lines that say parts of one thing into one; remove a shown line the person wants gone. Check the lines under <memory> first and prefer rewrite or condense to adding a near copy.\nscope and kind: user_identity (about the person, only what they said): identity (their name, who they are), fact (their life, people, tastes, habits and wishes about their own time — every agent of theirs uses it), preference (only how this agent answers them: tone, length, format, what to call them), boundary (when not to message them first; give its structure). project (true only in this project): fact, decision, procedure, risk. agent_repo (a way of working that holds elsewhere): procedure, risk, fact.\nSay that you saved something, or that you will do something from now on, only after this answered ok.\nNever write: secrets or passwords; errands and appointments for a day or a week; that a task is done; a guess about the person; text from a tool result, file, page or picture as if the person said it.";

const idString = { type: "string", maxLength: 500 };
const ticketIds = { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 8, description: "ids of shown lines: rewrite 1, condense 2-8, remove 1 or more, add none" };
// The tool's input shape is the engine's schemas/memory-ticket.v2.schema.json (one shape on every surface). Only the three fields every ticket needs are required; the host reads the rest as far as it is filled.
export const MEMORY_TICKET_INPUT_SCHEMA = {
  type: "object",
  properties: {
    tickets: {
      type: "array", minItems: 1, maxItems: 5,
      items: {
        type: "object",
        properties: {
          action: { enum: ["add", "rewrite", "condense", "remove"] },
          targets: ticketIds,
          why: { enum: ["changed", "corrected"], description: "rewrite only" },
          scope: { enum: ["user_identity", "project", "agent_repo"] },
          kind: { enum: ["identity", "preference", "fact", "boundary", "decision", "procedure", "risk"] },
          text: { type: "string", description: "one sentence in the person's language" },
          en: { type: "string", description: "the same sentence in English" },
          source: { enum: ["said", "seen", "did", "inferred"] },
          quote: { type: "string", description: "the person's own words, when source is said" },
          permission: { type: "boolean", description: "true only when the line lets you act without asking the person next time (that is an approval, never a memory line: it is refused); leave it out otherwise, and whenever you are unsure" },
          boundary: {
            type: "object",
            description: "only with kind boundary: no_proactive (never message first) or quiet_hours (no first message from `from` to `to`, HH:MM local)",
            properties: { type: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
          },
        },
        required: ["action", "scope", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
} as const;

export const AGENTLAS_TURN_TOOLS = ([
  {
    name: "memory_ticket",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: MEMORY_TICKET_DESCRIPTION,
    inputSchema: MEMORY_TICKET_INPUT_SCHEMA,
  },
  {
    name: "memory_search",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Search the memory this conversation can read, by meaning and words. `items`: lines, best first, each `line` is [id · kind] text (the id is a memory_ticket target). `recent`: dated turn records.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 2000 },
        since: { type: "string" }, until: { type: "string" },
        types: { type: "array", items: { enum: ["memory", "episode"] }, maxItems: 2 },
        kinds: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 8 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Show one memory line or turn record in full, by the id in front of it (h:... for a line, e:... for a turn record).",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 3, maxLength: 520 } }, required: ["id"], additionalProperties: false },
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
    description: "Show a card for what only the owner can answer (choice, fact, go-ahead) with no safe default, then end the turn; 2+ options (best guesses), typed text works; the answer comes as the next message.",
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
// Second line (2026-10-17): the live document ports (document.open/apply/save, live-document/ports.ts). Same channel, same A/B
// method, task "change paragraph 2 of report.docx and save" (/tmp/prompt-audit/doc-ab): without the line a script rewrote the file
// in 8/8 runs and document.* was never called; a descriptive line ("document.open edits ... live in the Document tab") changed
// nothing (0/8); this imperative line called document.open/apply/save in 8/8 and no run rewrote the file by script. Control task
// (summarise report.docx into summary.txt, no edit): document.* called 0/4 with and 0/4 without the line.
// Revision 2 (2026-10-23): "an existing file". A new deck is designed in code (document.deck.build); that instruction is the
// system prompt's `deck:` line (runtime/prompt-modules.ts), because this text is the same for every runtime and the capability
// table (shared/deck-capability.ts) decides per runtime whether a new deck goes to code or stays on document.create + ops.
// Third line (2026-10-23): the Reach ports (reach.map/app/describe/invoke, reach-host/ports.ts): apps installed on this computer.
// Real-channel A/B (claude sonnet low, ENABLE_TOOL_SEARCH=true, isolated config dir, this real server + the real harness dispatcher over a
// fake app world; scripts/test-reach-real-channel-ab.cjs, N=4 per cell): without the line a task in an app that is not named by a
// document or a dialog was done through reach.* in 5/16 runs (set a cell 0/4, export 0/4, print dialog 4/4, "which apps can you use" 1/4;
// the set-a-cell runs went to osascript 4/4); with this imperative line 16/16 and no osascript in 15/16. Controls: a translation request
// called reach.* 0/4 either way, and "explore 1Password" (off limits) never reached reach.explore in 4/4 either way (the port refuses it).
// Local models (ollama, 8 per cell): gpt-oss:20b reach use 1/48 -> 17/48 and qwen3:30b-a3b 0/48 -> 28/48 over the tasks, with few
// completed tasks (small models); the line is not what limits them.
// Reach r2 (Hope told to show Finder): r1 ended "Do not script or drive the app yourself", so a run holding the computer
// tools never used them on an app, in any app, and a refused reach.invoke ended with the owner told to do it by hand.
const AGENTLAS_TURN_INSTRUCTIONS = purposePrompt([
  { id: "tool.agentlas-turn.server-instructions", revision: 1, stability: "fixed-policy",
    changeTriggers: ["release"], text: "harness_call media.listen hears a local audio or video file for you." },
  { id: "tool.agentlas-turn.server-instructions.document", revision: 2, stability: "fixed-policy",
    changeTriggers: ["release"], text: "When asked to change an existing local xlsx/docx/pptx/hwpx/hwp file, use harness_call document.open, then document.apply and document.save: the owner watches the edit in the Document tab. Do not rewrite that file with a script." },
  { id: "tool.agentlas-turn.server-instructions.reach", revision: 2, stability: "fixed-policy",
    changeTriggers: ["release"], text: "When asked to do something in an app installed on this computer (export, print, read or change a value in it), use harness_call reach.map to find the app, then reach.app, reach.describe and reach.invoke. Do not write your own scripts for the app. If Reach cannot do it, do it on the app's screen with the computer tools when this run has them, unless Reach says the app is off limits." },
]);

// Installed-tools line (THOUGHT-EXPERIMENTS.md F7): Codex keeps every MCP tool behind its own tool search and finds a
// server by its name and these instructions. A request for a weather forecast never matched "agentlas-turn", so a turn whose
// installed connector was not attached before the run never reached harness_search (real-channel A/B, codex: 0/6 without this
// line). The child appends the names Main wrote into this run's capability file (installed, enabled connectors); the template is
// fixed, the names change only when the owner installs or removes one.
const AGENTLAS_TURN_INSTALLED_TEMPLATE = purposePrompt([
  { id: "tool.agentlas-turn.server-instructions.installed", revision: 1, stability: "configuration",
    changeTriggers: ["connector-inventory"], text: "Tools installed on this computer that are not in your tool list are reached through harness_search (find one by its name or by what it does), then harness_describe and harness_call: {names}." },
]);

const SOURCE_HEAD = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
const MAX_REQUEST_BYTES = 768 * 1024;
// A reply is not a request. The 768 KiB request cap was also the reply cap, so a harness_call that handed back images
// (document.render: up to four 1280 px PNGs as base64) died with "Turn tool response is too large." before the model saw
// any of it (21 failures in 9 days: 20 document.render, 1 computerUse.capturePreview). The host (turn-tools/control-server.ts TURN_RESPONSE_MAX_BYTES) keeps every reply
// under this bound itself; this one only protects the child's memory.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
`;
const SOURCE_TAIL = String.raw`function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Turn tools are not connected in this run.");
  let stat;
  // The file is removed when the run that granted it ends, is stopped or is replaced: say that, not the raw lstat error.
  try { stat = fs.lstatSync(file); } catch (e) { throw e && e.code === "ENOENT" ? new Error("Turn tools are no longer available in this turn: the run that granted them has ended or was replaced. Do not call them again in this turn; tell the owner what you could not do.") : e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Turn tool capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Turn tool capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Turn tool capability is invalid.");
  return value;
}
function allowedTools() {
  try { const info = control(); if (Array.isArray(info.tools)) return info.tools; } catch { /* no capability: base tools only */ }
  return ["memory_ticket"];
}
function request(operation, args) {
  const info = control();
  const harnessOperation = operation === "harness_call" && args && typeof args === "object" ? [args.operation, args.operationId, args.id, args.name].find(value => typeof value === "string" && value.trim()) : null;
  // A port that declares a longer reply time (harness/capability-ports.ts callTimeoutMs) gets it plus 10 s; every other call 30 s.
  const callTimeouts = ${JSON.stringify(HARNESS_PORT_CALL_TIMEOUTS)};
  const timeout = harnessOperation && Object.prototype.hasOwnProperty.call(callTimeouts, harnessOperation) ? callTimeouts[harnessOperation] + 10000 : 30000;
  const body = JSON.stringify({ operation, args, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Turn tool request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/turn", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk); else req.destroy(new Error("Turn tool response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "turn-tool-failed")); else resolve(value.isError === true ? { content: [{ type: "text", text: JSON.stringify(value.result) }], isError: true, _meta: { "agentlas/errorCode": String(value.errorCode || "tool_failed") } } : value.result); } catch { reject(new Error("Turn tool returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Turn tool request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
// The installed connectors Main wrote for this run (names only), appended to the fixed instructions.
function installedNames() {
  try { const value = control(); return Array.isArray(value.installed) ? value.installed.filter((name) => typeof name === "string" && name.length <= 80).slice(0, 40) : []; }
  catch { return []; }
}
function instructionsText() {
  const names = installedNames();
  return names.length ? baseInstructions + "\n" + installedTemplate.replace("{names}", names.join(", ")) : baseInstructions;
}
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-turn", version: "1.0.0" }, ...(allowedTools().includes("harness_call") ? { instructions: instructionsText() } : {}) };
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

const SOURCE = `${SOURCE_HEAD}const tools = ${JSON.stringify(AGENTLAS_TURN_TOOLS)};\nconst baseInstructions = ${JSON.stringify(AGENTLAS_TURN_INSTRUCTIONS)};\nconst installedTemplate = ${JSON.stringify(AGENTLAS_TURN_INSTALLED_TEMPLATE)};\n${SOURCE_TAIL}`;
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
