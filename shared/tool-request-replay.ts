import { createHash } from "node:crypto";

/** One instance per adapter invocation. Only unchanged request observations
 * participate; completions, approvals and status frames must bypass it. */
export class ToolRequestReplayGuard {
  private readonly signatures = new Map<string, string>();

  accept(id: string | undefined, name: string, args?: string, scope?: string): boolean {
    // Missing provider identity cannot prove a replay of the same operation.
    if (!id) return true;
    const key = JSON.stringify([scope ?? null, id]);
    const signature = createHash("sha256").update(JSON.stringify([name, args ?? null])).digest("hex");
    if (this.signatures.get(key) === signature) return false;
    // Keep changed observations, including A -> B -> A. Bound memory without
    // guessing that an untracked operation is a duplicate when the limit hits.
    if (this.signatures.has(key) || this.signatures.size < 4096) this.signatures.set(key, signature);
    return true;
  }
}
