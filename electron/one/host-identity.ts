import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { userDataPath } from '../runtime-paths';
import { mobileBridgeHostIdentityPath } from '../mobile-bridge/pairing';

/** Existing enrolled Mobile host identity wins. Reading never creates pairing/configuration. */
export function oneNativeHostIdentity(): { hostId: string; label: string; pairedIdentityAvailable: boolean } {
  const directory = fs.realpathSync(userDataPath());
  try {
    const value = JSON.parse(fs.readFileSync(mobileBridgeHostIdentityPath(directory), 'utf8')) as { hostId?: unknown };
    if (typeof value.hostId === 'string' && /^host_[a-f0-9]{32}$/.test(value.hostId)) {
      return { hostId: value.hostId, label: os.hostname(), pairedIdentityAvailable: true };
    }
  } catch { /* A local owner window may operate without activating Mobile pairing. */ }
  const nativeProfile = createHash('sha256').update(JSON.stringify([directory, os.hostname(), os.userInfo().uid, process.platform])).digest('hex');
  return { hostId: `desktop_${nativeProfile.slice(0, 32)}`, label: os.hostname(), pairedIdentityAvailable: false };
}
