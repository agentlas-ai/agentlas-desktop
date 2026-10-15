import type { BusinessSession } from './context';

/** Original native identity. Organization sessions are independently issued. */
export interface BusinessNativeAssociationActor {
  readonly principalId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly oneId: string;
  readonly hostId: string;
}
export interface BusinessNativeInstallationIdentity {
  readonly nativeActor: BusinessNativeAssociationActor;
  readonly custodyGeneration: string;
  readonly installationGeneration: number;
}
/** Installation provenance only. This record is not an action/source grant.
 * origin/nativeActor/organizationSession retain the approved employee packet's
 * identities; neither native nor organization session is rewritten as the other. */
export interface BusinessNativeOrganizationAssociation extends BusinessNativeInstallationIdentity {
  readonly origin: { readonly authorityId: string; readonly recordId: string; readonly revision: string };
  readonly organizationSession: BusinessSession;
  readonly nativeSessionRevision: string;
  readonly sourceRevision: string;
}
/** Supplied only by the original native/source owner inside native composition.
 * captureCurrent must issue an opaque capability from the owner's authenticated
 * association registry, never accept a renderer/body DTO as proof. readCurrent
 * must recheck original session/source/revocation under that owner's custody.
 * Consumers retain the same receiver, functions and capability for its lifetime. */
export interface BusinessNativeOrganizationAssociationOwner {
  captureCurrent(input: Readonly<BusinessNativeInstallationIdentity & { organizationSession: BusinessSession }>): object | null;
  readCurrent(capability: object): BusinessNativeOrganizationAssociation | null;
}
