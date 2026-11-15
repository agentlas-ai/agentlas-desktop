// The character step of registering an agent (Agentlas 2.0 D6, decision: character -> registered here -> folder -> usable).
//
// Reuses what already exists: a preset id or an uploaded picture is resolved by the same function the "create a teammate" dialog uses (`resolveOneTeamAvatar`), the picture
// lands where every portrait lands (`writeOneTeamAvatar`, the agent's own state folder), and the chosen icon is the row's `tone` (`character:<id>` / `one-avatar:<id>`),
// copied to the agent's active seat. Nothing new is stored. A character is a step of REGISTERING, not a condition of USING: an agent registered without one stays usable
// (grey circle and first letter), and `usability.ts` never reads it.
// With the 2.0 switch on, every registration path that has no screen (the personal agent's `team.install`, a phone install, an engine queue import) gets a default character
// picked from the slug, so no registered agent comes out of the new rule without one; a screen that asked the person overrides it with `setRegistrationCharacter`.
import { createHash } from "node:crypto";
import type { OneTeamAgentAvatarInput } from "../../shared/one-org";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import { decodeOneTeamAvatarDataUrl, writeOneTeamAvatar } from "../one/avatar";
import { hasRegistrationCharacter } from "../../shared/agent-usability";
import fs from "node:fs";
import path from "node:path";
import { AGENT_LOCAL_STATE_FOLDER, resolveAgentHome, writeFileDurable } from "./home";
import { getRoute } from "./routes";
import { usabilityEnforced } from "./usability";

const DEFAULT_CHARACTERS = ["orange-dino", "blue-wave", "green-cloud", "purple-beacon", "amber-pod", "orange-sprout"] as const;

export function defaultRegistrationCharacter(slug: string): string {
  return DEFAULT_CHARACTERS[createHash("sha256").update(slug, "utf8").digest()[0]! % DEFAULT_CHARACTERS.length]!;
}

export type SetCharacterResult = { ok: true; agentId: string; icon: string } | { ok: false; code: "agent_not_found" | "character_invalid" | "write_failed" };

/** Records the chosen character on a registered agent: the row's `tone`, its active seat's icon, and the picture file for an upload. Never throws. */
export function setRegistrationCharacter(agentId: string, avatar: OneTeamAgentAvatarInput): SetCharacterResult {
  const db = getDb();
  const row = db.prepare("SELECT slug FROM installed_agents WHERE id = ?").get(agentId) as { slug?: string } | undefined;
  if (!row?.slug) return { ok: false, code: "agent_not_found" };
  let icon: string;
  let image: ReturnType<typeof decodeOneTeamAvatarDataUrl> | null = null;
  try {
    if (avatar?.kind === "preset") {
      const { resolveOneTeamAvatar } = require("../one/org") as typeof import("../one/org"); // eslint-disable-line @typescript-eslint/no-require-imports
      icon = resolveOneTeamAvatar(avatar, agentId).icon;
    } else if (avatar?.kind === "image") {
      image = decodeOneTeamAvatarDataUrl(avatar.dataUrl);
      icon = `one-avatar:${agentId}`;
    } else return { ok: false, code: "character_invalid" };
  } catch { return { ok: false, code: "character_invalid" }; }
  try {
    if (image) writeOneTeamAvatar({ agentId, slug: row.slug, ...image });
    db.prepare("UPDATE installed_agents SET tone = ? WHERE id = ?").run(icon, agentId);
    db.prepare("UPDATE one_org_members SET icon = ?, updated_at = ?, revision = revision + 1 WHERE installed_agent_id = ? AND archived_at IS NULL").run(icon, new Date().toISOString(), agentId);
  } catch { return { ok: false, code: "write_failed" }; }
  emitDesktopStoreChange({ entity: "agent", id: agentId });
  writeEngineRegistrationFiles(agentId);
  return { ok: true, agentId, icon };
}

/** Switch on only: a freshly registered agent that has no character gets the default one. Idempotent and never throws (a registration is not undone by a missing icon). */
export function ensureRegistrationCharacter(agentId: string): void {
  if (!usabilityEnforced()) return;
  try {
    const row = getDb().prepare("SELECT slug, tone, builtin FROM installed_agents WHERE id = ?").get(agentId) as { slug: string; tone: string | null; builtin: number } | undefined;
    if (!row || row.builtin === 1 || hasRegistrationCharacter(row.tone)) return;
    setRegistrationCharacter(agentId, { kind: "preset", characterId: defaultRegistrationCharacter(row.slug) });
  } catch { /* the registration stands without it */ }
}

/**
 * Agentlas 2.0 D6-2 (engine 0ab135f7 `agent_usability.py` / `agent_registration.py`): the engine recognises a registered Hub/Cloud agent by its folder - the folder name is the slug, or
 * `.agentlas-local/origin.json` names the slug (and `agentDefinitionId`). The desktop writes the same shape when it registers one: `origin.json` (merged into what is there; `kind`
 * "desktop-registered" so the engine's `remove_pointer`, which only removes `hub-pointer` folders, never touches it), `character.json` for a preset character, and for a call-only
 * agent a `card.json` copy of the card. Switch on only; never throws; a registration is not undone by a file that could not be written. Nothing here is a new store: the files
 * live and die with the agent's folder.
 */
export function writeEngineRegistrationFiles(agentId: string): void {
  if (!usabilityEnforced()) return;
  try {
    const db = getDb();
    const row = db.prepare("SELECT slug, tone, builtin, system_prompt, name FROM installed_agents WHERE id = ?").get(agentId) as { slug: string; tone: string | null; builtin: number; system_prompt: string | null; name: string } | undefined;
    if (!row || row.builtin === 1) return;
    const route = getRoute(agentId);
    let binding: { source?: string; agentDefinitionId?: string } | null = null;
    try { binding = (require("../ontology/hub-bindings") as typeof import("../ontology/hub-bindings")).getInstalledAgentHubBinding(agentId); } catch { /* the route decides */ }
    const source = route?.source === "hub" || binding?.source === "hub-install" ? "hub" : route?.source === "agent-cloud" || binding?.source === "agent-cloud-restore" ? "cloud" : null;
    if (!source) return; // a local folder: the engine already knows it by its own registration
    const folder = resolveAgentHome({ id: agentId, slug: row.slug }, route).dir;
    if (!folder || !fs.existsSync(folder)) return;
    const state = path.join(folder, AGENT_LOCAL_STATE_FOLDER);
    fs.mkdirSync(state, { recursive: true });
    const definitionId = binding?.agentDefinitionId ?? ""; // empty: the slug alone is enough for the engine
    const originFile = path.join(state, "origin.json");
    let current: Record<string, unknown> = {};
    try { const parsed = JSON.parse(fs.readFileSync(originFile, "utf8").replace(/^\uFEFF/, "")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>; } catch { /* none yet */ }
    writeFileDurable(originFile, `${JSON.stringify({ v: 1, kind: "desktop-registered", ...current, source, slug: row.slug, ...(definitionId ? { agentDefinitionId: definitionId } : {}) }, null, 2)}\n`);
    const preset = /^character:(.+)$/.exec(row.tone ?? "")?.[1];
    if (preset) writeFileDurable(path.join(state, "character.json"), `${JSON.stringify({ v: 1, character: preset, chosenBy: "owner" })}\n`);
    if (!(row.system_prompt ?? "").trim()) {
      writeFileDurable(path.join(folder, "card.json"), `${JSON.stringify({ v: 1, slug: row.slug, name: row.name, source, entityKind: "agent", agentDefinitionId: definitionId })}\n`, { keepExisting: true });
    }
  } catch { /* the registration stands without the engine's copy */ }
}
