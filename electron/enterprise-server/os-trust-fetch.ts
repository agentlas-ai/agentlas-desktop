/**
 * Main-only transport for every company-server request (status, device enrollment, seat-token refresh).
 *
 * Electron's net.fetch runs on Chromium's network stack, which verifies TLS against the operating system's trust store
 * (macOS Keychain, the Windows certificate store, NSS on Linux) and follows the system proxy. A company server signed by
 * an internal CA that IT installed on the machine is therefore trusted exactly as the rest of the app trusts it
 * (electron/usage/util.ts pickFetch, electron/runtime/native-cli.ts fetchStacks). Node's global fetch carries its own CA
 * bundle and refuses such a server, which the Settings card could only show as "couldn't reach the company server".
 *
 * TLS trust is only the transport. The server's Ed25519 key is still pinned by fingerprint on top of it: runtime.ts refuses
 * a status whose key is not the pinned one before an enrollment code leaves, and seat-token.ts accepts only tokens that
 * key signed. The pure modules (connection.ts, seat-token.ts, runtime.ts) never import Electron; Main injects this as
 * EnterpriseHost.fetchImpl (enterprise-server-ipc.ts, updater.ts).
 */
import { net } from "electron";

/** No HTTP cache (a license state must be read fresh) and no session cookies (the seat token is the only credential). */
export const enterpriseServerFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.href : (input as string | Request), { ...init, cache: "no-store", credentials: "omit" });
