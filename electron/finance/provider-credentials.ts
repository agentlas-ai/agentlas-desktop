/** Host-only credentials. Discovery never reads a secret or starts a native keychain prompt. */
const KEY = 'ALPHAVANTAGE_API_KEY';
export async function financeProviderKey(): Promise<string | null> {
  try {
    const { readEnvVar } = await import('../secrets/vault');
    return (await readEnvVar(KEY))?.trim() || process.env[KEY]?.trim() || null;
  } catch {
    const configured = process.env[KEY]?.trim();
    if (configured) return configured;
    throw new Error('finance_provider_credentials_unavailable');
  }
}
export async function financeProviderPresence(): Promise<'present' | 'missing' | 'unknown'> {
  if (process.env[KEY]?.trim()) return 'present';
  try {
    const { envVarPresence } = await import('../secrets/vault');
    return envVarPresence(KEY);
  } catch { return 'unknown'; }
}
