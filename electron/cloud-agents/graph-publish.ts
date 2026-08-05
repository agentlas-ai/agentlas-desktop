/**
 * 그래프를 Hub에 올리고, Hub에서 받아 설치한다.
 *
 * 왜 별도 모듈인가: 에이전트 발행은 **폴더를 훑는** 일이고(파일 스캔·정적 검사·리뷰),
 * 그래프 발행은 **이미 우리 손에 있는 자료 하나**를 내보내는 일이다. 폴더 경로를
 * 억지로 만들어 에이전트 파이프라인에 태우면, 그래프에 없는 개념(런타임 라벨·시스템
 * 프롬프트·팀 구성)이 매니페스트에 끼어 들어가 받는 쪽이 그것을 믿게 된다.
 *
 * ★공유되는 것은 전송 계약뿐이다: 같은 `/api/cloud-agents/v1/register`, 같은 packageHash
 *   계산, 같은 릴리스 봉인. 자산 종류만 `graph`로 **선언**한다 — 서버는 graph를 추론하지
 *   않는다(파일이 매니페스트+노드 목록이라 에이전트 트리와 전혀 다르게 생겼다).
 *
 * 받는 쪽은 **미바인딩 상태**로 설치된다. 그래프는 실행 주체가 아니라 도면이고,
 * 키·에이전트를 채우기 전에는 돌면 안 된다. 그래서 설치는 "됐습니다"가 아니라
 * "무엇이 비어 있는가"를 먼저 돌려준다.
 */
import { createHash } from "node:crypto";
import type {
  Automation,
  CloudAgentPackageManifest,
  CloudAgentReviewResult,
  CloudAgentVisibility,
  WorkflowGraph,
} from "../../shared/types";
import {
  buildGraphPackage,
  graphBindingChecklist,
  graphPackageSlug,
  verifyGraphPackage,
  type GraphBindingItem,
  type GraphPackage,
  type GraphPackageBlocker,
} from "../../shared/graph-package";
import { getSessionCookieHeader } from "../auth";
import { generateLocalizedListingWithSubmitterRuntime, hashPackage, localizedListingProblems } from "./package";

const PACKAGE_HASH_VERSION = "path-sha256-executable-v2" as const;
/** 패키지 안에서 그래프가 사는 자리. 받는 쪽이 이 한 이름만 알면 된다. */
export const GRAPH_PACKAGE_FILE = "graph.agentgraph.json";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function webBase(): string {
  return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, "");
}

export interface GraphPublishResult {
  ok: boolean;
  slug?: string;
  packageHash?: string;
  manifestUrl?: string;
  /** 막힌 이유 — 비밀이 남아 있으면 **내보내지 않는다**. */
  blockers?: GraphPackageBlocker[];
  /** 무엇을 지웠는지 사람이 볼 수 있게. */
  scrubbed?: Array<{ nodeId: string; field: string; action: string }>;
  reason?: string;
}

export async function publishGraphToHub(input: {
  automation: Automation;
  graph: WorkflowGraph;
  version?: string;
  visibility?: CloudAgentVisibility;
  /** 목록에 보일 문구. 없으면 자동화 이름·목표에서 만든다. */
  titleEn?: string;
  titleKo?: string;
  descriptionEn?: string;
  descriptionKo?: string;
}): Promise<GraphPublishResult> {
  const built = buildGraphPackage({
    automation: input.automation as Automation & { target_id?: string | null },
    graph: input.graph,
    ...(input.version ? { version: input.version } : {}),
  });
  if (built.blocked) {
    return { ok: false, blockers: built.blockers, reason: "패키지에 자격증명으로 보이는 값이 남아 있습니다." };
  }

  const cookie = getSessionCookieHeader();
  if (!cookie) return { ok: false, reason: "Hub에 올리려면 agentlas.cloud에 로그인해야 합니다." };

  const body = JSON.stringify(built.package, null, 2) + "\n";
  const files = [{
    path: GRAPH_PACKAGE_FILE,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: sha256(body),
    contentBase64: Buffer.from(body, "utf8").toString("base64"),
    executable: false,
  }];
  const packageHash = hashPackage(files);
  const slug = graphPackageSlug(input.automation.name);
  const name = input.automation.name;
  const tagline = (input.automation.goal || "").trim().slice(0, 200)
    || `${built.package.graph.nodes.length}단계 자동화 그래프`;
  const visibility: CloudAgentVisibility = input.visibility ?? "marketplace";

  // 그래프에는 정적 스캔 대상 코드 트리가 없다. 검사 대상은 **패키지 자신의 세척 결과**이고
  // 그건 이미 buildGraphPackage가 fail-closed로 했다(막을 사유가 있으면 여기 못 온다).
  const review: CloudAgentReviewResult = {
    mode: "static-only",
    verdict: "pass",
    costOwner: "none",
    summary: `그래프 패키지 — 노드 ${built.package.graph.nodes.length}개, 세척 ${built.findings.length}건, `
      + `채워야 할 항목 ${graphBindingChecklist(built.package).length}개.`,
    findings: [],
    reviewedAt: new Date().toISOString(),
  };

  // ★공개 목록 문구는 지어내지 않는다 — 한국어를 영문 칸에 복사하면 서버가 되돌려 보내고,
  //   통과시켜도 영어권 사용자에게 읽을 수 없는 목록이 남는다. 번역은 에이전트 발행과 **같은**
  //   경로를 쓴다(사본을 만들면 두 표면이 갈린다).
  let localized = {
    titleEn: input.titleEn || name,
    titleKo: input.titleKo || name,
    descriptionEn: input.descriptionEn || tagline,
    descriptionKo: input.descriptionKo || tagline,
  };
  if (localizedListingProblems(localized).length > 0) {
    const generated = await generateLocalizedListingWithSubmitterRuntime(process.cwd(), name, tagline);
    if (generated) localized = generated;
  }
  const listingProblems = localizedListingProblems(localized);
  if (listingProblems.length > 0) {
    return {
      ok: false,
      reason: `공개 목록 문구를 만들지 못했습니다(${listingProblems.join(", ")}). `
        + "영문 제목·설명을 직접 넣어 다시 시도해 주세요.",
    };
  }

  const manifest: CloudAgentPackageManifest = {
    version: "0.1",
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline,
    agentKind: "graph",
    runtimeLabels: [],
    visibility,
    rootFingerprint: sha256(`agentlas-package-root:${packageHash}`),
    packageHash,
    packageHashVersion: PACKAGE_HASH_VERSION,
    fileCount: files.length,
    includedFileCount: files.length,
    totalBytes: files[0]!.bytes,
    createdAt: new Date().toISOString(),
    billingMode: "static-only",
    costOwner: "none",
    localized,
    security: { verdict: "pass", blockerCount: 0, highCount: 0, findingCount: 0 },
  };

  const base = webBase();
  const response = await fetch(`${base}/api/cloud-agents/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: base, "if-none-match": "*" },
    body: JSON.stringify({
      manifest,
      bundle: { manifest, files, source: { packagedBy: "agentlas-desktop", packagedAt: manifest.createdAt, costOwner: "none" } },
      review,
      visibility,
      notes: null,
      billing: { modelCallsPaidBy: "none", localRuntime: null },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, reason: `Hub 등록 실패 (${response.status}): ${text.slice(0, 300)}` };
  }
  return {
    ok: true,
    slug,
    packageHash,
    manifestUrl: `${base}/api/mcp/v1/manifest/graph/${slug}`,
    scrubbed: built.findings.map((f) => ({ nodeId: f.nodeId, field: f.field, action: f.action })),
  };
}

export interface GraphFetchResult {
  ok: boolean;
  package?: GraphPackage;
  /** 실행 전에 채워야 하는 것들 — "설치했으니 돈다"고 말하지 않는다. */
  bindings?: GraphBindingItem[];
  packageHash?: string;
  reason?: string;
}

/** Hub에서 그래프 패키지를 받아 온다. 검증에 실패하면 설치하지 않는다. */
export async function fetchGraphFromHub(slug: string): Promise<GraphFetchResult> {
  const base = webBase();
  const url = `${base}/api/mcp/v1/manifest/graph/${encodeURIComponent(slug)}`;
  const cookie = getSessionCookieHeader();
  const response = await fetch(url, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
  });
  if (!response.ok) {
    return { ok: false, reason: `Hub에서 받지 못했습니다 (${response.status}).` };
  }
  // MCP 매니페스트 라우트는 본문을 {result: …}로 감싼다. 감싼 채로 읽으면 언제나
  // "파일이 없다"가 되어, 받을 수 있는 패키지를 못 받는다고 말하게 된다.
  const raw = await response.json().catch(() => null) as
    | { result?: unknown; cloudPackage?: unknown }
    | null;
  const json = ((raw && typeof raw === "object" && "result" in raw ? raw.result : raw) ?? null) as {
    cloudPackage?: { packageHash?: string; files?: Array<{ path: string; contentBase64?: string }> };
  } | null;
  const entry = json?.cloudPackage?.files?.find((f) => f.path === GRAPH_PACKAGE_FILE);
  if (!entry?.contentBase64) {
    // 목록에는 있는데 바이트가 없다 — "설치 가능"으로 보이면 안 된다.
    return { ok: false, reason: `Hub 응답에 ${GRAPH_PACKAGE_FILE}이 없습니다.` };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(Buffer.from(entry.contentBase64, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "받은 패키지를 읽지 못했습니다." };
  }
  const problems = verifyGraphPackage(pkg);
  if (problems.length) return { ok: false, reason: problems.join(" ") };
  const typed = pkg as GraphPackage;
  return {
    ok: true,
    package: typed,
    bindings: graphBindingChecklist(typed),
    ...(json?.cloudPackage?.packageHash ? { packageHash: json.cloudPackage.packageHash } : {}),
  };
}
