import { nodeCanChangeTheOutsideWorld } from "./graph-node-protocol";
/**
 * `.agentgraph` 패키징 — 그래프를 **남에게 줄 수 있는 형태**로 만든다.
 *
 * 계약 두 줄(터미널 `engine/graph/package.cjs`와 글자 단위로 같은 규칙이며,
 * `scripts/test-graph-package-parity.cjs`가 두 벌이 같은 판단을 하는지 대조한다):
 *  1) 지울 수 없는 비밀이 하나라도 남으면 **내보내지 않는다**. 몰래 지우고 통과시키면
 *     사용자는 자기 키가 빠진 줄 알고 공유하게 된다.
 *  2) 모델 고정은 유통될 수 없다. 받는 사람의 기본 모델로 돌아야 하므로 등급 힌트로 바꾼다.
 *
 * 여기서 만드는 건 **자료 하나**다. 파일로 저장하든 Hub에 올리든 그건 바깥의 일이고,
 * 이 모듈은 "무엇을 지웠고 무엇을 채워야 하는지"까지 패키지 안에 적어 둔다.
 * 받는 쪽은 그 목록을 채우기 전까지 **미바인딩 상태**로 설치된다 — Hub 서버의
 * `HubEntityKind`가 graph를 agent와 다르게 다루는 이유와 같다.
 */
import { createHash } from "node:crypto";
import type { Automation, WorkflowGraph, WorkflowNode } from "./types";

export const GRAPH_PACKAGE_SCHEMA_VERSION = "agentgraph/1.0";

/** 값이 자격증명처럼 보이는가 — 형태 판정만 한다(의미 판정 아님). */
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\beyJ[A-Za-z0-9._-]{30,}/,
];

/** 키 이름이 비밀을 담기로 되어 있는가. 값이 비어 있어도 템플릿 대상이다. */
const SECRET_KEY_RE = /(token|secret|password|passwd|apikey|api_key|credential|private_key|access_key)/i;

/** 로컬 사용자 경로 — 남의 기계에서 의미가 없고, 계정명이 그대로 드러난다. */
const PERSONAL_PATH_RE = /(\/Users\/[^/\s"']+|\/home\/[^/\s"']+|C:\\Users\\[^\\\s"']+)/g;

export interface GraphScrubFinding {
  rule: "secret-field" | "model-pin" | "personal-path";
  nodeId: string;
  field: string;
  action: string;
}

export interface GraphPackageBlocker {
  nodeId: string;
  field: string;
  reason: string;
  nextAction: string;
}

export interface GraphVaultEntry {
  key: string;
  kind: "secret";
  requiredBy: string[];
  sourceField: string;
}

function vaultKeyFor(key: string): string {
  return String(key).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function looksSecretValue(value: unknown): boolean {
  return typeof value === "string" && SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

export function scrubNodeConfig(nodeId: string, config: Record<string, unknown> | undefined): {
  config: Record<string, unknown>;
  findings: GraphScrubFinding[];
  vaultTemplate: GraphVaultEntry[];
  blockers: GraphPackageBlocker[];
} {
  const out: Record<string, unknown> = {};
  const findings: GraphScrubFinding[] = [];
  const vaultTemplate: GraphVaultEntry[] = [];
  const blockers: GraphPackageBlocker[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    // 1) 비밀로 선언된 칸 — 값 유무와 무관하게 금고 변수로 바꾼다.
    if (SECRET_KEY_RE.test(key)) {
      const vaultKey = vaultKeyFor(key);
      out[key] = `\${vault.${vaultKey}}`;
      vaultTemplate.push({ key: vaultKey, kind: "secret", requiredBy: [nodeId], sourceField: key });
      findings.push({ rule: "secret-field", nodeId, field: key, action: `templated:${vaultKey}` });
      continue;
    }
    // 2) 비밀처럼 생긴 값이 엉뚱한 칸에 있으면 — 자동 치환하지 않고 막는다.
    //    이름 없는 칸의 비밀은 무엇을 채워야 하는지 우리가 알 수 없다.
    if (looksSecretValue(value)) {
      blockers.push({
        nodeId,
        field: key,
        reason: `"${key}" 값이 자격증명처럼 보입니다. 어떤 키인지 알 수 없어 자동으로 빈칸 처리할 수 없습니다.`,
        nextAction: `이 값을 금고 변수로 바꾼 뒤(예: \${vault.MY_TOKEN}) 다시 내보내세요.`,
      });
      out[key] = value;
      continue;
    }
    // 3) 모델 고정 — 받는 사람 기계엔 그 모델이 없다. 등급 힌트로 바꾼다.
    if (key === "model" && typeof value === "string" && value) {
      out.tierHint = "standard";
      findings.push({ rule: "model-pin", nodeId, field: key, action: "replaced:runner-primary" });
      continue;
    }
    // 4) 개인 경로 — 계정명이 그대로 드러난다.
    if (typeof value === "string" && PERSONAL_PATH_RE.test(value)) {
      out[key] = value.replace(PERSONAL_PATH_RE, "<사용자 폴더>");
      findings.push({ rule: "personal-path", nodeId, field: key, action: "removed" });
      PERSONAL_PATH_RE.lastIndex = 0;
      continue;
    }
    out[key] = value;
  }
  return { config: out, findings, vaultTemplate, blockers };
}

export function graphDigestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export interface GraphPackage {
  manifest: {
    schemaVersion: string;
    slug: string;
    name: string;
    version: string;
    exportedAt: string;
    trigger: { kind: "input" | "cron"; schedule: string | null };
    dependencies: {
      agents: Array<{ nodeId: string; slug: string; source: "hub" | "local"; inheritedFromAutomation?: true }>;
      mcp: Array<{ serverSlug: string; requiredBy: string[] }>;
      subGraphs: unknown[];
    };
    vaultTemplate: GraphVaultEntry[];
    modelPolicy: { binding: "runner-primary" };
    permissionsSummary: {
      mutationNodes: Array<{ nodeId: string; label: string }>;
      leasedAgents: string[];
    };
    scrubReport: { rulesVersion: string; scrubbedAt: string; findings: GraphScrubFinding[] };
    integrity: { graphDigest: string; manifestDigest: string | null };
  };
  graph: WorkflowGraph;
}

export type BuildGraphPackageResult =
  | { blocked: true; blockers: GraphPackageBlocker[]; findings: GraphScrubFinding[] }
  | { blocked: false; blockers: []; findings: GraphScrubFinding[]; package: GraphPackage };

export function graphPackageSlug(name: string): string {
  return String(name || "graph").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "graph";
}

export function buildGraphPackage(input: {
  automation: Pick<Automation, "name"> & {
    target_id?: string | null;
    target_type?: string | null;
    trigger_type?: string | null;
    schedule?: string | null;
  };
  graph: WorkflowGraph;
  version?: string;
  now?: string;
}): BuildGraphPackageResult {
  const { automation, graph } = input;
  const findings: GraphScrubFinding[] = [];
  const vaultTemplate: GraphVaultEntry[] = [];
  const blockers: GraphPackageBlocker[] = [];
  const nodes: WorkflowNode[] = [];
  const dependencies: GraphPackage["manifest"]["dependencies"] = { agents: [], mcp: [], subGraphs: [] };

  for (const node of graph.nodes ?? []) {
    const scrubbed = scrubNodeConfig(node.id, node.config as Record<string, unknown> | undefined);
    findings.push(...scrubbed.findings);
    vaultTemplate.push(...scrubbed.vaultTemplate);
    blockers.push(...scrubbed.blockers);
    nodes.push({ ...node, config: scrubbed.config } as WorkflowNode);

    // 에이전트 참조는 핀으로 남긴다 — 받는 사람이 무엇을 빌려야 하는지 알아야 한다.
    // 노드가 ref를 선언하지 않으면 자동화의 대상 에이전트를 상속한다(제품의 실제 동작).
    // 그 경우를 빼면 패키지가 "채울 것 없음"이라고 거짓말한다.
    // judgment-exempt: 이건 "바깥을 바꾸나"가 아니라 "이 단계가 **에이전트를 굴리나**"다.
    //   받는 사람이 무엇을 빌려야 하는지 정하는 질문이라, mutation 인 code 노드는
    //   여기 해당되지 않는다(빌릴 에이전트가 없다). 정본과 답이 다른 게 정상이다.
    const isAgentish = node.type === "agent" || node.type === "action" || node.type === "output";
    const cfg = node.config as Record<string, unknown> | undefined;
    const ref = typeof cfg?.ref === "string" && cfg.ref ? cfg.ref : null;
    const inheritedSlug = automation.target_id || null;
    const slug = ref || (isAgentish && node.type === "agent" ? inheritedSlug : null);
    if (isAgentish && slug) {
      const source = (ref ? cfg?.targetType : automation.target_type) === "hub" ? "hub" : "local";
      if (!dependencies.agents.some((dep) => dep.slug === slug)) {
        dependencies.agents.push({
          nodeId: node.id, slug, source,
          ...(ref ? {} : { inheritedFromAutomation: true as const }),
        });
      }
    }
    const server = cfg?.mcpServer;
    if (typeof server === "string" && server && !dependencies.mcp.some((m) => m.serverSlug === server)) {
      dependencies.mcp.push({ serverSlug: server, requiredBy: [node.id] });
    }
  }

  if (blockers.length > 0) return { blocked: true, blockers, findings };

  const mutationNodes = nodes
    // 받는 사람에게 "바깥으로 나가는 단계"를 알리는 목록이다. 선언된 effect 만 보면
    // 발행용 출력 노드가 빠져 설치 전 경고가 조용히 새다.
    .filter((n) => nodeCanChangeTheOutsideWorld(n as { type?: string; config?: Record<string, unknown> }))
    .map((n) => ({ nodeId: n.id, label: n.label || n.id }));

  const scrubbedGraph = {
    version: graph.version ?? 1,
    nodes,
    edges: graph.edges ?? [],
    ...(graph.budget ? { budget: graph.budget } : {}),
  } as WorkflowGraph;

  const nowIso = input.now ?? new Date().toISOString();
  const manifest: GraphPackage["manifest"] = {
    schemaVersion: GRAPH_PACKAGE_SCHEMA_VERSION,
    slug: graphPackageSlug(automation.name),
    name: automation.name,
    version: input.version || "1.0.0",
    exportedAt: nowIso,
    trigger: {
      kind: automation.trigger_type && automation.trigger_type !== "schedule" ? "input" : "cron",
      schedule: automation.schedule ?? null,
    },
    dependencies,
    vaultTemplate,
    modelPolicy: { binding: "runner-primary" },
    // 받는 사람이 설치 전에 알아야 하는 것 — 무엇이 바깥으로 나가는가.
    permissionsSummary: {
      mutationNodes,
      leasedAgents: dependencies.agents.filter((d) => d.source === "hub").map((d) => d.slug),
    },
    scrubReport: { rulesVersion: "scrub/1.0", scrubbedAt: nowIso, findings },
    integrity: { graphDigest: "", manifestDigest: null },
  };
  manifest.integrity.graphDigest = graphDigestOf(scrubbedGraph);
  manifest.integrity.manifestDigest = graphDigestOf({
    ...manifest,
    integrity: { graphDigest: manifest.integrity.graphDigest, manifestDigest: null },
  });

  return { blocked: false, blockers: [], findings, package: { manifest, graph: scrubbedGraph } };
}

export type GraphBindingItem =
  | { kind: "vault-key"; key: string; requiredBy: string[]; done: boolean }
  | { kind: "agent"; slug: string; source: "hub" | "local"; nodeId: string; done: boolean }
  | { kind: "mcp-server"; serverSlug: string; done: boolean };

/**
 * 패키지를 받았을 때 실행 전에 채워야 하는 것들.
 * "설치했으니 이제 돌아간다"가 아니라 "무엇이 비어 있는가"를 먼저 말한다.
 */
export function graphBindingChecklist(pkg: GraphPackage | null | undefined): GraphBindingItem[] {
  const manifest = pkg?.manifest;
  const items: GraphBindingItem[] = [];
  for (const entry of manifest?.vaultTemplate ?? []) {
    items.push({ kind: "vault-key", key: entry.key, requiredBy: entry.requiredBy ?? [], done: false });
  }
  for (const dep of manifest?.dependencies?.agents ?? []) {
    items.push({ kind: "agent", slug: dep.slug, source: dep.source, nodeId: dep.nodeId, done: false });
  }
  for (const dep of manifest?.dependencies?.mcp ?? []) {
    items.push({ kind: "mcp-server", serverSlug: dep.serverSlug, done: false });
  }
  return items;
}

/** 받은 패키지를 믿을 수 있는가. 모르는 형식·변형된 내용은 설치하지 않는다. */
export function verifyGraphPackage(pkg: unknown): string[] {
  const problems: string[] = [];
  if (!pkg || typeof pkg !== "object") return ["패키지 형식이 아닙니다."];
  const { manifest, graph } = pkg as Partial<GraphPackage>;
  if (!manifest || manifest.schemaVersion !== GRAPH_PACKAGE_SCHEMA_VERSION) {
    problems.push(`이 버전이 읽을 수 없는 패키지 형식입니다(${manifest?.schemaVersion ?? "형식 없음"}).`);
  }
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    problems.push("그래프에 단계가 없습니다.");
  }
  if (manifest?.integrity?.graphDigest && graph) {
    if (graphDigestOf(graph) !== manifest.integrity.graphDigest) {
      problems.push("그래프 내용이 매니페스트 지문과 다릅니다(전송 중 변형되었을 수 있습니다).");
    }
  }
  return problems;
}
