/** Environment for generated code and workspace-confined shells, never provider CLIs.
 * Ambient host credentials and interpreter startup hooks are not task grants.
 * Explicit credentials belong to the host's existing tool/secret broker.
 */
const CREDENTIAL_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:_|$)/i;
const HOST_AUTH_OR_STARTUP = /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|DBUS_SESSION_BUS_ADDRESS|DATABASE_URL|MONGODB_URI|ATLAS_MONGODB_URI|REDIS_URL|PGPASSWORD|GOOGLE_APPLICATION_CREDENTIALS|AWS_SHARED_CREDENTIALS_FILE|GIT_ASKPASS|SSH_ASKPASS|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONINSPECT|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|BASH_FUNC_.*)$/i;

export function sandboxChildEnvironment(base: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (CREDENTIAL_NAME.test(name) || HOST_AUTH_OR_STARTUP.test(name)
      || /^(?:TMPDIR|TMP|TEMP)$/i.test(name)) delete env[name];
  }
  // All spellings point at this invocation's owned directory, on every OS.
  return { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
}
