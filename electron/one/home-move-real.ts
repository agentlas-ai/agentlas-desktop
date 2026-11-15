/*
 * The real stores behind the move (Agentlas 2.0 O-M3b): lazy requires only (no Electron import at module level, nothing opened until a step asks).
 * Main builds these once (`realMoveDeps`); a process that has no app database (a background service without Main) gets none and every move call answers `move_unavailable`.
 *
 * Paths: everything this feature writes lives under `<userData>/one-move/<24 hex of sha256(userId)>/` (`work/` = packed folders of the sender, `staging/` = what a receiver
 * downloads and stages, `secret.*.json` = the host-only secrets). Per account, so another account never sees or continues a move.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MoveDeps, ReadinessFacts, HomeState } from "./home-move";
import { createBundleHost, type BundleSources } from "./bundle-host";
import { createLeftoverBoxStore, createMoveSecretStore, type SafeStoragePort } from "./home-key-store";
import type { FactOutcome, FactWrite } from "./server-import";
import { createOriginIndex, deleteLines, idsPresent, markedMemoryIds, markedOlderVersionIds, tagMemory } from "./leftover-origin";

/* eslint-disable @typescript-eslint/no-require-imports */
const req = <T>(id: string): T => require(id) as T;

/** The conversation-line origin index lives apart from the move's scratch folder: it is kept until the owner forgets what came from that computer. */
const originRoot = (userId: string): string => path.join(req<typeof import("../runtime-paths")>("../runtime-paths").userDataDir(), "one-leftover", createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24));
const accountDir = (userId: string): string => path.join(req<typeof import("../runtime-paths")>("../runtime-paths").userDataDir(), "one-move", createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24));

function realSources(): BundleSources {
  const profileMod = (): typeof import("../store/one-profile") => req("../store/one-profile");
  const db = (): import("better-sqlite3").Database => req<typeof import("../store/db")>("../store/db").getDb();
  return {
    db,
    oneId: () => profileMod().getOneProfile().oneId,
    profile: () => profileMod().getOneProfile() as unknown as ReturnType<BundleSources["profile"]>,
    applyProfile: (patch) => { const p = profileMod(); const cur = p.getOneProfile(); p.updateOneProfile({ oneId: cur.oneId, expectedVersion: cur.version, patch: patch as never }); },
    avatarBytes: () => { try { return req<typeof import("./avatar")>("./avatar").readOneSelfAvatarBytes(); } catch { return null; } },
    writeAvatar: (bytes, ext) => {
      const p = profileMod(); const cur = p.getOneProfile();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      req<typeof import("./avatar")>("./avatar").setOneSelfAvatarImage({ dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, expectedVersion: cur.version, oneId: cur.oneId });
    },
    settings: () => null,                       // no per-agent settings store is defined yet (the contract's `settings.json` carries none today)
    applySettings: () => undefined,
    // The names of what was connected here (provider ids, app key names, MCP server names) have no single read-only source today (searched): `reconnect.json` is not written, so the end screen lists nothing to reconnect.
    reconnect: () => null,
    checkinsRead: () => {
      const oneId = profileMod().getOneProfile().oneId;
      // Audit 61 (desktop 8): each row says whether the MODEL made it (its create request is a proposal: supervisor-store `modelMade`), so the receiving computer, which has no such request, holds only those to the model's 60-minute floor.
      // A store without the requests table (or a row without one) is read as before: no flag, which the receiver reads as "model-made" (the old, stricter behaviour).
      try { return db().prepare("SELECT c.id,c.instruction,c.cadence_json,c.notify,c.active,c.fires,c.last_fired_at,c.created_at,c.command_id, EXISTS (SELECT 1 FROM one_supervisor_requests q WHERE q.command_id=c.command_id AND json_valid(q.payload_json) AND json_extract(q.payload_json,'$.proposal')=1) AS model_made FROM one_supervisor_checkins c WHERE c.one_id=?").all(oneId) as never; } catch { /* the plain read below */ }
      try { return db().prepare("SELECT id,instruction,cadence_json,notify,active,fires,last_fired_at,created_at,command_id FROM one_supervisor_checkins WHERE one_id=?").all(oneId) as never; } catch { return []; }
    },
    // Audit 59 F-4: a bundle's check-ins stand under the limits of the personal agent's own check-ins (shared/one-supervisor.ts ONE_CHECKIN_LIMITS): at most 20 ACTIVE ones count (a host-authored instruction is exempt, as there), the
    // text is a valid check-in text (supervisorText), the cadence is valid and an interval below the model's floor is raised to it (clampCheckinCadence, the way a check-in the model asked for is made). What does not fit is not added and is
    // counted (`dropped`). The per-day firing caps (ONE_CHECKIN_POLICY) are the scheduler's own and apply to these rows when they fire. Not read from a bundle: `fires`, `last_fired_at` (start at zero / never; display only - the next run is worked out from the move, a daily check-in keeps its clock time, an interval one starts its period again; desktop 8).
    checkinsMerge: (rows) => {
      const d = db(); const oneId = profileMod().getOneProfile().oneId;
      const sup = req<typeof import("../../shared/one-supervisor")>("../../shared/one-supervisor");
      const { isHostCheckinInstruction } = req<typeof import("./host-checkin-instructions")>("./host-checkin-instructions");
      const insert = d.prepare("INSERT OR IGNORE INTO one_supervisor_checkins(id,one_id,instruction,cadence_json,notify,next_at,active,fires,last_fired_at,created_at,command_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      let added = 0, dropped = 0;
      d.transaction(() => {
        const counted = (d.prepare("SELECT instruction FROM one_supervisor_checkins WHERE one_id=? AND active=1").all(oneId) as Array<{ instruction: string }>).filter((x) => !isHostCheckinInstruction(x.instruction)).length;
        let active = counted;
        for (const r of (rows as Array<Record<string, unknown>>).slice(0, 200)) {
          try {
            if (r.notify !== "important" && r.notify !== "always") { dropped += 1; continue; }
            const instruction = sup.supervisorText(r.instruction);
            const requested = JSON.parse(String(r.cadence_json)) as import("../../shared/one-supervisor").OneCheckinCadence;
            // Audit 61 (desktop 8): a check-in the OWNER made (the sender said `model_made: 0`) keeps the interval the owner set down to the validity floor (what a create from the owner's own screen gets: `raiseToValidityFloor`, 5 minutes);
            // one the model made, or a row that does not say, is held to the model's floor as before.
            const ownerMade = r.model_made === 0 || r.model_made === false;
            const cadence = (ownerMade ? sup.raiseToValidityFloor(requested) : sup.clampCheckinCadence(requested)).cadence;
            const next = sup.nextCheckinAt(cadence, Date.now());
            const on = r.active === 0 ? 0 : 1;
            if (on === 1 && !isHostCheckinInstruction(instruction) && active >= sup.ONE_CHECKIN_LIMITS.active) { dropped += 1; continue; }
            const changes = insert.run(String(r.id), oneId, instruction, JSON.stringify(cadence), r.notify, next, on, 0, null, new Date().toISOString(), String(r.command_id ?? r.id)).changes;
            added += changes;
            if (changes && on === 1 && !isHostCheckinInstruction(instruction)) active += 1;
          } catch { dropped += 1; /* a damaged line is not merged */ }
        }
        dropped += Math.max(0, (rows as unknown[]).length - 200);
      }).immediate();
      return { added, dropped };
    },
    ensurePersonalChat: () => {
      const store = new (req<typeof import("./supervisor-store")>("./supervisor-store").OneSupervisorStore)(db());
      const oneId = profileMod().getOneProfile().oneId;
      return store.bindConversation(oneId, () => req<typeof import("../store/chats")>("../store/chats").createChat({ originSurface: "one", taskMode: "conversation", title: profileMod().getOneProfile().displayName }).id);
    },
    // No function plants a seed in a context journal today (searched: none). The imported conversation itself is the continuity; the seed is counted as not planted.
    plantContextSeed: () => false,
    activeWorkCount: () => {
      try { return Number((db().prepare("SELECT COUNT(*) AS n FROM one_supervisor_requests WHERE kind IN ('work','science') AND state IN ('dispatching','accepted')").get() as { n: number }).n) || 0; } catch { return 0; }
    },
    // Older versions of Personal lines (replaced by an owner edit): a purge leaves them on this computer ("what stays").
    // Audit 61 N-2: the table the engine writes the original wording of an imported line to; the same DDL function the store itself calls (memory/store.ts), never a second copy of it.
    ensureNativeTable: () => { req<typeof import("../memory/store")>("../memory/store").ensureMemoryNativeTable(); },
    olderVersionCount: () => {
      try { return Number((req<typeof import("../memory/database")>("../memory/database").getMemoryDb().prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE scope='user_identity' AND superseded_at IS NOT NULL AND content<>''").get() as { n: number }).n) || 0; } catch { return 0; }
    },
  };
}

/** Server copy of the personal agent's facts, one line each. TH+MT: a card of the server is written the way the mirror's take writes it (home-mirror-real.ts `writeCard`: the same receipt key - `importSourceKey` takes 16 hex, so the card's id is hashed -,
 * the same evidence tag `hope-server-fact:<id>` the forget and the later take find the line by, the same grades and English line, the same secret check). Before this, the key was made from the raw card id, the shape check threw and every
 * card of a server-start move was refused in silence (`rejected`): the first alignment moved the words and no memory line. A card that `cardWriteOf` cannot read is `rejected`, as before. */
function writeFact(f: FactWrite): FactOutcome {
  try {
    const { cardWriteOf } = req<typeof import("./home-mirror")>("./home-mirror");
    const { realMirrorStore } = req<typeof import("./home-mirror-real")>("./home-mirror-real");
    const parsed = cardWriteOf(f.raw, "top");   // audit D5 (ii): the first alignment is itself the owner's approval (contracts/mirror-trust.md section 5): everything the server held until then comes down at the grade it has, and a card with no grade is the owner's own word
    if (!parsed.ok) return "rejected";
    const out = realMirrorStore().writeCard(parsed.write);
    return out.result;
  } catch { return "rejected"; }
}

async function readiness(): Promise<ReadinessFacts> {
  const facts: ReadinessFacts = { hostId: null, runtimeCount: null, classified: null, rulesOn: null, labelsRunning: null, diskFreeBytes: null, cloudComputer: false };
  try { facts.hostId = req<typeof import("./host-identity")>("./host-identity").oneNativeHostIdentity().hostId; } catch { /* null */ }
  try { facts.cloudComputer = req<typeof import("../managed-one/auth")>("../managed-one/auth").managedOneConfigured(); } catch { /* not a managed host */ }
  try {
    const list = await req<typeof import("../runtime/detect")>("../runtime/detect").detectRuntimes();
    facts.runtimeCount = Array.isArray(list) ? list.filter((r) => (r as { available?: unknown }).available !== false && (r as { installed?: unknown }).installed !== false).length : null;
  } catch { /* null */ }
  try {
    const root = req<typeof import("../memory/database")>("../memory/database").getMemoryDb();
    const row = root.prepare("SELECT (SELECT 1 FROM memory_store_meta WHERE key='first_run_classified') AS c, (SELECT value FROM memory_store_meta WHERE key='first_run_llm') AS l").get() as { c: unknown; l: unknown } | undefined;
    facts.classified = row?.c !== null && row?.c !== undefined;
    let state: string | null = null;
    try { const parsed = row?.l ? JSON.parse(String(row.l)) as { state?: unknown } : null; if (parsed && typeof parsed.state === "string") state = parsed.state; } catch { /* null */ }
    facts.labelsRunning = !(state === null || state === "done" || state === "capped" || state === "waiting_model") ? true : false;
    facts.rulesOn = req<typeof import("../migration/first-run-rules")>("../migration/first-run-rules").switchRowIsOn(root);
  } catch { /* null */ }
  // Audit 62 (home D7): why the first-run migration has not classified (its switch is off, or it ran and stopped with a code): the move says which, instead of "wait" for a thing that will not come.
  try { const gate = req<typeof import("../migration/gate")>("../migration/gate"); facts.migrationEnabled = gate.firstRunMigrationEnabled(); facts.migrationOpenCodes = gate.firstRunOpenCodes(); } catch { /* not read */ }
  try { const base = req<typeof import("../runtime-paths")>("../runtime-paths").userDataDir(); const st = fs.statfsSync(base); facts.diskFreeBytes = Number(st.bavail) * Number(st.bsize); } catch { /* null */ }
  return facts;
}

/** The five conditions of design 5.8.7. Each is read from this computer's own state; the first that does not hold is the code. */
function resting(): { ok: boolean; why?: string } {
  try {
    const d = req<typeof import("../store/db")>("../store/db").getDb();
    const busy = Number((d.prepare("SELECT COUNT(*) AS n FROM one_supervisor_requests WHERE state IN ('stored','dispatching','accepted')").get() as { n: number }).n) || 0;
    if (busy > 0) return { ok: false, why: "personal_agent_running" };
  } catch { return { ok: false, why: "resting_unknown" }; }
  try { if ((req<typeof import("../memory/dreaming")>("../memory/dreaming").getDreamingStatus() as { running?: boolean }).running === true) return { ok: false, why: "dreaming_running" }; } catch { /* no status: not running */ }
  return { ok: true };
}

/** The owner's own forget path for one Personal line (the same call the memory screen makes: ownership, actor, revision and epoch fences are read fresh, so a changed line is refused, never guessed). */
export function forgetOneOwned(id: string): void {
  const om = req<typeof import("../memory/owner-mutations")>("../memory/owner-mutations");
  const dbm = req<typeof import("../memory/database")>("../memory/database");
  const row = om.ownedMemoryRecord(id);
  om.forgetOwnedMemory({ memoryId: id, ownerRef: om.currentMemoryOwnerRef(), actorId: om.learningActor(row), expectedRevision: om.memoryTargetRevision(row), expectedEpoch: dbm.getMemoryStoreInfo().revocationEpoch });
}

export function realMoveDeps(): MoveDeps {
  const safe = (): SafeStoragePort | null => { try { return (req<{ safeStorage?: SafeStoragePort }>("electron").safeStorage) ?? null; } catch { return null; } };
  const sources = realSources();
  const secrets = createMoveSecretStore({ dir: accountDir, safeStorage: safe });
  const root = (): import("better-sqlite3").Database => req<typeof import("../memory/database")>("../memory/database").getMemoryDb();
  return {
    dirs: (userId) => ({ workDir: path.join(accountDir(userId), "work"), stagingBase: path.join(accountDir(userId), "staging") }),
    secrets,
    caller: () => req<typeof import("./bundle")>("./bundle").createOnePackCaller(),
    bundleHost: () => createBundleHost(sources),
    sources: () => sources,
    readiness, resting,
    activeWorkCount: sources.activeWorkCount,
    localProfile: () => { const p = sources.profile()!; return { displayName: p.displayName, avatarIcon: p.avatarIcon, profileContext: p.profileContext, preferredLocale: p.preferredLocale, timeZone: p.timeZone }; },
    applyProfile: sources.applyProfile,
    writeFact,
    noteTurns: (pairs) => { req<typeof import("./server-turns")>("./server-turns").noteServerTurns(sources.db(), pairs); },   // a failure is not swallowed (audit D2): the import step reports `words_not_linked` and runs again
    plantContextSeed: sources.plantContextSeed,
    ensurePersonalChat: sources.ensurePersonalChat,
    unbindPersonalChat: () => { try { const d = sources.db(); d.prepare("DELETE FROM one_supervisor_conversations WHERE one_id=?").run(sources.oneId()); } catch { /* nothing bound */ } },
    engineRoots: () => { try { const root = req<typeof import("../hephaestus/engine")>("../hephaestus/engine").hephaestusRoot(); return typeof root === "string" && root ? [root] : []; } catch { return []; } },
    setMirror: (state: HomeState) => req<typeof import("../memory/stores")>("../memory/stores").setHomeMirror(root(), state),
    getMirror: () => req<typeof import("../memory/stores")>("../memory/stores").readHomeMirror(root()),
    leftover: {
      tagMemory: (ids, marker) => tagMemory(root(), ids, marker),
      lineIdsPresent: (ids) => idsPresent(sources.db(), "chat_messages", ids),
      origins: createOriginIndex(originRoot),
      boxSecret: createLeftoverBoxStore({ dir: () => path.join(req<typeof import("../runtime-paths")>("../runtime-paths").userDataDir(), "mobile-bridge"), safeStorage: safe }),
      markedMemoryIds: (prefix) => markedMemoryIds(root(), prefix),
      markedOlderIds: (prefix) => markedOlderVersionIds(root(), prefix),
      deleteLines: (ids) => deleteLines(sources.db(), ids),
    },
  };
}
