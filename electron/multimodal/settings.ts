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
import { isProviderReady, resolveActiveProvider } from "./availability";

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
  const autoResolved = new Map<MultimodalModality, string>();
  for (const modality of modalities) {
    const resolved = await resolveActiveProvider(modality, settings);
    if (resolved.via === "auto" && resolved.provider) autoResolved.set(modality, resolved.provider.id);
  }

  const out: MultimodalProviderStatus[] = [];
  for (const provider of MULTIMODAL_PROVIDERS) {
    const env = await Promise.all(
      provider.envKeys.map(async (key) => ({ key, hasValue: await hasEnvVar(key) })),
    );
    out.push({
      modality: provider.modality,
      provider,
      env,
      ready: await isProviderReady(provider),
      auto: autoResolved.get(provider.modality) === provider.id,
    });
  }
  return out;
}
