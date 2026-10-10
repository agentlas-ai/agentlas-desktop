import type { OnePersonalDataAPI, PersonalDataTarget, PersonalDataSourceState, PersonalDataSpaceLink } from './one-personal-data';
export interface OnePersonalDataBootstrap {
  state: 'ready' | 'blocked'; target: PersonalDataTarget | null;
  targets: Array<{ target: PersonalDataTarget; label: string }>;
  creatableScopes: Array<{ scope: PersonalDataTarget['scope']; organizationId: string | null; projectId: string | null; label: string }>;
  budgetId: string | null; bindingKey: string; errorCode: string | null;
}
import type {OnePersonalIntegrationsNativeAPI} from './one-personal-integrations';
export interface OnePersonalDataNativeAPI extends OnePersonalDataAPI, OnePersonalIntegrationsNativeAPI {
  bootstrap(targetKey?: string): Promise<OnePersonalDataBootstrap>;
  listTargets(): Promise<OnePersonalDataBootstrap['targets']>;
  createTarget(input: { commandId: string; scope: PersonalDataTarget['scope']; organizationId: string | null; projectId: string | null; title: string }): Promise<OnePersonalDataBootstrap>;
  selectTarget(input: { target: PersonalDataTarget }): Promise<OnePersonalDataBootstrap>;
  connectorCatalog(input: { target: PersonalDataTarget }): Promise<Array<{ connectorId: string; label: string; state: 'available' | 'permission-required' | 'unavailable' }>>;
  registerSource(input: { target: PersonalDataTarget; connectorId: string }): Promise<PersonalDataSourceState>;
  openSpaceLink(input: { target: PersonalDataTarget; link: PersonalDataSpaceLink }): Promise<void>;
}
