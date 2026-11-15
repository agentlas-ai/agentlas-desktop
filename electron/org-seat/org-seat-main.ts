import { app, powerMonitor } from "electron";
import { fetchWithHubSession, getSessionCookieHeader, onAuthSessionOwnershipChanged, onAuthSessionRestored, webBaseUrl } from "../auth";
import { userDataDir } from "../runtime-paths";
import { deleteApiKey, readApiKey, saveApiKey } from "../secrets/vault";
import { fileStateStore, ORG_SYNC_INTERVAL_MS, orgSeatStatusOf, revokeOrgSeatKeys, runOrgSeatSync, type OrgSeatDeps, type OrgSeatStatus } from "./org-seat-sync";

/** How often an account with no seat may ask on focus or wake. It has no timer; this only bounds the signal-driven asks. */
const NO_SEAT_ASK_INTERVAL_MS = 60 * 60_000;

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
 * Starts the team-seat key sync for this app process (Desktop Main only). It asks the server:
 *  - once at start and at every sign-in restore (this is how an account first learns it has a seat);
 *  - when the window regains focus or the machine wakes, if the last ask is older than ORG_SYNC_INTERVAL_MS (a seat account) or
 *    older than an hour (an account with no seat: a seat granted while the app stays open is found without a restart);
 *  - at "last ask + ORG_SYNC_INTERVAL_MS", but only while the stored state says this account has a seat (orgId). A seat the admin
 *    removes must still take the team keys away within that bound, and the 24-hour offline limit needs a pass to run, so this one
 *    timer is kept for seat accounts. An account with no seat has no timer and sends nothing between the signals above.
 * A revoke runs when the session is lost. Failures are swallowed on purpose: a broken sync must never take the app down, and the
 * 24-hour offline limit in runOrgSeatSync still ends access.
 */
export function startOrgSeatSync(): () => void {
  const deps = realDeps();
  // One chain: a revoke can never interleave with a sync that is about to write the keys back.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (job: () => Promise<unknown>) => { chain = chain.then(job, job).catch(() => undefined); return chain; };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAskAt = 0;
  const hasSeat = async () => !!(await deps.loadState().catch(() => null))?.orgId;
  // Re-aims the single timer after every pass: set only while this account has a seat.
  const aim = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopped || !(await hasSeat()) || stopped || timer) return;
    timer = setTimeout(() => { timer = null; void ask(); }, Math.max(1_000, lastAskAt + ORG_SYNC_INTERVAL_MS - Date.now()));
    timer.unref?.();
  };
  const ask = () => {
    lastAskAt = Date.now();
    return enqueue(() => runOrgSeatSync(deps)).then(aim);
  };
  // Focus and wake. A seat account asks when its last ask is older than the sync interval. An account with no seat asks at
  // most once an hour, and only on these signals: that is how a seat granted while the app stays open is found without
  // a restart.
  const askIfStale = () => {
    if (stopped || Date.now() - lastAskAt < ORG_SYNC_INTERVAL_MS) return;
    void hasSeat().then(seat => {
      // ask() stamps lastAskAt at once, so a burst of focus events sends one request.
      if (stopped || Date.now() - lastAskAt < (seat ? ORG_SYNC_INTERVAL_MS : NO_SEAT_ASK_INTERVAL_MS)) return undefined;
      return ask();
    });
  };
  const stopRestored = onAuthSessionRestored(() => void ask());
  // Sign-out, a lost session and an account switch all change who owns this app: the team keys leave with the previous person.
  const stopOwnership = onAuthSessionOwnershipChanged(() => void enqueue(() => revokeOrgSeatKeys(deps)).then(aim));
  const first = setTimeout(() => void ask(), 15_000); first.unref?.();
  let detach = () => {};
  try {
    app.on("browser-window-focus", askIfStale);
    powerMonitor.on("resume", askIfStale);
    detach = () => { app.removeListener("browser-window-focus", askIfStale); powerMonitor.removeListener("resume", askIfStale); };
  } catch { /* no window events here: the signals above and the seat timer still run */ }
  return () => { stopped = true; if (timer) clearTimeout(timer); timer = null; clearTimeout(first); stopRestored(); stopOwnership(); detach(); };
}

/** The account menu's team line: read from the local state file, never the network. */
export async function orgSeatStatus(): Promise<OrgSeatStatus> {
  return orgSeatStatusOf(await fileStateStore(userDataDir()).loadState());
}
