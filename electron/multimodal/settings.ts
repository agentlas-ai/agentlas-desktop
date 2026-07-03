import {
  DEFAULT_MULTIMODAL_SETTINGS,
  MULTIMODAL_PROVIDERS,
  normalizeMultimodalSettings,
  type MultimodalModality,
  type MultimodalProvider,
  type MultimodalProviderStatus,
  type MultimodalSettings,
} from "../../shared/multimodal";
import { hasEnvVar } from "../secrets/vault";
import { getMeta, setMeta } from "../store/meta";
import { resolveActiveProvider } from "./availability";

const META_KEY = "multimodal_settings";

export function listMultimodalProviders(): MultimodalProvider[] {
  return MULTIMODAL_PROVIDERS;
}

export function getMultimodalSettings(): MultimodalSettings {
  const raw = getMeta(META_KEY);
  if (!raw) return { ...DEFAULT_MULTIMODAL_SETTINGS };
  try {
    return normalizeMultimodalSettings(JSON.parse(raw) as Partial<MultimodalSettings>);
  } catch {
    return { ...DEFAULT_MULTIMODAL_SETTINGS };
  }
}

export function saveMultimodalSettings(input: Partial<MultimodalSettings>): MultimodalSettings {
  const current = getMultimodalSettings();
  const next = normalizeMultimodalSettings({
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  });
  setMeta(META_KEY, JSON.stringify(next));
  return next;
}

export async function getMultimodalStatus(): Promise<MultimodalProviderStatus[]> {
  const settings = getMultimodalSettings();
  const modalities: MultimodalModality[] = ["image", "video", "audio"];
  const out: MultimodalProviderStatus[] = [];
  for (const modality of modalities) {
    // auto면 실제 가용성 기준으로 확정된 엔진을 status로 보여준다("자동 → codex(준비됨)").
    const resolved = await resolveActiveProvider(modality, settings);
    if (!resolved.provider) continue;
    const env = await Promise.all(
      resolved.provider.envKeys.map(async (key) => ({ key, hasValue: await hasEnvVar(key) })),
    );
    out.push({
      modality,
      provider: resolved.provider,
      env,
      ready: resolved.ready,
      auto: resolved.via === "auto",
    });
  }
  return out;
}
