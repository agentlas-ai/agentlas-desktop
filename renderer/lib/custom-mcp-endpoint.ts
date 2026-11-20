/**
 * Why a typed MCP address cannot be added, as a closed word the form turns into one sentence.
 * One rule for the form and its button: the address is valid exactly when no problem is returned.
 */
export type CustomMcpEndpointProblem = "scheme" | "host" | "port" | "credentials" | "secret-query" | "fragment" | "invalid";

const SECRET_PARAM = /(?:token|key|secret|password|authorization|credential|signature)/iu;

export function customMcpEndpointProblem(value: string): CustomMcpEndpointProblem | null {
  const text = value.trim();
  if (/\s/u.test(text)) return "invalid";
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(text)?.[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "scheme";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // The URL parser throws for an empty host and for a port out of range; say which of the two it was.
    const authority = /^https?:\/\/([^/?#]*)/iu.exec(text)?.[1] ?? "";
    if (!authority) return "host";
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    if (!host || host.startsWith(":")) return "host";
    const port = /:(\d+)$/u.exec(host)?.[1];
    return port !== undefined && (Number(port) < 1 || Number(port) > 65535) ? "port" : "invalid";
  }
  if (!url.hostname) return "host";
  if (url.username || url.password) return "credentials";
  if (url.hash) return "fragment";
  if ([...url.searchParams.keys()].some((key) => SECRET_PARAM.test(key))) return "secret-query";
  return null;
}
