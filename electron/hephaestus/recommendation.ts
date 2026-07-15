// 추천 바텀시트 백엔드 — routeOnly(실행 없음) 결정 JSON 을 렌더러용 Recommendation 으로 정규화.
//
// 엔진 결정 스키마는 느슨하다 — stormbreaker-supervisor.ts:summarizeRoute 와 동일하게
// 다중 폴백으로 방어적으로 읽는다.
//
// 비용 모델(BYOC): 이 앱은 사용자의 구독/키로 LLM 을 직접 호출한다("앱 자체 무료"). 따라서
//   · 로컬/내 클라우드 에이전트 → 별도 크레딧 없음(= 내 구독). estCredits=null.
//   · Hub 에서 빌린 에이전트 → 실제 perCallCredits(원시 decision.hub.results[] 에 살아있음).
// 라우터가 _selected_payload/_compact_hub_result 에서 cost_hints 를 떼므로 로컬 단가는
// 애초에 없고, BYOC 라 0 이 맞다. Hub 단가만 실측으로 노출한다(추정·휴리스틱 숫자는 쓰지 않음).
import type { JsonObject, OrchestrationTarget, Recommendation, RecAgent, RecStage } from "../../shared/types";

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function remoteEntityKind(value: Record<string, unknown>): "agent" | "team" | null {
  const raw = (str(value.entityKind) ?? str(value.entity_kind) ?? str(value.type) ?? "").toLowerCase();
  if (raw.includes("team") || raw.includes("firm") || raw.includes("company")) return "team";
  if (raw === "agent" || raw === "single-agent") return "agent";
  const agentCount = numOrNull(value.agentCount ?? value.agent_count);
  if (agentCount != null) return agentCount > 1 ? "team" : "agent";
  return null;
}

function remoteSource(decision: Record<string, unknown>, value: Record<string, unknown>): "cloud" | "hub" {
  const scope = (str(value.scope) ?? str(asObj(decision.hub).scope) ?? str(decision.scope) ?? "hub").toLowerCase();
  return scope === "cloud" || scope === "owner-cloud" ? "cloud" : "hub";
}

function localTarget(id: string, type: string): OrchestrationTarget {
  if (type.includes("group")) return { source: "local", entityKind: "group", groupId: id };
  if (type.includes("team") || type.includes("firm") || type.includes("company")) {
    return { source: "local", entityKind: "team", firmId: id };
  }
  return { source: "local", entityKind: "agent", agentId: id };
}

/** 원시 hub.results[] 에서 slug→perCallCredits 맵(compact 전이라 비용이 살아있다). */
function hubCreditIndex(decision: Record<string, unknown>): Map<string, number> {
  const idx = new Map<string, number>();
  for (const it of asArr(asObj(decision.hub).results)) {
    const o = asObj(it);
    const slug = str(o.slug);
    const credits = numOrNull(o.perCallCredits);
    if (slug && credits != null) idx.set(slug, credits);
  }
  return idx;
}

/** Hub 에이전트 비용 합 — null(미정) 은 합산에서 제외, 하나라도 알면 부분합을 보여준다. */
function sumHubCredits(agents: RecAgent[]): number | null {
  const known = agents.filter((a) => a.source === "hub" && a.estCredits != null);
  if (!known.length) return null;
  return known.reduce((s, a) => s + (a.estCredits ?? 0), 0);
}

/**
 * 라우터 결정 JSON(action: route|pipeline|hub_candidates|clarify|propose_new|refuse|…)을
 * 렌더러가 그대로 그릴 수 있는 정규형으로 변환한다. 알 수 없는/실행 불가 결정은 mode:"none".
 */
export function normalizeRecommendation(json: unknown, query: string): Recommendation {
  const decision = asObj(json);
  const action = str(decision.action) ?? str(decision.decision) ?? "none";
  const receiptId = str(decision.receipt_id) ?? str(decision.receiptId);
  const hubCredits = hubCreditIndex(decision);

  // Router Agent escalation: the engine attaches this on low-confidence
  // (clarify/propose_new) decisions so the host can resolve them with an LLM
  // reasoning pass instead of dead-ending on a weak clarify. Carried on every
  // mode; only present when the engine escalated.
  const ra = asObj(decision.router_agent);
  const raAgent = str(ra.agent);
  const raContext = asObj(ra.context);
  const routerAgent = raAgent
    ? {
        agent: raAgent,
        reason: str(ra.reason) ?? "",
        directive: str(ra.directive),
        ...(Object.keys(raContext).length ? { context: raContext as JsonObject } : {}),
      }
    : undefined;

  const base = (extra: Partial<Recommendation>): Recommendation => ({
    mode: "none",
    agents: [],
    totalEstCredits: null,
    estimate: true,
    rawAction: action,
    receiptId,
    query,
    ...(routerAgent ? { routerAgent } : {}),
    ...extra,
  });

  // ── route → single (로컬 에이전트 또는 firm/팀). BYOC 라 크레딧 없음(내 구독). ──
  if (action === "route") {
    const sel = asObj(decision.selected);
    const id = str(sel.id);
    if (!id) return base({ mode: "none" });
    const type = (str(sel.type) ?? "").toLowerCase();
    const isFirm = type.includes("team") || type.includes("firm") || type.includes("company");
    const name = str(sel.name_ko) ?? str(sel.name) ?? id;
    const canonical = str(asObj(sel.entrypoints).canonical_command);
    const agent: RecAgent = {
      id,
      name,
      source: "local",
      estCredits: null, // BYOC: 내 구독으로 실행
      canonicalCommand: canonical,
      isFirm,
      target: localTarget(id, type),
    };
    return base({ mode: "single", agents: [agent], totalEstCredits: null });
  }

  // ── pipeline → 단계별 임시 TF (PRD→build→QA 등). 로컬 카드라 BYOC(내 구독). ──
  if (action === "pipeline") {
    const stages: RecStage[] = [];
    const agents: RecAgent[] = [];
    asArr(decision.stages).forEach((s, i) => {
      const o = asObj(s);
      const order = numOrNull(o.order) ?? i + 1;
      const kind = str(o.stage) ?? str(o.kind) ?? "stage";
      const agentId = str(o.card) ?? str(o.agent);
      const agentName = str(o.name) ?? agentId; // pipeline.py 가 카드 name 을 단계에 실어준다
      stages.push({
        order,
        kind,
        agentId,
        agentName,
        produces: asArr(o.produces).map((x) => String(x)),
        consumes: asArr(o.consumes).map((x) => String(x)),
        estCredits: null,
      });
      if (agentId) agents.push({
        id: agentId,
        name: agentName ?? agentId,
        source: "local",
        estCredits: null,
        target: { source: "local", entityKind: "agent", agentId },
      });
    });
    if (!stages.length) return base({ mode: "none" });
    return base({ mode: "pipeline", agents, stages, totalEstCredits: null });
  }

  // ── hub_candidates → 네트워크 TF (Hub 에이전트를 빌려 로컬 실행). 실제 perCallCredits 노출. ──
  if (action === "hub_candidates") {
    const bySlug = new Map<string, Record<string, unknown>[]>();
    for (const it of asArr(asObj(decision.hub).results)) {
      const o = asObj(it);
      const slug = str(o.slug);
      if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), o]);
    }
    // execution.recommended_agents 가 단계 순서를 준다(있으면 우선).
    const orderedSlugs = asArr(asObj(decision.execution).recommended_agents)
      .map((r) => str(asObj(r).agent))
      .filter((x): x is string => Boolean(x));
    const selectedRows = orderedSlugs.length
      ? orderedSlugs.flatMap((slug) => {
          const matches = bySlug.get(slug) ?? [];
          return matches.length === 1 ? matches : [];
        })
      : [...bySlug.values()].flat().slice(0, 5);
    const agents: RecAgent[] = [];
    for (const o of selectedRows) {
      const slug = str(o.slug);
      if (!slug) continue;
      const source = remoteSource(decision, o);
      const entityKind = remoteEntityKind(o);
      if (!entityKind) continue;
      agents.push({
        id: slug,
        name: str(o.name) ?? str(o.nameEn) ?? slug,
        source,
        estCredits: source === "hub" ? hubCredits.get(slug) ?? null : null,
        target: { source, entityKind, slug },
      });
    }
    if (!agents.length) return base({ mode: "none" });
    return base({
      mode: agents.length > 1 ? "network" : "single",
      agents,
      totalEstCredits: sumHubCredits(agents),
    });
  }

  // ── clarify → 되물음 ──
  // 후보(candidates/suggestions)를 함께 실어 UI가 '수동 텍스트'가 아니라 클릭 가능한
  // 선택지로 승격할 수 있게 한다 — 답이 borrowAgents/에이전트 전환으로 바로 되돌아간다.
  if (action === "clarify") {
    const clarifyAgents: RecAgent[] = [];
    const seen = new Set<string>();
    for (const raw of [...asArr(decision.candidates), ...asArr(decision.suggestions)]) {
      const o = asObj(raw);
      const id = str(o.id) ?? str(o.slug);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const isLocal = id.startsWith("local/") || Boolean(str(o.id));
      const source = isLocal && !str(o.slug) ? "local" : remoteSource(decision, o);
      const type = (str(o.type) ?? str(o.entityKind) ?? "agent").toLowerCase();
      const remoteKind = source === "local" ? null : remoteEntityKind(o);
      if (source !== "local" && !remoteKind) continue;
      clarifyAgents.push({
        id,
        name: str(o.name_ko) ?? str(o.name) ?? str(o.nameEn) ?? id,
        source,
        estCredits: numOrNull(o.perCallCredits ?? o.per_call_credits),
        target: source === "local"
          ? localTarget(id, type)
          : { source, entityKind: remoteKind!, slug: str(o.slug) ?? id },
      });
      if (clarifyAgents.length >= 5) break;
    }
    return base({
      mode: "clarify",
      clarifyQuestion: str(decision.clarify_question),
      agents: clarifyAgents,
    });
  }

  // ── propose_new → 빌드 제안(라우팅할 적합 에이전트가 정말 없음). 렌더러가 빌드 바텀시트를 띄운다. ──
  if (action === "propose_new") {
    const reason =
      str(decision.reason) ??
      asArr(decision.reasons)
        .map((r) => str(r))
        .filter(Boolean)
        .join("; ");
    return base({ mode: "build", ...(reason ? { buildReason: reason } : {}) });
  }

  // ── refuse / hub_fallback / 기타 → 추천 없음(그냥 보내기 폴백) ──
  return base({ mode: "none" });
}
