import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { looksSecret } from "../../shared/secret-patterns";
import {
  ONE_ONBOARDING_CONTRACT_VERSION,
  ONE_ONBOARDING_CURRENT_VERSION,
  ONE_ONBOARDING_STARTER_AGENTS,
  isOneOnboardingBrainStatus,
  isOneOnboardingExperience,
  isOneOnboardingProvider,
  isOneOnboardingScene,
  isOneOnboardingState,
  isOneOnboardingSubscription,
  type CompleteOneOnboardingInput,
  type DismissOneOnboardingInput,
  type LimitOneOnboardingProviderInput,
  type OneOnboardingExecutionAuthorization,
  type OneOnboardingProvider,
  type OneOnboardingState,
  type ProvisionOneOnboardingStarterTeamInput,
  type ReopenOneOnboardingProviderInput,
  type ResumeOneOnboardingInput,
  type UpdateOneOnboardingInput,
  type VerifyOneOnboardingProviderInput,
} from "../../shared/one-onboarding";
import type { AgentGroup, AgentGroupMember, RuntimeStatus } from "../../shared/types";
import { detectRuntimes } from "../runtime/detect";
import { getUsageSnapshot } from "../usage";
import { createAgentGroup, getAgentGroup, updateAgentGroup } from "../store/agent-groups";
import { getDb } from "../store/db";
import { getOneProfile } from "../store/one-profile";
import { tryRecordOneDomainEvent } from "./domain-events";
import { acknowledgeOneFeatureIntro, getOneFeatureIntroState } from "./feature-intro";

export const ONE_ONBOARDING_META_KEY = "agentlas.one.onboarding.v1";

// Profiles created before the feature shipped already learned the product the
// old way. They are migrated silently instead of being interrupted by a tour.
export const ONE_ONBOARDING_ROLLOUT_CUTOFF = "2026-07-20T13:00:00.000Z";

const PATCH_KEYS = [
  "currentScene",
  "experience",
  "subscription",
  "provider",
  "soundEnabled",
  "rephraseUsed",
  "selectedStarterSlugs",
  "projectSeed",
] as const;
const STARTER_BY_SLUG = new Map(ONE_ONBOARDING_STARTER_AGENTS.map((agent) => [agent.slug, agent]));
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function assertExpectedVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function cleanSeed(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("projectSeed must be text");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < 1 || normalized.length > 500) {
    throw new RangeError("projectSeed must contain 1-500 characters");
  }
  if (UNSAFE_CONTROL_RE.test(normalized)) throw new TypeError("projectSeed contains unsupported control characters");
  if (looksSecret(normalized)) throw new TypeError("projectSeed must not contain credentials or secrets");
  return normalized;
}

function normalizedStarterSlugs(value: unknown, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new TypeError("selectedStarterSlugs must be an array");
  const slugs = value.map((slug) => typeof slug === "string" ? slug.trim() : "");
  if (slugs.length < minimum || slugs.length > ONE_ONBOARDING_STARTER_AGENTS.length) {
    throw new RangeError(`Select ${minimum}-${ONE_ONBOARDING_STARTER_AGENTS.length} starter agents`);
  }
  if (new Set(slugs).size !== slugs.length || slugs.some((slug) => !STARTER_BY_SLUG.has(slug))) {
    throw new TypeError("selectedStarterSlugs contains an unknown or duplicate starter");
  }
  return slugs;
}

function initialState(): OneOnboardingState {
  const profile = getOneProfile();
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  const cutoff = Date.parse(ONE_ONBOARDING_ROLLOUT_CUTOFF);
  let storePredatesRollout = false;
  try {
    const databases = getDb().prepare("PRAGMA database_list").all() as Array<{ name?: string; file?: string }>;
    const mainFile = databases.find((entry) => entry.name === "main")?.file;
    if (mainFile && fs.existsSync(mainFile)) {
      const stat = fs.statSync(mainFile);
      const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
      storePredatesRollout = created < cutoff;
    }
  } catch {
    // The One profile timestamp remains a safe fallback for memory databases.
  }
  const existingUser = storePredatesRollout || Date.parse(profile.createdAt) < cutoff;
  return {
    contractVersion: ONE_ONBOARDING_CONTRACT_VERSION,
    oneId: profile.oneId,
    version,
    tutorialVersion: ONE_ONBOARDING_CURRENT_VERSION,
    status: existingUser ? "migrated" : "pending",
    resolution: existingUser ? "existing_user" : null,
    currentScene: "s0",
    experience: null,
    subscription: null,
    provider: null,
    brainStatus: "unchecked",
    restrictedMode: false,
    soundEnabled: true,
    rephraseUsed: false,
    selectedStarterSlugs: [],
    starterTeamGroupId: null,
    projectSeed: "",
    startedAt: null,
    completedAt: existingUser ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneOnboardingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One onboarding state is corrupt; it was not overwritten");
  }
  if (!isOneOnboardingState(parsed)) {
    throw new Error("Stored One onboarding state violates its closed contract; it was not overwritten");
  }
  if (parsed.oneId !== getOneProfile().oneId) {
    throw new Error("Stored One onboarding belongs to a different One identity; it was not overwritten");
  }
  return parsed;
}

function readOrCreateState(): { raw: string; state: OneOnboardingState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_ONBOARDING_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_ONBOARDING_META_KEY, JSON.stringify(initialState()));
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_ONBOARDING_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One onboarding state");
  return { raw: row.value, state: parseState(row.value) };
}

function persist(raw: string, next: OneOnboardingState): OneOnboardingState {
  if (!isOneOnboardingState(next)) throw new Error("One onboarding mutation violated the storage contract");
  const result = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
    .run(JSON.stringify(next), ONE_ONBOARDING_META_KEY, raw);
  if (result.changes !== 1) throw new Error("One onboarding changed concurrently; reload and try again");
  return next;
}

function mutate(
  expectedVersion: number,
  update: (state: OneOnboardingState, timestamp: { version: number; iso: string }) => OneOnboardingState,
): OneOnboardingState {
  assertExpectedVersion(expectedVersion);
  const current = readOrCreateState();
  if (current.state.version !== expectedVersion) {
    throw new Error(`One onboarding changed (expected ${expectedVersion}, current ${current.state.version})`);
  }
  if (current.state.status === "dismissed") {
    throw new Error("Resume dismissed onboarding before changing it");
  }
  if (current.state.status === "completed" || current.state.status === "migrated") return current.state;
  const next = update(current.state, nextTimestamp(current.state.version));
  return next === current.state ? current.state : persist(current.raw, next);
}

function starterGroupMembers(slugs: string[], at: string): AgentGroupMember[] {
  return slugs.map((slug) => {
    const agent = STARTER_BY_SLUG.get(slug);
    if (!agent) throw new Error(`Unknown onboarding starter: ${slug}`);
    return {
      id: randomUUID(),
      source: "hub",
      agentSlug: agent.slug,
      hubSlug: agent.slug,
      hubEntityKind: agent.entityKind,
      role: agent.roleEn,
      addedAt: at,
      snapshot: {
        name: agent.nameKo,
        nameEn: agent.nameEn,
        tagline: agent.roleKo,
        taglineEn: agent.roleEn,
        routeLabel: "Hub · pinned starter",
        trustGrade: agent.trustGrade,
        entityKind: agent.entityKind,
        routingStatus: "callable",
        packageHash: agent.packageHash,
      },
    };
  });
}

function exactStarterGroupMatchesState(state: OneOnboardingState, group: AgentGroup | null): boolean {
  if (!group || group.members.length !== state.selectedStarterSlugs.length || state.selectedStarterSlugs.length < 2) {
    return false;
  }
  const expectedSlugs = new Set(state.selectedStarterSlugs);
  const actualSlugs = new Set<string>();
  const exact = group.members.every((member) => {
    const slug = member.hubSlug || member.agentSlug || "";
    const starter = STARTER_BY_SLUG.get(slug);
    actualSlugs.add(slug);
    return Boolean(
      expectedSlugs.has(slug)
      && starter
      && member.source === "hub"
      && member.hubEntityKind === starter.entityKind
      && member.snapshot.packageHash === starter.packageHash
    );
  });
  return exact && actualSlugs.size === expectedSlugs.size;
}

function providerMatchesRuntime(provider: Exclude<OneOnboardingProvider, null>, runtime: RuntimeStatus): boolean {
  if (provider === "openai") return runtime.kind === "codex" || runtime.backend === "openai";
  if (provider === "anthropic") return runtime.kind === "claude-code" || runtime.backend === "anthropic";
  if (provider === "kimi") return runtime.kind === "kimi" || runtime.backend === "kimi";
  return runtime.kind === "gemini" || runtime.backend === "google";
}

async function mainOwnedReadyProvider(
  preferred?: Exclude<OneOnboardingProvider, null>,
): Promise<Exclude<OneOnboardingProvider, null> | null> {
  const runtimes = await detectRuntimes(true);
  const usage = await getUsageSnapshot({ force: true });
  const candidates = [preferred, "openai", "anthropic", "google"]
    .filter((provider, index, items): provider is Exclude<OneOnboardingProvider, null> => Boolean(provider) && items.indexOf(provider) === index);
  for (const provider of candidates) {
    // Kimi currently exposes no normalized authenticated-usage probe. Installed
    // bytes alone are not proof of a paid, signed-in execution entitlement.
    if (provider === "kimi" || !runtimes.some((runtime) => providerMatchesRuntime(provider, runtime))) continue;
    const usageProvider = provider === "openai" ? "codex" : provider === "anthropic" ? "claude-code" : "gemini";
    if (usage.providers.some((item) => item.provider === usageProvider && item.status !== "error")) return provider;
  }
  return null;
}

async function mainOwnedProviderReady(provider: Exclude<OneOnboardingProvider, null>): Promise<boolean> {
  return await mainOwnedReadyProvider(provider) === provider;
}

export function getOneOnboardingState(): OneOnboardingState {
  return readOrCreateState().state;
}

/**
 * Main-owned execution authorization for the exact team the user confirmed in
 * onboarding. A renderer-held group id is never enough: membership, entity
 * namespace, and immutable package hashes must still match the stored grant.
 */
export function isCompletedOneOnboardingStarterGroup(groupId: string): boolean {
  if (typeof groupId !== "string" || !groupId) return false;
  const state = readOrCreateState().state;
  if (
    state.status !== "completed"
    || state.starterTeamGroupId !== groupId
    || state.selectedStarterSlugs.length < 2
  ) return false;
  return exactStarterGroupMatchesState(state, getAgentGroup(groupId));
}

export function oneOnboardingStarterGroupReference(groupId: string): "none" | "valid" | "invalid" {
  if (typeof groupId !== "string" || !groupId) return "none";
  const state = readOrCreateState().state;
  if (state.status !== "completed" || state.starterTeamGroupId !== groupId) return "none";
  return exactStarterGroupMatchesState(state, getAgentGroup(groupId)) ? "valid" : "invalid";
}

export async function getOneOnboardingExecutionAuthorization(): Promise<OneOnboardingExecutionAuthorization> {
  const state = readOrCreateState().state;
  if (state.status !== "completed") return { allowed: false, groupId: null, reason: "not_completed" };
  if (!state.starterTeamGroupId || !exactStarterGroupMatchesState(state, getAgentGroup(state.starterTeamGroupId))) {
    return { allowed: false, groupId: null, reason: "starter_team_changed" };
  }
  if (!state.provider || !await mainOwnedReadyProvider(state.provider).catch(() => null)) {
    return { allowed: false, groupId: state.starterTeamGroupId, reason: "provider_not_ready" };
  }
  return { allowed: true, groupId: state.starterTeamGroupId, reason: "ready" };
}

/**
 * Explicitly reopens only the provider step after completion. This is separate
 * from read-only tutorial replay so a user can recover from an expired plan or
 * replace Kimi with a provider whose authenticated usage Main can verify.
 */
export function reopenOneOnboardingProvider(input: ReopenOneOnboardingProviderInput): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid provider recovery request");
  assertOnlyKeys(input, ["expectedVersion"], "Provider recovery request");
  assertExpectedVersion(input.expectedVersion);
  const current = readOrCreateState();
  if (current.state.version !== input.expectedVersion) {
    throw new Error(`One onboarding changed (expected ${input.expectedVersion}, current ${current.state.version})`);
  }
  if (current.state.status !== "completed") throw new Error("Only completed onboarding can reopen provider setup");
  const timestamp = nextTimestamp(current.state.version);
  return persist(current.raw, {
    ...current.state,
    version: timestamp.version,
    status: "in-progress",
    resolution: null,
    currentScene: "s3",
    provider: null,
    brainStatus: "unchecked",
    restrictedMode: false,
    completedAt: null,
    updatedAt: timestamp.iso,
  });
}

/**
 * Hides the tutorial without pretending it was completed. The current scene
 * and every choice remain durable so closing the modal is always reversible.
 */
export function dismissOneOnboarding(input: DismissOneOnboardingInput): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid onboarding dismissal request");
  assertOnlyKeys(input, ["expectedVersion"], "Onboarding dismissal request");
  assertExpectedVersion(input.expectedVersion);
  const current = readOrCreateState();
  if (current.state.version !== input.expectedVersion) {
    throw new Error(`One onboarding changed (expected ${input.expectedVersion}, current ${current.state.version})`);
  }
  if (current.state.status === "completed" || current.state.status === "migrated" || current.state.status === "dismissed") {
    return current.state;
  }
  const timestamp = nextTimestamp(current.state.version);
  const next = persist(current.raw, {
    ...current.state,
    version: timestamp.version,
    status: "dismissed",
    updatedAt: timestamp.iso,
  });
  tryRecordOneDomainEvent({
    eventType: "onboarding.step_resolved",
    occurredAt: next.updatedAt,
    actor: "user",
    entityId: next.oneId,
    version: next.version,
    visibility: "personal",
    entries: [
      { name: "stepId", value: "tutorial" },
      { name: "resolution", value: "dismissed" },
    ],
  });
  return next;
}

/** Reopens a dismissed tutorial or lets a migrated existing user opt in. */
export function resumeOneOnboarding(input: ResumeOneOnboardingInput): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid onboarding resume request");
  assertOnlyKeys(input, ["expectedVersion"], "Onboarding resume request");
  assertExpectedVersion(input.expectedVersion);
  const current = readOrCreateState();
  if (current.state.version !== input.expectedVersion) {
    throw new Error(`One onboarding changed (expected ${input.expectedVersion}, current ${current.state.version})`);
  }
  if (current.state.status !== "dismissed" && current.state.status !== "migrated") {
    throw new Error("Only dismissed or migrated onboarding can be started from the Las helper");
  }
  const timestamp = nextTimestamp(current.state.version);
  return persist(current.raw, {
    ...current.state,
    version: timestamp.version,
    status: "in-progress",
    resolution: null,
    currentScene: current.state.status === "migrated" ? "s0" : current.state.currentScene,
    startedAt: current.state.startedAt ?? timestamp.iso,
    completedAt: null,
    updatedAt: timestamp.iso,
  });
}

export function updateOneOnboarding(input: UpdateOneOnboardingInput): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid One onboarding update");
  assertOnlyKeys(input, ["expectedVersion", "patch"], "One onboarding update");
  assertExpectedVersion(input.expectedVersion);
  if (!isRecord(input.patch)) throw new TypeError("One onboarding patch must be an object");
  assertOnlyKeys(input.patch, PATCH_KEYS, "One onboarding patch");
  if (Object.keys(input.patch).length === 0) throw new TypeError("One onboarding patch is empty");

  return mutate(input.expectedVersion, (state, timestamp) => {
    const next: OneOnboardingState = {
      ...state,
      version: timestamp.version,
      status: "in-progress",
      startedAt: state.startedAt ?? timestamp.iso,
      updatedAt: timestamp.iso,
    };
    if ("currentScene" in input.patch) {
      if (!isOneOnboardingScene(input.patch.currentScene)) throw new TypeError("Invalid onboarding scene");
      next.currentScene = input.patch.currentScene;
    }
    if ("experience" in input.patch) {
      if (!isOneOnboardingExperience(input.patch.experience)) throw new TypeError("Invalid onboarding experience");
      next.experience = input.patch.experience;
    }
    if ("subscription" in input.patch) {
      if (!isOneOnboardingSubscription(input.patch.subscription)) throw new TypeError("Invalid subscription state");
      next.subscription = input.patch.subscription;
    }
    if ("provider" in input.patch) {
      if (!isOneOnboardingProvider(input.patch.provider)) throw new TypeError("Invalid runtime provider");
      if (state.provider !== input.patch.provider) {
        next.brainStatus = "unchecked";
        next.restrictedMode = false;
      }
      next.provider = input.patch.provider;
    }
    if ("soundEnabled" in input.patch) {
      if (typeof input.patch.soundEnabled !== "boolean") throw new TypeError("soundEnabled must be boolean");
      next.soundEnabled = input.patch.soundEnabled;
    }
    if ("rephraseUsed" in input.patch) {
      if (input.patch.rephraseUsed !== true || state.rephraseUsed) throw new Error("The simpler explanation can be used once");
      next.rephraseUsed = true;
    }
    if ("selectedStarterSlugs" in input.patch) {
      next.selectedStarterSlugs = normalizedStarterSlugs(input.patch.selectedStarterSlugs);
    }
    if ("projectSeed" in input.patch) next.projectSeed = cleanSeed(input.patch.projectSeed);
    return next;
  });
}

export async function verifyOneOnboardingProvider(input: VerifyOneOnboardingProviderInput): Promise<OneOnboardingState> {
  if (!isRecord(input)) throw new TypeError("Invalid provider verification request");
  assertOnlyKeys(input, ["expectedVersion", "provider"], "Provider verification request");
  assertExpectedVersion(input.expectedVersion);
  if (!isOneOnboardingProvider(input.provider)) throw new TypeError("Invalid runtime provider");
  const connected = await mainOwnedProviderReady(input.provider).catch(() => false);
  return mutate(input.expectedVersion, (state, timestamp) => ({
    ...state,
    version: timestamp.version,
    status: "in-progress",
    provider: input.provider,
    brainStatus: connected ? "connected" : "unchecked",
    restrictedMode: false,
    startedAt: state.startedAt ?? timestamp.iso,
    updatedAt: timestamp.iso,
  }));
}

export function limitOneOnboardingProvider(input: LimitOneOnboardingProviderInput): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid limited-mode request");
  assertOnlyKeys(input, ["expectedVersion", "provider"], "Limited-mode request");
  assertExpectedVersion(input.expectedVersion);
  if (!isOneOnboardingProvider(input.provider)) throw new TypeError("Invalid runtime provider");
  return mutate(input.expectedVersion, (state, timestamp) => ({
    ...state,
    version: timestamp.version,
    status: "in-progress",
    provider: input.provider,
    brainStatus: "limited",
    restrictedMode: true,
    startedAt: state.startedAt ?? timestamp.iso,
    updatedAt: timestamp.iso,
  }));
}

export function provisionOneOnboardingStarterTeam(
  input: ProvisionOneOnboardingStarterTeamInput,
): OneOnboardingState {
  if (!isRecord(input)) throw new TypeError("Invalid starter team request");
  assertOnlyKeys(input, ["expectedVersion", "memberSlugs"], "Starter team request");
  assertExpectedVersion(input.expectedVersion);
  const slugs = normalizedStarterSlugs(input.memberSlugs, 2);

  let changed = false;
  const next = getDb().transaction(() => {
    const current = readOrCreateState();
    if (current.state.version !== input.expectedVersion) {
      throw new Error(`One onboarding changed (expected ${input.expectedVersion}, current ${current.state.version})`);
    }
    if (current.state.status === "migrated") return current.state;
    if (current.state.status === "dismissed") {
      throw new Error("Resume dismissed onboarding before changing its starter team");
    }
    if (current.state.status === "completed") {
      const stored = current.state.selectedStarterSlugs;
      const exactRepair = slugs.length === stored.length && slugs.every((slug) => stored.includes(slug));
      if (!exactRepair) {
        throw new Error("Completed onboarding can only repair its exact saved starter team");
      }
    }
    const timestamp = nextTimestamp(current.state.version);
    const members = starterGroupMembers(slugs, timestamp.iso);
    const existing = current.state.starterTeamGroupId ? getAgentGroup(current.state.starterTeamGroupId) : null;
    const group = existing
      ? updateAgentGroup(existing.id, {
          name: "Starter team",
          description: "One onboarding permanent starter team. Its exact pinned releases run at zero Hub credits for signed-in workspaces.",
          orchestratorName: "Las Orchestrator",
          members,
        })
      : createAgentGroup({
          name: "Starter team",
          description: "One onboarding permanent starter team. Its exact pinned releases run at zero Hub credits for signed-in workspaces.",
          orchestratorName: "Las Orchestrator",
          members,
        });
    const candidate: OneOnboardingState = {
      ...current.state,
      version: timestamp.version,
      status: current.state.status === "completed" ? "completed" : "in-progress",
      currentScene: current.state.status === "completed" ? "s6" : "s4",
      selectedStarterSlugs: slugs,
      starterTeamGroupId: group.id,
      startedAt: current.state.startedAt ?? timestamp.iso,
      updatedAt: timestamp.iso,
    };
    changed = true;
    return persist(current.raw, candidate);
  }).immediate();
  if (!changed) return next;
  tryRecordOneDomainEvent({
    eventType: "onboarding.step_resolved",
    occurredAt: next.updatedAt,
    actor: "user",
    entityId: next.oneId,
    version: next.version,
    visibility: "personal",
    entries: [
      { name: "stepId", value: "starter-team" },
      { name: "resolution", value: "saved" },
    ],
  });
  return next;
}

export async function completeOneOnboarding(input: CompleteOneOnboardingInput): Promise<OneOnboardingState> {
  if (!isRecord(input)) throw new TypeError("Invalid One onboarding completion");
  assertOnlyKeys(input, ["expectedVersion", "projectSeed", "expertSkip", "confirmedByUser"], "One onboarding completion");
  assertExpectedVersion(input.expectedVersion);
  if (input.confirmedByUser !== true) throw new Error("One onboarding completion requires explicit user confirmation");
  if (input.expertSkip !== undefined && typeof input.expertSkip !== "boolean") {
    throw new TypeError("expertSkip must be boolean");
  }
  const seed = cleanSeed(input.projectSeed);

  const before = readOrCreateState().state;
  if (before.status === "completed" || before.status === "migrated") return before;
  if (before.version !== input.expectedVersion) {
    throw new Error(`One onboarding changed (expected ${input.expectedVersion}, current ${before.version})`);
  }
  if (before.status === "dismissed") {
    throw new Error("Resume dismissed onboarding before completing it");
  }
  if (before.brainStatus === "connected") {
    if (!before.provider || !await mainOwnedProviderReady(before.provider).catch(() => false)) {
      throw new Error("The selected provider is no longer signed in and ready");
    }
  } else if (before.brainStatus !== "limited" || !before.restrictedMode) {
    throw new Error("Connect a runtime or explicitly choose limited mode first");
  }

  const next = mutate(input.expectedVersion, (state, timestamp) => {
    if (!state.starterTeamGroupId || !exactStarterGroupMatchesState(state, getAgentGroup(state.starterTeamGroupId))) {
      throw new Error("Restore the exact pinned starter team before finishing onboarding");
    }
    const next: OneOnboardingState = {
      ...state,
      version: timestamp.version,
      status: "completed",
      resolution: input.expertSkip ? "expert_skip" : "completed",
      currentScene: "s6",
      projectSeed: seed,
      completedAt: timestamp.iso,
      updatedAt: timestamp.iso,
    };
    return next;
  });
  tryRecordOneDomainEvent({
    eventType: "onboarding.step_resolved",
    occurredAt: next.updatedAt,
    actor: "user",
    entityId: next.oneId,
    version: next.version,
    visibility: "personal",
    entries: [
      { name: "stepId", value: "finish" },
      { name: "resolution", value: next.resolution ?? "completed" },
    ],
  });
  try {
    const intro = getOneFeatureIntroState();
    if (intro.acknowledgedIntroVersion < intro.currentIntroVersion) {
      acknowledgeOneFeatureIntro({
        expectedStoreVersion: intro.version,
        introVersion: intro.currentIntroVersion,
        resolution: "opened_one",
        confirmedByUser: true,
      });
    }
  } catch {
    // Onboarding completion remains durable; the intro can reconcile on reload.
  }
  return next;
}
