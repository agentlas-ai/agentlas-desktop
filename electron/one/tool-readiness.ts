import { createHash } from 'node:crypto';
import { MCP_TOOL_CATALOG } from '../mcp-tools/catalog';
import { listInstalledServers, getServer } from '../mcp-tools/registry';
import { testServerById } from '../mcp-tools/client';
import { getOneProfile } from '../store/one-profile';
import { getCredentialStateRevision, getEnvConfigurationRevision } from '../secrets/vault';
import { supervisorIdentifier, supervisorObject } from '../../shared/one-supervisor';
import type { OneToolReadiness, OneToolReadinessState } from '../../shared/one-harness';
import type { InstalledMcpServer, McpServerStatus } from '../../shared/types';

const observations = new Map<string, { fingerprint: string; oneId: string; credentialRevision: string; status: McpServerStatus }>();
let scopedCredentialRevision = 0;
const credentialRevision = () => `${scopedCredentialRevision}:${getCredentialStateRevision()}:${getEnvConfigurationRevision()}`;
export function invalidateOneToolReadiness(): void { scopedCredentialRevision += 1; observations.clear(); }
const pending = new Map<string, Promise<McpServerStatus>>();
const FRESHNESS_MS = 60_000;
function fingerprint(server: InstalledMcpServer): string {
  return createHash('sha256').update(JSON.stringify(server)).digest('hex');
}

export function classifyOneToolReadiness(server: InstalledMcpServer | null, status: McpServerStatus | null): { state: OneToolReadinessState; reasonCode: string | null; nextAction: OneToolReadiness['nextAction'] } {
  if (!server) return { state: 'not-installed', reasonCode: 'tool_not_installed', nextAction: 'install' };
  if (!server.enabled) return { state: 'disabled', reasonCode: 'tool_disabled', nextAction: 'enable' };
  if (server.configurationValid === false) return { state: 'needs-configuration', reasonCode: 'tool_configuration_invalid', nextAction: 'configure' };
  if (!status) return { state: 'unknown', reasonCode: 'tool_connection_not_observed', nextAction: 'probe' };
  if (status.missingEnv.length) return { state: 'needs-configuration', reasonCode: 'tool_required_credential_missing', nextAction: 'configure' };
  if (status.connected) return { state: 'ready', reasonCode: null, nextAction: null };
  if (status.deferred) return { state: 'unknown', reasonCode: 'tool_interactive_connection_pending', nextAction: 'probe' };
  if (status.failureCode === 'authentication_required') return { state: 'needs-auth', reasonCode: 'tool_authentication_required', nextAction: 'connect' };
  return { state: 'offline', reasonCode: status.failureCode ?? 'tool_connection_unavailable', nextAction: 'probe' };
}

/** Passive reads never start a browser or OAuth. An explicit probe observes one server. */
export async function oneToolReadiness(raw: { oneId: string; query?: string; probeServerId?: string }): Promise<OneToolReadiness[]> {
  const row = supervisorObject(raw, ['oneId', 'query', 'probeServerId']);
  const oneId = supervisorIdentifier(row.oneId);
  if (getOneProfile().oneId !== oneId) throw new Error('one_harness_identity_changed');
  if (row.query !== undefined && (typeof row.query !== 'string' || row.query.length > 200)) throw new Error('one_tool_query_invalid');
  if (row.probeServerId !== undefined) {
    const id = supervisorIdentifier(row.probeServerId);
    const server = getServer(id);
    if (!server || !server.enabled) throw new Error('one_tool_probe_unavailable');
    const key = oneId + ':' + id;
    const admittedCredentialRevision = credentialRevision();
    let probe = pending.get(key);
    if (!probe) { probe = testServerById(id); pending.set(key, probe); }
    try {
      const status = await probe;
      if (getOneProfile().oneId !== oneId) throw new Error('one_harness_identity_changed');
      const current = getServer(id);
      if (!current || fingerprint(current) !== fingerprint(server) || credentialRevision() !== admittedCredentialRevision) throw new Error('one_tool_configuration_changed');
      observations.set(key, { fingerprint: fingerprint(server), oneId, credentialRevision: admittedCredentialRevision, status });
      if (observations.size > 256) observations.delete(observations.keys().next().value!);
    } finally { if (pending.get(key) === probe) pending.delete(key); }
  }
  const installed = listInstalledServers();
  const candidates = [
    ...MCP_TOOL_CATALOG.map(entry => ({ id: entry.id, installed: installed.find(server => server.catalogId === entry.id) ?? null,
      label: entry.name, description: entry.description, category: entry.category })),
    ...installed.filter(server => !server.catalogId || !MCP_TOOL_CATALOG.some(entry => entry.id === server.catalogId))
      .map(server => ({ id: server.id, installed: server, label: server.name, description: server.nameEn, category: 'custom' })),
  ];
  const query = typeof row.query === 'string' ? row.query.trim().toLocaleLowerCase() : '';
  return candidates.filter(item => !query || (item.label + ' ' + item.description + ' ' + item.id).toLocaleLowerCase().includes(query)).slice(0, 200).map(item => {
    const cached = item.installed ? observations.get(oneId + ':' + item.installed.id) : undefined;
    const valid = cached && item.installed && cached.fingerprint === fingerprint(item.installed)
      && cached.credentialRevision === credentialRevision()
      && Number.isFinite(Date.parse(cached.status.checkedAt)) && Date.now() - Date.parse(cached.status.checkedAt) >= 0
      && Date.now() - Date.parse(cached.status.checkedAt) <= FRESHNESS_MS;
    const status = valid ? cached.status : null;
    return { id: item.id, installedServerId: item.installed?.id ?? null, label: item.label, description: item.description,
      category: item.category, ...classifyOneToolReadiness(item.installed, status), observedAt: status?.checkedAt ?? null,
      tools: (status?.tools ?? []).slice(0, 256).map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description.slice(0, 400) } : {}) })) };
  });
}
