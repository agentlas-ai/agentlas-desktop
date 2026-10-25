// Where a client connects to a local model server (Ollama / LM Studio / MLX).
//
// Dependency-free on purpose: the runners, the OS judge env and the terminal
// vendor copy all read the same rule, so one place decides it.
//
// The env values follow Ollama's own reading of OLLAMA_HOST (envconfig.Host):
//   - no scheme and no port → the server's default port ("0.0.0.0" → :11434, not :80)
//   - an explicit http:// or https:// without a port keeps that scheme's port
//   - an empty host (":11434") means this machine
// A bind address (0.0.0.0, [::], empty) is where a server LISTENS. Windows
// cannot connect to it (macOS and Linux quietly route it to loopback), so a
// client connects to 127.0.0.1 instead.

const UNSPECIFIED_HOSTS = new Set(["", "0.0.0.0", "[::]"]);

/** "localhost:1234"처럼 스킴이 없으면 http:// 보정하고 끝 슬래시를 제거한다. */
export function normalizeLocalHost(raw: string | undefined, fallback: string): string {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return fallback;
  const explicitScheme = /^https?:\/\//i.test(value);
  const withScheme = explicitScheme ? value : `http://${value}`;
  // "http://:11434" is not a parseable URL; Ollama reads the empty host as this machine.
  const text = withScheme.replace(/^(https?:\/\/):/i, "$1127.0.0.1:");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fallback;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
  if (UNSPECIFIED_HOSTS.has(url.hostname)) url.hostname = "127.0.0.1";
  if (!explicitScheme && !url.port) {
    try {
      url.port = new URL(fallback).port;
    } catch {
      // A fallback without a port keeps the scheme default.
    }
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export const OLLAMA_DEFAULT_HOST = "http://localhost:11434";
export const LMSTUDIO_DEFAULT_HOST = "http://localhost:1234";
export const MLX_DEFAULT_HOST = "http://localhost:8080";

/** 기본 로컬 호스트. env OLLAMA_HOST로 재정의 가능(원격 Ollama도 지원). */
export function ollamaHost(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeLocalHost(env.OLLAMA_HOST, OLLAMA_DEFAULT_HOST);
}
