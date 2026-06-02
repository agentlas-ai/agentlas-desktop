import {
  DEFAULT_MULTIMODAL_SETTINGS,
  MULTIMODAL_PROVIDERS,
  normalizeMultimodalSettings,
  selectedMultimodalProviders,
  type MultimodalProvider,
  type MultimodalProviderStatus,
  type MultimodalSettings,
} from "../../shared/multimodal";
import { hasEnvVar } from "../secrets/vault";
import { getMeta, setMeta } from "../store/meta";

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
  const providers = selectedMultimodalProviders(settings);
  return Promise.all(
    providers.map(async (provider) => {
      const env = await Promise.all(
        provider.envKeys.map(async (key) => ({ key, hasValue: await hasEnvVar(key) })),
      );
      return {
        modality: provider.modality,
        provider,
        env,
        ready: env.every((entry) => entry.hasValue),
      };
    }),
  );
}
