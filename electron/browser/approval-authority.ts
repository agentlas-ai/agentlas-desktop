import { randomUUID } from "node:crypto";
import type { BrowserApprovalRequestEvent } from "../../shared/types";

type Authority = {
  owner: NonNullable<BrowserApprovalRequestEvent["owner"]>;
  permission: "read" | "write" | "full";
  signal: AbortSignal;
};
const authorities = new Map<string, Authority>();

/** Only the Main MCP builder can mint authority; request bodies carry an opaque handle. */
export function registerBrowserApprovalAuthority(
  owner: Authority["owner"], permission: Authority["permission"],
): { token: string; revoke: () => void } {
  const token = randomUUID();
  const controller = new AbortController();
  authorities.set(token, { owner: Object.freeze({ ...owner }), permission, signal: controller.signal });
  return { token, revoke: () => { authorities.delete(token); controller.abort(); } };
}

export function resolveBrowserApprovalAuthority(token: unknown): Authority | null {
  return typeof token === "string" ? authorities.get(token) ?? null : null;
}
