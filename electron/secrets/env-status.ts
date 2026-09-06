import type { EnvVarMeta } from "../../shared/types";

type KnownEnv = Pick<EnvVarMeta, "key" | "requiredBy">;

/** A failed enumeration or one inaccessible key must not erase known requirements. */
export async function collectEnvStatus(
  known: KnownEnv[],
  deps: {
    listKeys: () => Promise<string[]>;
    hasValue: (key: string) => Promise<boolean>;
    preview: (key: string) => Promise<string | null>;
  },
): Promise<EnvVarMeta[]> {
  const entries = new Map(known.map((entry) => [entry.key, entry]));
  try {
    for (const key of await deps.listKeys()) {
      if (!entries.has(key)) entries.set(key, { key, requiredBy: [] });
    }
  } catch {
    // The separate value-free recovery list carries enumeration failure and its
    // exact user-action handle; unknown manual keys cannot be invented here.
  }
  return Promise.all([...entries.values()].map(async (entry): Promise<EnvVarMeta> => {
    try {
      const hasValue = await deps.hasValue(entry.key);
      const preview = hasValue ? await deps.preview(entry.key) : null;
      return { ...entry, hasValue, preview, credentialAccess: "available" };
    } catch {
      return { ...entry, hasValue: null, preview: null, credentialAccess: "unavailable" };
    }
  }));
}
