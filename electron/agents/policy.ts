import { createHash } from "node:crypto";

type AgentLike = {
  slug?: string | null;
  name?: string | null;
  nameEn?: string | null;
  name_en?: string | null;
  tagline?: string | null;
  taglineEn?: string | null;
  tagline_en?: string | null;
  builtin?: number | boolean | null;
  role?: string | null;
  visibility?: string | null;
};

export type AgentVisibility = "visible" | "background" | "private";

const PRIVATE_WEB_AGENT_FINGERPRINTS = new Set([
  "880db20e11cd945e5777b5aaf73c10f24de3e2e190d13631b5f3ed0e4796821c",
  "a0dba10416f15dac84202902284780ee23f31eda9dc068ccf6a28276b585ea36",
  "479d879189166bf9bde1b0cd939db746bf8c1b94f2aad553d08cf7b4a2204f9e",
  "79c16e0347312aceb57c0ec7ee6bb6ebd0118984cc716f9cd56db63d18679183",
  "56ff55fcc909461b5fc449fdb3d685c6cceeb10d59836d9a91faf3ceb41896a4",
  "978dd8a262d86397bbdaca13bbec5be313a68fb2d5c609330888818641af8079",
]);

const BACKGROUND_AGENT_FINGERPRINTS = new Set([
  "9011fb75e638676e23a36f86ea689b6e4de17cb5b5954b36810b5239ab077f0b",
  "0331d654916d648797d31598e3e18eb7fd49166e91783ab9d731648b6e855b90",
]);

const BACKGROUND_ROLES = new Set(["orchestrator", "pm", "curator", "governance"]);

function normalize(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeAgentVisibility(value: string | null | undefined): AgentVisibility | null {
  const normalized = normalize(value);
  if (normalized === "visible" || normalized === "background" || normalized === "private") {
    return normalized;
  }
  return null;
}

function fingerprint(value: string | null | undefined): string | null {
  const normalized = normalize(value);
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

function fingerprintsFor(agent: AgentLike): string[] {
  return [
    agent.slug,
    agent.name,
    agent.nameEn,
    agent.name_en,
    agent.tagline,
    agent.taglineEn,
    agent.tagline_en,
  ]
    .map(fingerprint)
    .filter((value): value is string => Boolean(value));
}

export function isPrivateWebOnlyAgent(agent: AgentLike): boolean {
  if (normalizeAgentVisibility(agent.visibility) === "private") return true;
  if (normalize(agent.role) === "meta") return true;
  return fingerprintsFor(agent).some((value) => PRIVATE_WEB_AGENT_FINGERPRINTS.has(value));
}

export function isBackgroundAgent(agent: AgentLike): boolean {
  if (isPrivateWebOnlyAgent(agent)) return false;
  if (normalizeAgentVisibility(agent.visibility) === "background") return true;
  if (Boolean(agent.builtin) && BACKGROUND_ROLES.has(normalize(agent.role))) return true;
  return fingerprintsFor(agent).some((value) => BACKGROUND_AGENT_FINGERPRINTS.has(value));
}

export function publicAgentVisibility(agent: AgentLike): AgentVisibility {
  if (isPrivateWebOnlyAgent(agent)) return "private";
  if (isBackgroundAgent(agent)) return "background";
  return normalizeAgentVisibility(agent.visibility) ?? "visible";
}

export function isPublicDesktopAgent(agent: AgentLike): boolean {
  return publicAgentVisibility(agent) !== "private";
}
