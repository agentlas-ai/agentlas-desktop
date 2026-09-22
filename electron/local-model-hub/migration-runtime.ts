import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../store/db";
import type { LocalModelHubSnapshotPort } from "./ports";
import { OllamaMigrationService } from "./migration";

/** Production adapter: the only external read root is Ollama's documented per-user model store. */
export function createOllamaMigrationService(manager: LocalModelHubSnapshotPort): OllamaMigrationService {
  return new OllamaMigrationService({
    db: getDb(),
    snapshot: () => manager.snapshot(),
    ollamaModelRoots: [join(homedir(), ".ollama", "models")],
  });
}
