// 이 컴퓨터에 지금 무엇이 준비돼 있는가 — **결정론 검사의 입력**.
//
// 연결 여부는 모델에게 묻지 않는다. n8n이 플래너 프롬프트에서 이걸 명시적으로 금지한다
// ("NEVER mention API keys, credentials, authentication, or account setup").
// 대신 여기서 그래프와 실제 상태를 대조해 계산한다 — 그래서 메시지가 언제나 맞다.
//
// ★값은 절대 여기 담지 않는다. 키 **이름**만 읽는다. 비밀이 화면·로그·모델로 새는 경로를
//   만들지 않기 위해서다(MCP 스펙: 자격은 LLM 컨텍스트를 통과해선 안 된다).
import { listInstalledServers } from "../mcp-tools/registry";
import { listEnvKeys } from "../secrets/vault";
import {
  collectAgentBindings,
  collectBindings,
  collectGaps,
  decideActivation,
  groupGapsByProvider,
  type ActivationDecision,
  type GraphAgentBinding,
  type GraphBinding,
  type ProviderTask,
  type ToolInventory,
} from "../../shared/graph-tool-binding";
import type { WorkflowGraph } from "../../shared/types";

/** 지금 이 컴퓨터의 준비 상태. 읽지 못하면 **비어 있는 것으로 친다**(모름을 준비됨으로 읽지 않는다). */
export async function readToolInventory(): Promise<ToolInventory> {
  let mcpCatalogIds: string[] = [];
  try {
    mcpCatalogIds = listInstalledServers()
      .filter((server) => server.enabled && server.catalogId)
      .map((server) => server.catalogId as string);
  } catch (error) {
    console.error("[graph] installed MCP servers could not be read:", error);
  }
  let filledEnvKeys: string[] = [];
  try {
    filledEnvKeys = await listEnvKeys();
  } catch (error) {
    console.error("[graph] vault key names could not be read:", error);
  }
  return { mcpCatalogIds: [...new Set(mcpCatalogIds)], filledEnvKeys: [...new Set(filledEnvKeys)] };
}

export interface GraphConnectionReport {
  /** 켜도 되는가. */
  activation: ActivationDecision;
  /** 공급자 묶음별 할 일 — 화면이 이걸로 "구글 한 번 로그인" 카드를 만든다. */
  tasks: ProviderTask[];
  /** 쓰는 것 **전부**(준비된 것 포함). 교체는 이미 연결된 것에도 걸려야 한다. */
  bindings: GraphBinding[];
  /** 부르는 에이전트들. */
  agents: GraphAgentBinding[];
  /** 요구가 하나도 없으면 이 그래프는 도구 없이 도는 것이다. */
  hasRequirements: boolean;
}

/** 한 그래프의 연결 상태를 한 번에 답한다. 화면과 켜기 게이트가 같은 함수를 쓴다. */
export async function reportGraphConnections(
  graph: WorkflowGraph | null | undefined,
  locale: "ko" | "en" = "ko",
): Promise<GraphConnectionReport> {
  const inventory = await readToolInventory();
  const gaps = collectGaps(graph, inventory);
  const agents = collectAgentBindings(graph);
  return {
    activation: decideActivation(graph, inventory, locale),
    tasks: groupGapsByProvider(gaps),
    bindings: collectBindings(graph, inventory),
    agents,
    // 에이전트만 부르는 그래프도 이 창에서 바꿀 게 있다 — 그때 "연결할 것 없음"으로 닫지 않는다.
    hasRequirements: agents.length > 0
      || (graph?.nodes ?? []).some((node) => Array.isArray(node.config?.needs)
        && (node.config.needs as unknown[]).length > 0),
  };
}
