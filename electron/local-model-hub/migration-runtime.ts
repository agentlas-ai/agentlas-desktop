import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../store/db";
import type { LocalModelHubManager } from "./manager";
import { OllamaMigrationService } from "./migration";

/** Production adapter: the only external read root is Ollama's documented per-user model store. */
export function createOllamaMigrationService(manager: LocalModelHubManager): OllamaMigrationService {
  return new OllamaMigrationService({
    db: getDb(),
    snapshot: () => manager.snapshot(),
    ollamaModelRoots: [join(homedir(), ".ollama", "models")],
  });
}
