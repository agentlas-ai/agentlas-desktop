"use client";
// 플러그인 로고 타일 — 허브 화면·MCP 관리·One 컴포저가 같은 그림을 쓴다.
//
// 로고의 정본은 웹(agentlas.cloud/api/plugins)이다. 여기서는 파일을 들고 있지 않고
// `agentlas://plugin-icon/?slug=` 로 요청만 한다. main이 원격에서 한 번 받아 디스크에
// 두고 그 뒤로는 로컬에서 답하므로, 웹에서 로고를 바꾸면 캐시 만료 뒤 따라오고
// 오프라인에서도 한 번 본 로고는 계속 뜬다.
//
// 로고가 없는 플러그인에는 가짜 그림을 만들지 않는다 — 브랜드 컬러 + 모노그램
// 타일로 떨어진다(정직한 공백). 커스텀 MCP처럼 애초에 허브에 없는 항목도 같은 길.
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { PluginBrandAsset } from "@/lib/types";

/** Hub와 Desktop 카탈로그가 같은 도구를 다른 이름으로 부른다 (github-mcp ↔ github). */
function normalizeSlug(slug: string): string {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/^mcp[-_]/, "")
    .replace(/[-_]mcp$/, "")
    .replace(/[-_]server$/, "");
}

/**
 * 설치된 MCP 서버 행에서 허브 slug를 뽑는다.
 * · 카탈로그 설치 행 → catalogId
 * · 허브 브리지 등록 행 → 이름이 `<slug>:<서버이름>`
 * · 그 외(커스텀) → 이름 자체를 마지막 후보로 본다
 */
export function pluginSlugCandidates(input: {
  catalogId?: string | null;
  slug?: string | null;
  name?: string | null;
}): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const key = normalizeSlug(String(value ?? ""));
    if (key && !out.includes(key)) out.push(key);
  };
  push(input.slug);
  push(input.catalogId);
  const name = String(input.name ?? "");
  if (name.includes(":")) push(name.slice(0, name.indexOf(":")));
  push(name.replace(/\s+/g, "-"));
  return out;
}

let brandMapPromise: Promise<Record<string, PluginBrandAsset>> | null = null;

/** 브랜드 맵은 앱 전체에서 한 번만 받는다 — 카드 하나당 한 번씩 부르지 않는다. */
export function usePluginBrandMap(): Record<string, PluginBrandAsset> {
  const [map, setMap] = useState<Record<string, PluginBrandAsset>>({});
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api?.mcpTools?.brandMap) return;
    if (!brandMapPromise) brandMapPromise = api.mcpTools.brandMap().catch(() => ({}));
    void brandMapPromise.then((value) => {
      if (!cancelled) setMap(value ?? {});
    });
    return () => { cancelled = true; };
  }, []);
  return map;
}

type Props = {
  /** 허브 slug 또는 데스크탑 카탈로그 id. 정규화해서 맞춘다. */
  slug?: string | null;
  catalogId?: string | null;
  /** 표시 이름 — 모노그램 폴백과 허브 브리지 행의 slug 추출에 쓰인다. */
  name: string;
  size?: number;
  /** 허브에 로고가 없을 때 쓰는 데스크탑 카탈로그의 브랜드 컬러/모노그램. */
  brandColor?: string;
  mark?: string;
  brandMap?: Record<string, PluginBrandAsset>;
};

export function PluginLogo({ slug, catalogId, name, size = 28, brandColor, mark, brandMap }: Props) {
  const ownMap = usePluginBrandMap();
  const map = brandMap ?? ownMap;
  const [failed, setFailed] = useState(false);

  const candidates = pluginSlugCandidates({ slug, catalogId, name });
  const hit = candidates.map((key) => map[key]).find(Boolean);
  const iconSlug = hit ? normalizeSlug(hit.slug) : null;

  const radius = Math.round(size * 0.28);
  const monogram = (mark || hit?.name || name || "?").trim().charAt(0).toUpperCase();
  const tileColor = hit?.brandColor ?? brandColor ?? "var(--accent)";

  // 허브에 이 플러그인의 로고가 실제로 있을 때만 이미지 자리를 만든다.
  if (iconSlug && (hit?.iconUrl || hit?.brandGlyphUrl) && !failed) {
    const glyphOnly = !hit?.iconUrl && Boolean(hit?.brandGlyphUrl);
    return (
      <span
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: radius,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          // 단색 글리프는 브랜드 컬러 위에, 풀컬러 아이콘은 중립 배경 위에 얹는다.
          background: glyphOnly ? tileColor : "var(--paper)",
          border: glyphOnly ? "none" : "1px solid var(--paper-edge)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`agentlas://plugin-icon/?slug=${encodeURIComponent(iconSlug)}`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
          style={glyphOnly
            ? { width: "56%", height: "56%", objectFit: "contain", display: "block" }
            : { width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: radius,
        background: tileColor,
        color: "white",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-head)",
        fontWeight: 800,
        fontSize: Math.round(size * ((mark ?? "").length > 1 ? 0.4 : 0.48)),
      }}
    >
      {mark && mark.length > 1 ? mark : monogram}
    </span>
  );
}
