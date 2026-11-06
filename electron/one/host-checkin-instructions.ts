import { createHash } from "node:crypto";

/**
 * The check-in cap bounds what the model creates. An instruction the host itself writes (a product feature's scheduled briefing) registers
 * its exact text here, by SHA-256, and one active check-in per such instruction and per One is exempt from the cap. A model repeating the
 * exact text with new command ids is counted from the second one on.
 */
const digests = new Set<string>();
const digest = (instruction: string): string => createHash("sha256").update(instruction).digest("hex");
export function registerHostCheckinInstruction(sha256: string): void { digests.add(sha256); }
export function isHostCheckinInstruction(instruction: string): boolean { return digests.has(digest(instruction)); }
