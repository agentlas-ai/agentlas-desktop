// "Can this agent be used right now?" - the one answer every place that picks, calls or seats an agent asks (Agentlas 2.0 D6, decision).
//
// whatever the source (built here, the Hub, Agent Cloud, a local folder) an agent is used in a chat, a room or an automation only after it was given a
// character, registered on this computer and has its folder. This file is that rule as plain data and a pure function with no imports, so Main (database
// facts, `electron/agents/usability.ts`) and the screens (facts they already hold) decide with the same code. The answer is a CLOSED word, never a sentence
// read back by code: `not_registered` | `no_folder` | `archived` | `removed`.
//
// What is never refused here: the personal agent, the built-in agents (Finance and Science have a folder and no character,; the others have neither) and
// the internal rows a team keeps for its members. Their rules live in `decideUsability`, not at the callers.
// An agent that was registered before this rule and has no character stays usable: a character is a step of registering, not a condition of using (item 5).

export const AGENT_USABILITY_WHY = ["not_registered", "no_folder", "archived", "removed"] as const;
export type AgentUsabilityWhy = (typeof AGENT_USABILITY_WHY)[number];

/** The closed result word an agent's tool call (or a graph node) gets when it names an agent that is not registered: "register this first". */
export const NEEDS_REGISTRATION_CODE = "needs_registration";

/** A registered agent carries its character as the row's `tone` (`character:<id>` for a preset, `one-avatar:<id>` for an uploaded picture; agents/registration-character.ts writes it). */
export const REGISTRATION_CHARACTER_TONE = /^(character:|one-avatar:)/;
export function hasRegistrationCharacter(tone: string | null | undefined): boolean { return REGISTRATION_CHARACTER_TONE.test(tone ?? ""); }

export type AgentUsabilityRef =
  | { agentId: string }
  /** A registered agent by its slug, or a Hub/Cloud agent by the slug it has there: `source` says which listing it came from. */
  | { slug: string; source?: "local" | "hub" | "cloud" };

export interface AgentUsabilityFacts {
  /** How the caller named the agent. A vanished id is `removed`; a slug that matches no registered row was never registered. */
  refKind: "agentId" | "slug";
  slug: string | null;
  source: "local" | "hub" | "cloud";
  /** The registered row, or null. */
  row: null | {
    id: string;
    slug: string;
    /** The personal agent and every built-in agent (orchestrator, curator, Finance, Science ...). */
    builtin: boolean;
    /** A hidden row a team keeps for its members (visibility background/private or a team parent): it is run through its team, never registered by hand. */
    internal: boolean;
    /**
     * A Hub row with no instructions of its own (the call-only seat): the card's owner keeps the source private, so the agent runs by calling the Hub.
     * it is registered like any other agent (character, row, folder) and is used only after that; running through the Hub is how it answers, not a way around registering.
     */
    callOnly: boolean;
    /** The registration step the owner (or the default) took: the row carries a character. Read only for a call-only row, whose seat predates the rule and was made without one. */
    hasCharacter: boolean;
    /** The placeholder a deleted agent leaves so its history stays readable. */
    placeholder: boolean;
  };
  /** `storage` = archived in Settings (restores on explicit routing); `org` = the person left the owner's team (`oneOrg.archive`). */
  archived: "storage" | "org" | null;
  /** The folder as `agentFolderStatus` reads it, or null when it could not be read (an unreadable state never refuses a turn by itself). */
  folder: null | { state: "ok" | "no-folder" | "folder-missing" | "root-unavailable"; reconnectable: boolean };
}

export type AgentUsability =
  | {
      usable: true;
      agentId: string | null;
      enforced: boolean;
      /** A registered call-only agent: it is used by calling the Hub (the local folder holds no instructions to run). Never rewritten to a local run; a local target of it becomes the Hub target of its slug. */
      runsThroughHub?: true;
      slug?: string;
    }
  | { usable: false; why: "not_registered"; agentId: string | null; slug: string | null; source: "local" | "hub" | "cloud" }
  | { usable: false; why: "no_folder"; agentId: string; slug: string; reconnectable: boolean; folderState: "no-folder" | "folder-missing" | "root-unavailable" }
  | { usable: false; why: "archived"; agentId: string; slug: string; by: "storage" | "org" }
  | { usable: false; why: "removed"; agentId: string | null; slug: string | null };

/** The rule. Order matters: a deleted or never-registered agent first, then the agents that need no folder, then the owner's own states, then the folder. */
export function decideUsability(facts: AgentUsabilityFacts): AgentUsability {
  const row = facts.row;
  if (!row) {
    return facts.refKind === "agentId"
      ? { usable: false, why: "removed", agentId: null, slug: facts.slug }
      : { usable: false, why: "not_registered", agentId: null, slug: facts.slug, source: facts.source };
  }
  if (row.placeholder) return { usable: false, why: "removed", agentId: row.id, slug: row.slug };
  if (row.builtin) return { usable: true, agentId: row.id, enforced: true };
  if (facts.archived) return { usable: false, why: "archived", agentId: row.id, slug: row.slug, by: facts.archived };
  // A call-only seat made before the rule has no character: that is the registration it never had.
  if (row.callOnly && !row.hasCharacter) return { usable: false, why: "not_registered", agentId: row.id, slug: row.slug, source: "hub" };
  if (row.internal) return { usable: true, agentId: row.id, enforced: true };
  if (facts.folder && facts.folder.state !== "ok") {
    return { usable: false, why: "no_folder", agentId: row.id, slug: row.slug, reconnectable: facts.folder.reconnectable, folderState: facts.folder.state };
  }
  return row.callOnly ? { usable: true, agentId: row.id, enforced: true, runsThroughHub: true, slug: row.slug } : { usable: true, agentId: row.id, enforced: true };
}

/**
 * Whether a turn may go on with this agent. A folder that VANISHED (`reconnectable`) is not a refusal: the turn runs from the stored prompt and the screen offers "reconnect".
 * Every place that picks, calls or staffs an agent uses this one test, so a vanished-folder agent answers the same in a 1:1, as a target, as a borrowed slug and in the project pool.
 */
export function passesGate(result: AgentUsability): boolean {
  return result.usable || (result.why === "no_folder" && result.reconnectable);
}

export type UsabilityLocale = "ko" | "en";

/** What the owner is told. Plain words; the closed word stays in the payload. */
export function usabilitySentence(result: Extract<AgentUsability, { usable: false }>, locale: UsabilityLocale): string {
  const ko = locale === "ko";
  switch (result.why) {
    case "not_registered":
      return ko
        ? "이 에이전트는 아직 이 컴퓨터에 등록되지 않았습니다. 캐릭터를 고르고 등록하면 대화·그룹·자동화에서 쓸 수 있습니다."
        : "This agent is not registered on this computer yet. Pick a character and register it, then it can be used in chats, rooms and automations.";
    case "no_folder":
      return result.reconnectable
        ? (ko ? "이 에이전트의 폴더를 찾을 수 없습니다. 폴더를 다시 연결해 주세요." : "This agent's folder can't be found. Reconnect the folder.")
        : (ko ? "이 에이전트는 아직 폴더가 없습니다. 에이전트를 등록해 폴더를 만들어 주세요." : "This agent has no folder yet. Register it so it gets one.");
    case "archived":
      return result.by === "org"
        ? (ko ? "이 팀원은 보관되어 있습니다. 조직도에서 복원하거나 다른 에이전트로 교체해 주세요." : "This teammate is archived. Restore it in the org chart or replace it with another agent.")
        : (ko ? "보관된 에이전트입니다. 설정 › 저장공간에서 복구하세요." : "This agent is archived. Restore it in Settings › Storage.");
    case "removed":
      return ko ? "이 에이전트는 삭제되었습니다." : "This agent was removed.";
  }
}

/** The machine code a refusal travels under (the codes the run already knows are reused: `agent_archived`, `seat_archived`). */
export function usabilityRefusalCode(result: Extract<AgentUsability, { usable: false }>): string {
  switch (result.why) {
    case "not_registered": return NEEDS_REGISTRATION_CODE;
    case "no_folder": return "agent_no_folder";
    case "archived": return result.by === "org" ? "seat_archived" : "agent_archived";
    case "removed": return "no-agent";
  }
}
