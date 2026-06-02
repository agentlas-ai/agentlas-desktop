import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { selectedMultimodalEnvKeys } from "../../shared/multimodal";
import type { InstalledAgent } from "../../shared/types";
import { agentFolderPath } from "../agents/files";
import { getMultimodalSettings } from "../multimodal/settings";
import { readEnvVar } from "../secrets/vault";

const DOTENV_FILES = [".env", ".env.local"];

export interface RunnerEnvResolution {
  env: NodeJS.ProcessEnv;
  injectedKeys: string[];
}

export async function buildRunnerEnv(
  agent: InstalledAgent | null,
  cwd?: string | null,
): Promise<RunnerEnvResolution> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const injected = new Set<string>();
  const apply = (values: Record<string, string>, overwrite: boolean) => {
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      if (!overwrite && env[key]) continue;
      env[key] = value;
      injected.add(key);
    }
  };

  apply(readDotEnvFile(path.join(app.getPath("userData"), "credentials.env")), false);
  apply(readDotEnvFile(path.join(os.homedir(), ".agentlas", "credentials.env")), false);
  if (cwd) apply(readDotEnvFiles(cwd), true);

  const agentDir = agent ? agent.localPath || agentFolderPath(agent.slug) : null;
  if (agentDir) apply(readDotEnvFiles(agentDir), true);

  const vaultKeys = new Set<string>();
  if (agent) {
    for (const req of agent.envRequirements) {
      if (req.key) vaultKeys.add(req.key);
    }
  }
  for (const key of selectedMultimodalEnvKeys(getMultimodalSettings())) {
    vaultKeys.add(key);
  }

  for (const key of vaultKeys) {
    if (env[key]) continue;
    const value = await readEnvVar(key);
    if (value) {
      env[key] = value;
      injected.add(key);
    }
  }

  const settings = getMultimodalSettings();
  env.AGENTLAS_MULTIMODAL_IMAGE_PROVIDER = settings.imageProvider;
  env.AGENTLAS_MULTIMODAL_VIDEO_PROVIDER = settings.videoProvider;
  env.AGENTLAS_MULTIMODAL_AUDIO_PROVIDER = settings.audioProvider;

  return { env, injectedKeys: [...injected].sort() };
}

export function readDotEnvFiles(dir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const file = path.join(dir, name);
    Object.assign(merged, parseDotEnv(readSmallText(file)));
  }
  return merged;
}

export function readDotEnvFile(file: string): Record<string, string> {
  return parseDotEnv(readSmallText(file));
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readSmallText(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
