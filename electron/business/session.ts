import { isBusinessId, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';

/** Implemented by the existing authenticated Main/session integrator, never renderer JSON. */
export interface BusinessNativeSessionPort {
  current(): Promise<BusinessSession | null>;
  selectOrganization(input: { organizationId: string; expectedSession: BusinessSession }): Promise<BusinessSession>;
  logout(input: { expectedSession: BusinessSession }): Promise<void>;
}
export interface BusinessSessionInvalidation {
  clearOrganization(input: { deploymentId: string; identityAuthorityId: string; principalId: string; hostId: string; organizationId: string }): void;
}
export class DesktopBusinessSession {
  private readonly localDenied = new Set<string>();
  private transitionGeneration = 0;
  constructor(
    private readonly port: BusinessNativeSessionPort | null,
    readonly hostId: string,
    readonly deploymentId: string,
    private readonly invalidation: BusinessSessionInvalidation | null = null,
    private readonly now: () => number = Date.now,
  ) {
    if (!isBusinessId(hostId) || !isBusinessId(deploymentId)) throw new Error('invalid_request');
  }

  async current(): Promise<BusinessSession | null> {
    if (!this.port) return null;
    try {
      const session = await this.port.current();
      if (!isBusinessSession(session) || session.hostId !== this.hostId || session.deploymentId !== this.deploymentId
        || Date.parse(session.expiresAt) <= this.now() || this.localDenied.has(this.authGeneration(session))) return null;
      return Object.freeze({ ...session });
    } catch { return null; }
  }

  async stillCurrent(expected: BusinessSession): Promise<boolean> {
    const current = await this.current();
    return current !== null && sameBusinessSession(current, expected);
  }

  async selectOrganization(organizationId: string): Promise<BusinessSession> {
    const generation = ++this.transitionGeneration;
    const previous = await this.current();
    if (generation !== this.transitionGeneration || !previous || !this.port || !isBusinessId(organizationId)) throw new Error('session_mismatch');
    const next = await this.port.selectOrganization({ organizationId, expectedSession: previous });
    if (generation !== this.transitionGeneration || !isBusinessSession(next) || next.organizationId !== organizationId || next.principalId !== previous.principalId
      || next.hostId !== this.hostId || next.deploymentId !== this.deploymentId || Date.parse(next.expiresAt) <= this.now()
      || !(await this.stillCurrent(next)) || generation !== this.transitionGeneration) throw new Error('session_mismatch');
    this.invalidate(previous);
    return Object.freeze({ ...next });
  }

  /** Local metadata invalidation happens even if remote logout fails. No foreign scope is cleared. */
  async logout(): Promise<{ localCleared: boolean; remote: 'confirmed' | 'unknown' }> {
    ++this.transitionGeneration;
    const previous = await this.current();
    if (!previous) return { localCleared: false, remote: 'unknown' };
    // Session revision/expiry refresh is not a fresh login. Fence synchronously before remote work.
    this.localDenied.add(this.authGeneration(previous));
    let localCleared = true;
    try { this.invalidate(previous); } catch { localCleared = false; }
    try { await this.port!.logout({ expectedSession: previous }); return { localCleared, remote: 'confirmed' }; }
    catch { return { localCleared, remote: 'unknown' }; }
  }

  private invalidate(session: BusinessSession): void {
    this.invalidation?.clearOrganization({ deploymentId: session.deploymentId, identityAuthorityId: session.identityAuthorityId, principalId: session.principalId,
      hostId: session.hostId, organizationId: session.organizationId });
  }
  private authGeneration(session: BusinessSession): string {
    return JSON.stringify([session.identityAuthorityId, session.deploymentId, session.principalId, session.hostId,
      session.sessionId, session.authEpoch]);
  }
}
