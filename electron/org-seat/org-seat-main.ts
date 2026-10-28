import { fetchWithHubSession, getSessionCookieHeader, onAuthSessionOwnershipChanged, onAuthSessionRestored, webBaseUrl } from "../auth";
import { userDataDir } from "../runtime-paths";
import { deleteApiKey, readApiKey, saveApiKey } from "../secrets/vault";
import { fileStateStore, ORG_SYNC_INTERVAL_MS, orgSeatStatusOf, revokeOrgSeatKeys, runOrgSeatSync, type OrgSeatDeps, type OrgSeatStatus } from "./org-seat-sync";

function realDeps(): OrgSeatDeps {
  return {
    ...fileStateStore(userDataDir()),
    async fetchSync() {
      const cookie = getSessionCookieHeader();
      if (!cookie) return null;
      try {
        const res = await fetchWithHubSession(cookie, `${webBaseUrl()}/api/desktop/org/sync`, { headers: { "x-agentlas-client": "desktop", accept: "application/json" } }, 10_000);
        return { status: res.status, body: await res.json().catch(() => null) };
      } catch { return null; }
    },
    readKey: backend => readApiKey(backend),
    saveKey: (backend, value) => saveApiKey(backend, value),
    deleteKey: backend => deleteApiKey(backend),
    now: () => Date.now(),
  };
}

/**
 * Starts the team-seat key sync for this app process: once at start, at every sign-in restore, every 10 minutes, and a
 * revoke when the session is lost. Failures are swallowed on purpose: a broken sync must never take the app down, and the
 * 24-hour offline limit in runOrgSeatSync still ends access.
 */
export function startOrgSeatSync(): () => void {
  const deps = realDeps();
  // One chain: a revoke can never interleave with a sync that is about to write the keys back.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (job: () => Promise<unknown>) => { chain = chain.then(job, job).catch(() => undefined); return chain; };
  const sync = () => enqueue(() => runOrgSeatSync(deps));
  const stopRestored = onAuthSessionRestored(() => void sync());
  // Sign-out, a lost session and an account switch all change who owns this app: the team keys leave with the previous person.
  const stopOwnership = onAuthSessionOwnershipChanged(() => void enqueue(() => revokeOrgSeatKeys(deps)));
  const timer = setInterval(() => void sync(), ORG_SYNC_INTERVAL_MS); timer.unref?.();
  const first = setTimeout(() => void sync(), 15_000); first.unref?.();
  return () => { clearInterval(timer); clearTimeout(first); stopRestored(); stopOwnership(); };
}

/** The account menu's team line: read from the local state file, never the network. */
export async function orgSeatStatus(): Promise<OrgSeatStatus> {
  return orgSeatStatusOf(await fileStateStore(userDataDir()).loadState());
}
