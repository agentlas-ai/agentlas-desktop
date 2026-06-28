// MCP source — agentlas.cloud/api/mcp/v1 HTTPS 호출.
// Node 20+ 글로벌 fetch. 인증 토큰은 옵션 (anonymous read-only).
//
// 응답 실패/타임아웃 시 fallback으로 InMemorySource를 자동 사용 (오프라인 보호).
import type { FirmListing, MarketplaceListing, TeamBundle } from "../../shared/types";
import type { MarketplaceSource, SeedListingFull } from "./source";

interface McpSourceOptions {
  baseUrl: string;
  /** 인증 토큰 (있으면 cargo/builder 호출 가능) */
  bearer?: string;
  /** 요청 타임아웃 (ms) — 기본 15000 */
  timeoutMs?: number;
  /** 매 호출 직전에 평가되는 cookie 헤더 — agentlas_session=... 또는 null. 로그인 상태가 바뀔 수 있어 함수로 받는다. */
  cookieProvider?: () => string | null;
}

/** 원격 result를 배열로 정규화. 서버가 배열을 직접 주거나 {agents|firms|bundles|listings|items|results:[...]}
 *  로 감싸 주거나, 단일 객체를 줄 수 있다. 어떤 경우든 caller(.filter 등)가 깨지지 않도록 배열로 만든다. */
function asArray<T>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of [...keys, "items", "results", "data"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

export class McpSource implements MarketplaceSource {
  constructor(private opts: McpSourceOptions) {}

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.opts.baseUrl}/tools/call`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.bearer) headers.authorization = `Bearer ${this.opts.bearer}`;
      // 로그인되어 있으면 세션 cookie를 첨부 — server-side에서 인증된 사용자로 인식
      const cookie = this.opts.cookieProvider?.();
      if (cookie) headers.cookie = cookie;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: { name: method, arguments: params ?? {} } }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`MCP ${method} ${resp.status}`);
      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async listFirms(): Promise<FirmListing[]> {
    return asArray<FirmListing>(await this.call<unknown>("marketplace.list_firms", {}), "firms");
  }

  async listBundles(): Promise<TeamBundle[]> {
    return asArray<TeamBundle>(await this.call<unknown>("marketplace.list_bundles", {}), "bundles");
  }

  async searchAgents(q: string): Promise<MarketplaceListing[]> {
    return asArray<MarketplaceListing>(
      await this.call<unknown>("marketplace.search_agents", { q }),
      "agents",
      "listings",
    );
  }

  async getListingBySlug(
    slug: string,
  ): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>(
      "marketplace.get_manifest",
      { kind: "agent", slug },
    );
  }

  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.call<FirmListing | null>("marketplace.get_manifest", {
      kind: "firm",
      slug,
    });
  }

  // ── cargo.* — 로그인한 사용자가 만든 자기 에이전트 (인증 필요) ──────────
  /** 내 에이전트 목록 (cookieProvider가 세션 쿠키 첨부). */
  async listMyAgents(): Promise<MarketplaceListing[]> {
    return asArray<MarketplaceListing>(await this.call<unknown>("cargo.list_agents", {}), "agents", "listings");
  }

  /** 내 에이전트 풀 매니페스트 (설치용). slug 또는 "cargo:<id>" 모두 허용. */
  getMyAgentManifest(id: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>("cargo.get_manifest", { id });
  }
}
