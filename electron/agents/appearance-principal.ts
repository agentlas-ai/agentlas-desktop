import { getAuthSession } from "../auth";

/** Who owns the chosen faces: the signed-in account (and workspace), or this computer when nobody is signed in. Throws when the account is not known yet. */
export function appearancePrincipal(): string {
  const session = getAuthSession();
  if (session.signedIn && !session.accountFingerprint) throw Error("appearance_owner_unknown");
  return JSON.stringify(session.signedIn ? ["account", session.accountFingerprint, session.workspaceId ?? null] : ["local"]);
}
