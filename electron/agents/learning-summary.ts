import { inspectAgentFileText, listAgentFiles } from "./files";
import { getExperienceOntologySummary } from "../experience/store";
import { getAgentById } from "../mcp/registry";
import { getDb } from "../store/db";
import type { AgentLearningSummary } from "../../shared/types";

const TERMINAL_KINDS = [
  "mcp_final",
  "mcp_error",
  "invoke_completed",
  "invoke_failed",
  "invoke_cancelled",
  "invoke_threw",
] as const;

function countMemoryMarkdownItems(agentId: string): number {
  let content = "";
  try {
    const snapshot = inspectAgentFileText(agentId, "memory.md");
    if (!snapshot.exists) return 0;
    content = snapshot.content;
  } catch {
    return 0;
  }
  let inKnownSection = false;
  let fence: "`" | "~" | null = null;
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (marker) {
      const next = marker[1][0] as "`" | "~";
      fence = fence === next ? null : fence ? fence : next;
      continue;
    }
    if (fence) continue;
    if (/^##(?!#)\s+/.test(trimmed)) {
      inKnownSection = /^##\s+(?:decisions?|의사결정|결정\s*사항|gotchas?|주의\s*사항|open(?:\s+questions?)?|미결(?:\s+(?:과제|항목|질문))?)\s*$/i.test(trimmed);
      continue;
    }
    if (inKnownSection && /^-\s+\S/.test(trimmed)) count += 1;
  }
  return count;
}

function scalar(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...params) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

interface CurationAggregateRow {
  turns?: number;
  no_new?: number;
  events?: number;
  written?: number;
  deduped?: number;
  redacted?: number;
  session_only?: number;
  discarded?: number;
}

interface LegacyChatLinkedAggregate {
  runs: number;
  last: string | null;
  failures: number;
}

/**
 * Older ledgers did not persist run_events.agent_id. Preserve that fact instead
 * of rewriting history: an event can be shown as related chat activity only
 * when its chat still has one exact installed-agent owner and the same run has
 * no direct executor attribution or conflicting chat owner.
 */
function legacyChatLinkedAggregate(agentId: string): LegacyChatLinkedAggregate {
  const terminals = TERMINAL_KINDS.map(() => "?").join(",");
  const runRow = getDb().prepare(
    `WITH eligible AS (
       SELECT e.run_id, MAX(e.ts) AS last
         FROM run_events e
         JOIN chats c ON c.id = e.chat_id
        WHERE e.agent_id IS NULL
          AND c.agent_id = ?
          AND e.kind IN (${terminals})
          AND NOT EXISTS (
                SELECT 1 FROM run_events direct
                 WHERE direct.run_id = e.run_id AND direct.agent_id IS NOT NULL
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM run_events sibling
                  JOIN chats sibling_chat ON sibling_chat.id = sibling.chat_id
                 WHERE sibling.run_id = e.run_id AND sibling_chat.agent_id <> ?
              )
        GROUP BY e.run_id
     )
     SELECT COUNT(*) AS runs, MAX(last) AS last FROM eligible`,
  ).get(agentId, ...TERMINAL_KINDS, agentId) as { runs?: number; last?: string | null } | undefined;
  const failureRow = getDb().prepare(
    `SELECT COUNT(DISTINCT COALESCE(f.run_id, f.id)) AS n
       FROM failure_events f
       JOIN chats c ON c.id = f.chat_id
      WHERE f.agent_id IS NULL
        AND c.agent_id = ?
        AND NOT EXISTS (
              SELECT 1 FROM failure_events direct
               WHERE COALESCE(direct.run_id, direct.id) = COALESCE(f.run_id, f.id)
                 AND direct.agent_id IS NOT NULL
            )
        AND NOT EXISTS (
              SELECT 1 FROM run_events direct_run
               WHERE f.run_id IS NOT NULL
                 AND direct_run.run_id = f.run_id
                 AND direct_run.agent_id IS NOT NULL
            )`,
  ).get(agentId) as { n?: number } | undefined;
  return {
    runs: Number(runRow?.runs ?? 0),
    last: runRow?.last ?? null,
    failures: Number(failureRow?.n ?? 0),
  };
}

function curationAggregate(agentId: string): Required<CurationAggregateRow> {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS turns,
            SUM(CASE WHEN COALESCE(CAST(json_extract(payload_json, '$.written') AS INTEGER), 0) = 0 THEN 1 ELSE 0 END) AS no_new,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.memoryEventCount') AS INTEGER), 0)) AS events,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.written') AS INTEGER), 0)) AS written,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.deduped') AS INTEGER), 0)) AS deduped,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.redacted') AS INTEGER), 0)) AS redacted,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.sessionOnly') AS INTEGER), 0)) AS session_only,
            SUM(COALESCE(CAST(json_extract(payload_json, '$.discarded') AS INTEGER), 0)) AS discarded
       FROM run_events
      WHERE agent_id = ? AND kind = 'memory_curation' AND json_valid(payload_json)`,
  ).get(agentId) as CurationAggregateRow | undefined;
  return {
    turns: Number(row?.turns ?? 0),
    no_new: Number(row?.no_new ?? 0),
    events: Number(row?.events ?? 0),
    written: Number(row?.written ?? 0),
    deduped: Number(row?.deduped ?? 0),
    redacted: Number(row?.redacted ?? 0),
    session_only: Number(row?.session_only ?? 0),
    discarded: Number(row?.discarded ?? 0),
  };
}

export async function getAgentLearningSummary(agentIdValue: string): Promise<AgentLearningSummary> {
  const agentId = String(agentIdValue ?? "").trim();
  if (!agentId || agentId.length > 256 || !getAgentById(agentId)) throw new Error("Installed agent not found.");
  const terminals = TERMINAL_KINDS.map(() => "?").join(",");
  const runRow = getDb().prepare(
    `SELECT COUNT(DISTINCT run_id) AS n, MAX(ts) AS last
       FROM run_events
      WHERE agent_id = ? AND kind IN (${terminals})`,
  ).get(agentId, ...TERMINAL_KINDS) as { n?: number; last?: string | null } | undefined;
  const legacyChatLinked = legacyChatLinkedAggregate(agentId);
  const unattributed = scalar(
    `SELECT COUNT(*) AS n FROM (
       SELECT COALESCE(run_id, id) AS identity
         FROM run_events
        WHERE agent_id IS NULL AND kind IN (${terminals})
          AND NOT EXISTS (SELECT 1 FROM chats WHERE chats.id = run_events.chat_id)
       UNION
       SELECT COALESCE(run_id, id) AS identity
         FROM failure_events
        WHERE agent_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM chats WHERE chats.id = failure_events.chat_id)
     )`,
    ...TERMINAL_KINDS,
  );
  const listing = await listAgentFiles(agentId).catch(() => ({ entries: [] }));
  const ontology = getExperienceOntologySummary(agentId);
  const curation = curationAggregate(agentId);
  return {
    agentId,
    runCount: Number(runRow?.n ?? 0),
    lastRunAt: runRow?.last ?? null,
    legacyChatLinkedRunCount: legacyChatLinked.runs,
    legacyChatLinkedLastRunAt: legacyChatLinked.last,
    legacyChatLinkedFailureCount: legacyChatLinked.failures,
    durableMemoryCount: scalar(
      "SELECT COUNT(*) AS n FROM memory_entries WHERE agent_id = ? AND superseded_at IS NULL",
      agentId,
    ),
    curationTurnCount: curation.turns,
    noNewMemoryTurnCount: curation.no_new,
    memoryEventCount: curation.events,
    memoryWrittenCount: curation.written,
    memoryDedupedCount: curation.deduped,
    memoryRedactedCount: curation.redacted,
    memorySessionOnlyCount: curation.session_only,
    memoryDiscardedCount: curation.discarded,
    memoryMarkdownCount: countMemoryMarkdownItems(agentId),
    failureCount: scalar(
      "SELECT COUNT(DISTINCT COALESCE(run_id, id)) AS n FROM failure_events WHERE agent_id = ?",
      agentId,
    ),
    evolutionProposalCount: scalar("SELECT COUNT(*) AS n FROM agent_evolution_proposals WHERE agent_id = ?", agentId),
    legacyUnattributedCount: unattributed,
    localFileCount: listing.entries.filter((entry) => entry.kind === "file").length,
    localReceiptCount: ontology.localReceiptCount,
  };
}
