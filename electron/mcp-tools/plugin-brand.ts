// Hub 플러그인 브랜드 자산(로고) 미러 — 웹이 정본이고 데스크탑은 따라간다.
//
// 배경(2026-08-16): 데스크탑은 이미 웹의 정본 카탈로그(`/api/plugins`)를 실시간으로
// 읽고 있었는데, 변환부가 `icon`/`brandGlyph`/`brandColor`를 버려서 화면에는 로고가
// 한 장도 뜨지 않았다. 로고를 손으로 데스크탑에 복사해 두면 웹에 플러그인이 추가될
// 때마다 사람이 동기화해야 하므로, 여기서는 **주소만 미러링**한다.
//
// 두 층으로 나뉜다:
//  1. brand map — slug -> {iconUrl, brandGlyphUrl, brandColor, monogram}.
//     `/api/plugins` 응답에서 뽑아 메모리+디스크에 캐시한다. 오프라인이면 디스크
//     사본으로 답한다(빈 화면 대신 마지막으로 본 진실).
//  2. 이미지 바이트 — `agentlas://plugin-icon/?slug=` 가 원격 이미지를 한 번 받아
//     디스크에 저장하고 그 뒤로는 로컬에서 답한다. 렌더러가 매 카드마다 외부로
//     나가지 않고, 한 번 본 로고는 오프라인에서도 뜬다.
//
// 로고가 없는 항목에 가짜 이미지를 만들지 않는다 — brandColor+monogram 타일로
// 폴백하는 판단은 렌더러가 한다(정직한 공백).
import { app, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { normalizePluginSlug } from "../../shared/plugin-slug";
import type { PluginBrandAsset } from "../../shared/types";
import { userDataPath } from "../runtime-paths";

const BRAND_CACHE_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
/** 로고 한 장의 상한 — 카탈로그 아이콘은 전부 수십 KB대다. */
const MAX_ICON_BYTES = 512 * 1024;

const ALLOWED_ICON_TYPES = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
]);

type BrandMap = Record<string, PluginBrandAsset>;

let memoryCache: { map: BrandMap; fetchedAt: number } | null = null;
let inFlight: Promise<BrandMap> | null = null;

function hubOrigin(): string {
  const raw = process.env.AGENTLAS_MCP_BASE_URL ?? "https://agentlas.cloud/api/mcp/v1";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://agentlas.cloud";
  }
}

/** 상대 경로(`/plugins/github/icon.png`)를 허브 절대 URL로 올린다. */
function absoluteAssetUrl(value: unknown, origin: string): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/")) return undefined;
  return `${origin}${raw}`;
}

function brandCacheFile(): string {
  return userDataPath("plugin-brands.v1.json");
}

function iconCacheDir(): string {
  return userDataPath("plugin-icons");
}

function readDiskBrandMap(): { map: BrandMap; fetchedAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(brandCacheFile(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { fetchedAt?: unknown; map?: unknown };
    if (!record.map || typeof record.map !== "object") return null;
    return {
      map: record.map as BrandMap,
      fetchedAt: Number.isFinite(Number(record.fetchedAt)) ? Number(record.fetchedAt) : 0,
    };
  } catch {
    return null;
  }
}

function writeDiskBrandMap(map: BrandMap, fetchedAt: number): void {
  try {
    fs.mkdirSync(path.dirname(brandCacheFile()), { recursive: true });
    fs.writeFileSync(brandCacheFile(), JSON.stringify({ fetchedAt, map }), "utf8");
  } catch {
    /* 캐시 실패는 기능 실패가 아니다 — 다음 호출이 네트워크로 답한다 */
  }
}

/**
 * 브랜드 맵의 키는 **정규화된 slug**다. Hub와 Desktop 카탈로그가 같은 도구를 다른
 * 이름으로 부르기 때문이다(hub:github-mcp ↔ desktop:github — shared/plugin-slug 참고).
 */
export function pluginBrandKey(slug: string): string {
  return normalizePluginSlug(slug);
}

function brandFromApiRow(raw: Record<string, unknown>, origin: string): PluginBrandAsset | null {
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!slug) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : slug;
  const iconUrl = absoluteAssetUrl(raw.icon, origin);
  const brandGlyphUrl = absoluteAssetUrl(raw.brandGlyph, origin);
  const brandColor = typeof raw.brandColor === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.brandColor.trim())
    ? raw.brandColor.trim()
    : undefined;
  // 아무 표식도 없으면 저장하지 않는다 — 빈 항목은 렌더러의 모노그램 폴백과 같다.
  if (!iconUrl && !brandGlyphUrl && !brandColor) return null;
  return {
    slug,
    name,
    ...(iconUrl ? { iconUrl } : {}),
    ...(brandGlyphUrl ? { brandGlyphUrl } : {}),
    ...(brandColor ? { brandColor } : {}),
  };
}

async function fetchBrandMap(): Promise<BrandMap> {
  const origin = hubOrigin();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${origin}/api/plugins`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`hub plugin catalog ${response.status}`);
    const json = (await response.json()) as { plugins?: unknown };
    const rows = Array.isArray(json?.plugins) ? json.plugins : [];
    const map: BrandMap = {};
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const brand = brandFromApiRow(row as Record<string, unknown>, origin);
      if (brand) map[pluginBrandKey(brand.slug)] = brand;
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * slug -> 브랜드 자산. 네트워크가 죽어도 마지막 디스크 사본으로 답한다.
 * 사본조차 없으면 빈 맵 — 렌더러가 모노그램 타일로 그린다.
 */
export async function getPluginBrandMap(): Promise<BrandMap> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.fetchedAt < BRAND_CACHE_TTL_MS) return memoryCache.map;
  if (!memoryCache) {
    const disk = readDiskBrandMap();
    if (disk) {
      memoryCache = disk;
      // 디스크 사본이 아직 신선하면 네트워크를 건드리지 않는다.
      if (now - disk.fetchedAt < BRAND_CACHE_TTL_MS) return disk.map;
    }
  }
  if (inFlight) return inFlight;
  inFlight = fetchBrandMap()
    .then((map) => {
      memoryCache = { map, fetchedAt: Date.now() };
      writeDiskBrandMap(map, memoryCache.fetchedAt);
      return map;
    })
    .catch(() => memoryCache?.map ?? {})
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** 캐시를 거치지 않은 동기 조회 — 이미 받아 둔 맵만 본다(프로토콜 핸들러용). */
function cachedBrand(slug: string): PluginBrandAsset | null {
  const key = pluginBrandKey(slug);
  if (memoryCache?.map[key]) return memoryCache.map[key];
  const disk = readDiskBrandMap();
  if (disk) {
    memoryCache = disk;
    return disk.map[key] ?? null;
  }
  return null;
}

function iconCachePathFor(key: string, ext: string): string {
  return path.join(iconCacheDir(), `${key}.${ext}`);
}

function findCachedIcon(key: string): { file: string; type: string } | null {
  for (const [type, ext] of ALLOWED_ICON_TYPES) {
    const file = iconCachePathFor(key, ext);
    if (fs.existsSync(file)) return { file, type };
  }
  return null;
}

/**
 * `agentlas://plugin-icon/?slug=<slug>` 처리.
 *
 * 1) 디스크에 있으면 그대로 준다(오프라인에서도 뜬다).
 * 2) 없으면 허브에서 한 번 받아 저장하고 준다.
 * 3) 로고가 없는 플러그인이면 404 — 렌더러가 모노그램으로 그린다.
 */
export async function servePluginIconRequest(requestUrl: string): Promise<Response> {
  let slug = "";
  try {
    slug = new URL(requestUrl).searchParams.get("slug")?.trim() ?? "";
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const key = pluginBrandKey(slug);
  if (!key || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) return new Response("bad request", { status: 400 });

  const cached = findCachedIcon(key);
  if (cached) {
    return new Response(new Uint8Array(fs.readFileSync(cached.file)), {
      status: 200,
      headers: {
        "Content-Type": cached.type,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const brand = cachedBrand(slug) ?? (await getPluginBrandMap())[key] ?? null;
  const remote = brand?.iconUrl ?? brand?.brandGlyphUrl;
  if (!remote) return new Response("not found", { status: 404 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(remote, { signal: controller.signal });
    if (!response.ok) return new Response("not found", { status: 404 });
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = ALLOWED_ICON_TYPES.get(contentType);
    // 이미지가 아닌 응답(로그인 리다이렉트 HTML 등)은 저장하지 않는다.
    if (!ext) return new Response("not found", { status: 404 });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) {
      return new Response("not found", { status: 404 });
    }
    try {
      fs.mkdirSync(iconCacheDir(), { recursive: true });
      fs.writeFileSync(iconCachePathFor(key, ext), bytes);
    } catch {
      /* 저장 실패해도 이번 응답은 정상으로 준다 */
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  } finally {
    clearTimeout(timer);
  }
}
