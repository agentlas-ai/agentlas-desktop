import fs from "node:fs";
import path from "node:path";
import { productCodexConfig, realCodexHome } from "../runtime/codex-product-home";

/**
 * What Science's own isolated Codex home takes from the person's Codex config: the same allowlist every other product
 * home uses (sign-in and provider plumbing, model default, telemetry opt-outs; runtime/codex-product-home.ts).
 * Science builds that home itself because its one MCP server is bound per grant, so without this the home held no
 * provider plumbing at all and a custom-provider or gateway account could not start a Science turn that a Work chat
 * could, and a person who had turned Codex analytics off was uploaded again here (owner decision 2026-10-17: every
 * product home keeps the person's telemetry opt-outs). Pure read; a missing or unreadable file yields nothing.
 */
export function scienceCodexProductConfig(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return productCodexConfig(fs.readFileSync(path.join(realCodexHome(env), "config.toml"), "utf8"));
  } catch {
    return "";
  }
}
