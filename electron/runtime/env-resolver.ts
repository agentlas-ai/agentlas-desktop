import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { InstalledAgent } from "../../shared/types";
import { agentFolderPath } from "../agents/files";
import { resolveActiveProvider } from "../multimodal/availability";
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

  // 멀티모달 엔진을 실행 전에 결정적으로 확정한다(런타임 LLM이 사다리를 되짚지 않게).
  // auto면 키리스 우선 순서로 첫 가용 엔진을 고르고, 그 엔진의 키만 주입한다.
  const settings = getMultimodalSettings();
  const [image, video, audio] = await Promise.all([
    resolveActiveProvider("image", settings),
    resolveActiveProvider("video", settings),
    resolveActiveProvider("audio", settings),
  ]);
  for (const resolved of [image, video, audio]) {
    if (resolved.provider) {
      for (const key of resolved.provider.envKeys) vaultKeys.add(key);
    }
  }

  for (const key of vaultKeys) {
    if (env[key]) continue;
    const value = await readEnvVar(key);
    if (value) {
      env[key] = value;
      injected.add(key);
    }
  }

  // 확정된 엔진 id + 준비 여부를 env로 넘긴다. 에이전트는 이 값을 "그대로 써라"만 하면 된다.
  env.AGENTLAS_MULTIMODAL_IMAGE_PROVIDER = image.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_IMAGE_READY = image.ready ? "1" : "0";
  env.AGENTLAS_MULTIMODAL_VIDEO_PROVIDER = video.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_VIDEO_READY = video.ready ? "1" : "0";
  env.AGENTLAS_MULTIMODAL_AUDIO_PROVIDER = audio.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_AUDIO_READY = audio.ready ? "1" : "0";

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
