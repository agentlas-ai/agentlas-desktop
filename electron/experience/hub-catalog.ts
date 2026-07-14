import { webBaseUrl } from "../auth";
import type {
  ExperienceHubCatalogChip,
  ExperienceHubCatalogOffer,
  ExperienceHubCatalogResult,
} from "../../shared/types";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

type RawChip = {
  chipId?: unknown;
  releaseId?: unknown;
  title?: unknown;
  summary?: unknown;
  benefits?: unknown;
  author?: unknown;
  taskSignatures?: unknown;
  updatedAt?: unknown;
};

type RawOffer = {
  releaseId?: unknown;
  acquisition?: { mode?: unknown; durationDays?: unknown } | null;
  price?: { credits?: unknown } | null;
  status?: unknown;
};

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().normalize("NFC").slice(0, max) : "";
}

function publicId(value: unknown): string {
  const clean = text(value, 255);
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/.test(clean) ? clean : "";
}

function taskLabel(value: unknown): string | null {
  const id = text(value, 120).toLowerCase();
  const labels: Record<string, string> = {
    design: "디자인",
    "browser-automation": "브라우저 자동화",
    publishing: "게시·배포",
    research: "리서치",
    writing: "글쓰기",
    coding: "개발",
    marketing: "마케팅",
    automation: "자동화",
  };
  const suffix = id.split("/").pop() || "";
  return labels[suffix] ?? null;
}

async function publicJson(pathname: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(pathname, webBaseUrl()), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Hub returned ${response.status}`);
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Hub response is too large");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hub response is invalid");
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function offer(raw: RawOffer): ExperienceHubCatalogOffer | null {
  if (raw.status !== "active") return null;
  const credits = Number(raw.price?.credits);
  if (!Number.isInteger(credits) || credits < 1 || credits > 100_000) return null;
  if (raw.acquisition?.mode === "purchase") return { mode: "purchase", durationDays: null, credits };
  const durationDays = Number(raw.acquisition?.durationDays);
  if (raw.acquisition?.mode !== "term-lease" || ![7, 30, 90].includes(durationDays)) return null;
  return { mode: "lease", durationDays, credits };
}

export async function getExperienceHubCatalog(): Promise<ExperienceHubCatalogResult> {
  const checkedAt = new Date().toISOString();
  try {
    const [chipResponse, offerResponse] = await Promise.all([
      publicJson("/api/ontology/v1/public/operational-releases?limit=60"),
      publicJson("/api/ontology/v1/offers?kind=operational-experience&limit=100"),
    ]);
    const rawChips = Array.isArray(chipResponse.chips) ? chipResponse.chips as RawChip[] : [];
    const rawOffers = Array.isArray(offerResponse.offers) ? offerResponse.offers as RawOffer[] : [];
    const offersByRelease = new Map<string, ExperienceHubCatalogOffer[]>();
    for (const raw of rawOffers) {
      const releaseId = publicId(raw.releaseId);
      const projected = offer(raw);
      if (!releaseId || !projected) continue;
      offersByRelease.set(releaseId, [...(offersByRelease.get(releaseId) ?? []), projected]);
    }
    const chips = rawChips.flatMap((raw): ExperienceHubCatalogChip[] => {
      const chipId = publicId(raw.chipId);
      const releaseId = publicId(raw.releaseId);
      const title = text(raw.title, 120);
      const summary = text(raw.summary, 600);
      if (!chipId || !releaseId || !title || !summary) return [];
      const benefits = Array.isArray(raw.benefits)
        ? raw.benefits.map((value) => text(value, 600)).filter(Boolean).slice(0, 3)
        : [];
      const workLabels = Array.isArray(raw.taskSignatures)
        ? [...new Set(raw.taskSignatures.map(taskLabel).filter((value): value is string => Boolean(value)))].slice(0, 3)
        : [];
      const offers = [...(offersByRelease.get(releaseId) ?? [])].sort((left, right) => {
        const leftRank = left.mode === "purchase" ? 0 : left.durationDays ?? 999;
        const rightRank = right.mode === "purchase" ? 0 : right.durationDays ?? 999;
        return leftRank - rightRank || left.credits - right.credits;
      });
      if (offers.length === 0) return [];
      return [{
        title,
        summary,
        benefits: benefits.length ? benefits : [summary],
        author: text(raw.author, 120) || "Agentlas Hub",
        workLabels,
        offers,
        detailPath: `/ontology/${encodeURIComponent(chipId)}`,
        updatedAt: text(raw.updatedAt, 40) || null,
      }];
    });
    return { status: chips.length ? "ready" : "empty", chips, checkedAt };
  } catch {
    return {
      status: "unavailable",
      chips: [],
      checkedAt,
      message: "지금은 Hub 경험칩 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.",
    };
  }
}
