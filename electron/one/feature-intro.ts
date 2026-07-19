import { randomUUID } from "node:crypto";
import {
  ONE_FEATURE_INTRO_CONTRACT_VERSION,
  ONE_FEATURE_INTRO_CURRENT_VERSION,
  isOneFeatureIntroBlockingStateCategory,
  isOneFeatureIntroResolution,
  isOneFeatureIntroState,
  type AcknowledgeOneFeatureIntroInput,
  type DeferOneFeatureIntroInput,
  type OneFeatureIntroAcknowledgement,
  type OneFeatureIntroDeferral,
  type OneFeatureIntroState,
} from "../../shared/one-feature-intro";
import { getDb } from "../store/db";
import { getOneProfile } from "../store/one-profile";
import { tryRecordOneDomainEvent } from "./domain-events";

export const ONE_FEATURE_INTRO_META_KEY = "agentlas.one.feature-intro.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
}

function assertPositiveVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSupportedIntroVersion(value: unknown): asserts value is number {
  assertPositiveVersion(value, "introVersion");
  if (Number(value) > ONE_FEATURE_INTRO_CURRENT_VERSION) {
    throw new RangeError(`introVersion ${value} is newer than this Desktop runtime`);
  }
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function opaqueRef(prefix: "one_intro_ack" | "one_intro_defer"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function initialState(oneId: string): OneFeatureIntroState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_FEATURE_INTRO_CONTRACT_VERSION,
    oneId,
    version,
    currentIntroVersion: ONE_FEATURE_INTRO_CURRENT_VERSION,
    acknowledgedIntroVersion: 0,
    acknowledgements: [],
    deferrals: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneFeatureIntroState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One Feature Intro state is corrupt; it was not overwritten");
  }
  if (!isOneFeatureIntroState(parsed)) {
    throw new Error("Stored One Feature Intro state violates its closed contract; it was not overwritten");
  }
  return parsed;
}

function assertOneBinding(state: OneFeatureIntroState): void {
  const currentOneId = getOneProfile().oneId;
  if (state.oneId !== currentOneId) {
    throw new Error("Stored One Feature Intro belongs to a different One identity; it was not overwritten");
  }
}

function readOrCreateState(): { raw: string; state: OneFeatureIntroState } {
  const profile = getOneProfile();
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_FEATURE_INTRO_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState(profile.oneId));
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_FEATURE_INTRO_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_FEATURE_INTRO_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One Feature Intro state");
  const state = parseState(row.value);
  assertOneBinding(state);
  return { raw: row.value, state };
}

function assertExpectedStoreVersion(state: OneFeatureIntroState, expectedStoreVersion: number): void {
  if (state.version !== expectedStoreVersion) {
    throw new Error(`One Feature Intro state changed (expected ${expectedStoreVersion}, current ${state.version})`);
  }
}

function persist(currentRaw: string, next: OneFeatureIntroState): OneFeatureIntroState {
  if (!isOneFeatureIntroState(next)) throw new Error("Refused to persist invalid One Feature Intro state");
  const result = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
    .run(JSON.stringify(next), ONE_FEATURE_INTRO_META_KEY, currentRaw);
  if (result.changes !== 1) {
    throw new Error("One Feature Intro state changed concurrently; refresh and retry");
  }
  return next;
}

export function getOneFeatureIntroState(): OneFeatureIntroState {
  return readOrCreateState().state;
}

export function acknowledgeOneFeatureIntro(input: AcknowledgeOneFeatureIntroInput): OneFeatureIntroState {
  if (!isRecord(input)) throw new TypeError("Invalid One Feature Intro acknowledgement");
  assertOnlyKeys(input, ["expectedStoreVersion", "introVersion", "resolution", "confirmedByUser"], "One Feature Intro acknowledgement");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertSupportedIntroVersion(input.introVersion);
  if (!isOneFeatureIntroResolution(input.resolution)) throw new TypeError("Invalid One Feature Intro resolution");
  if (input.confirmedByUser !== true) throw new Error("One Feature Intro acknowledgement requires an explicit user confirmation");

  const current = readOrCreateState();
  const existing = current.state.acknowledgements.find((item) => item.introVersion === input.introVersion);
  if (existing) {
    if (existing.resolution !== input.resolution) {
      throw new Error("This One Feature Intro version was already acknowledged with a different resolution");
    }
    return current.state;
  }
  // A delayed renderer request may never move the acknowledged watermark backwards.
  if (input.introVersion < current.state.acknowledgedIntroVersion) return current.state;
  assertExpectedStoreVersion(current.state, input.expectedStoreVersion);

  const timestamp = nextTimestamp(current.state.version);
  const acknowledgement: OneFeatureIntroAcknowledgement = {
    introVersion: input.introVersion,
    resolution: input.resolution,
    acknowledgementRef: opaqueRef("one_intro_ack"),
    acknowledgedAt: timestamp.iso,
  };
  const next = persist(current.raw, {
    ...current.state,
    version: timestamp.version,
    acknowledgedIntroVersion: Math.max(current.state.acknowledgedIntroVersion, input.introVersion),
    acknowledgements: [...current.state.acknowledgements, acknowledgement]
      .sort((left, right) => left.introVersion - right.introVersion),
    updatedAt: timestamp.iso,
  });
  tryRecordOneDomainEvent({
    eventId: `event:${acknowledgement.acknowledgementRef}`,
    eventType: "feature_intro.acknowledged",
    occurredAt: acknowledgement.acknowledgedAt,
    actor: "user",
    entityId: next.oneId,
    version: next.version,
    visibility: "personal",
    entries: [
      { name: "introVersion", value: acknowledgement.introVersion },
      { name: "resolution", value: acknowledgement.resolution },
      { name: "acknowledgementRef", value: acknowledgement.acknowledgementRef },
    ],
  });
  return next;
}

export function deferOneFeatureIntro(input: DeferOneFeatureIntroInput): OneFeatureIntroState {
  if (!isRecord(input)) throw new TypeError("Invalid One Feature Intro deferral");
  assertOnlyKeys(input, ["expectedStoreVersion", "introVersion", "blockingStateCategory"], "One Feature Intro deferral");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertSupportedIntroVersion(input.introVersion);
  if (!isOneFeatureIntroBlockingStateCategory(input.blockingStateCategory)) {
    throw new TypeError("Invalid One Feature Intro blockingStateCategory");
  }

  const current = readOrCreateState();
  // Deferral is not acknowledgement. After acknowledgement there is also no
  // reason to create a misleading post-acknowledgement deferral event.
  if (current.state.acknowledgedIntroVersion >= input.introVersion) return current.state;
  const duplicate = current.state.deferrals.some((item) =>
    item.introVersion === input.introVersion
    && item.blockingStateCategory === input.blockingStateCategory);
  if (duplicate) return current.state;
  assertExpectedStoreVersion(current.state, input.expectedStoreVersion);

  const timestamp = nextTimestamp(current.state.version);
  const deferral: OneFeatureIntroDeferral = {
    introVersion: input.introVersion,
    blockingStateCategory: input.blockingStateCategory,
    deferralRef: opaqueRef("one_intro_defer"),
    deferredAt: timestamp.iso,
  };
  const next = persist(current.raw, {
    ...current.state,
    version: timestamp.version,
    deferrals: [...current.state.deferrals, deferral],
    updatedAt: timestamp.iso,
  });
  tryRecordOneDomainEvent({
    eventId: `event:${deferral.deferralRef}`,
    eventType: "feature_intro.deferred",
    occurredAt: deferral.deferredAt,
    actor: "system",
    entityId: next.oneId,
    version: next.version,
    visibility: "personal",
    entries: [
      { name: "introVersion", value: deferral.introVersion },
      { name: "blockingStateCategory", value: deferral.blockingStateCategory },
    ],
  });
  return next;
}
