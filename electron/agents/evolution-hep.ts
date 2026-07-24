// hep 플러그인 발화 브리지 (Phase 2+ 4표면 중 hep 표면).
// hep 세션은 별도 폴더 호스트라 UI가 없다 → 데스크탑이 프로젝트 작업 폴더에
// `.agentlas/evolution-proposals.json`(사람이 읽는 요약, content-free-ish)을 써 두고,
// 세션 시작 컨텍스트에 한 줄("N growth proposals pending — review with agentlas evolve")을 주입한다.
// 적용/되돌리기는 명령(agentlas evolve apply/revert)으로만 — 여기선 파일+안내 한 줄만 생산한다.
import fs from "node:fs";
import path from "node:path";
import { listPendingGrowthProposals } from "./evolution";
import type { AgentEvolutionProposalUi, GrowthProposalCardCopy } from "../../shared/types";

export const EVOLUTION_PROPOSALS_RELATIVE = ".agentlas/evolution-proposals.json";

interface HepProposalEntry {
  id: string;
  agentId: string;
  riskTier: "low" | "high";
  status: string;
  learned: string;
  change: string;
  reversible: string;
}

function cardOf(proposal: AgentEvolutionProposalUi): GrowthProposalCardCopy | null {
  const raw = (proposal.source as Record<string, unknown>).humanCard;
  if (!raw || typeof raw !== "object") return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.learned !== "string" || typeof card.change !== "string" || typeof card.reversible !== "string") {
    return null;
  }
  return { learned: card.learned, change: card.change, reversible: card.reversible };
}

function toEntry(proposal: AgentEvolutionProposalUi): HepProposalEntry {
  const card = cardOf(proposal);
  const riskTier = (proposal.source as Record<string, unknown>).riskTier === "high" ? "high" : "low";
  return {
    id: proposal.id,
    agentId: proposal.agentId,
    riskTier,
    status: proposal.status,
    learned: card?.learned ?? proposal.summary,
    change: card?.change ?? "",
    reversible: card?.reversible ?? "",
  };
}

/** `<projectDir>/.agentlas` 폴더가 안전한 실디렉토리인지 확인하고 없으면 만든다. 링크는 거부. */
function ensureAgentlasDir(projectDir: string): string | null {
  const resolvedProject = path.resolve(projectDir);
  try {
    const projectStat = fs.lstatSync(resolvedProject);
    if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const dir = path.join(resolvedProject, ".agentlas");
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return dir;
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: false });
      return dir;
    } catch {
      return null;
    }
  }
}

/**
 * 프로젝트 작업 폴더에 대기 중 성장 제안 요약 파일을 쓴다(없으면 파일 삭제).
 * 반환: { pending, autoApplied }. 실패는 조용히 삼킨다(런 결과에 영향 금지).
 */
export function writeEvolutionProposalsForProject(projectDir: string | null | undefined): {
  pending: number;
  autoApplied: number;
} {
  const result = { pending: 0, autoApplied: 0 };
  if (!projectDir) return result;
  let inbox: ReturnType<typeof listPendingGrowthProposals>;
  try {
    inbox = listPendingGrowthProposals(50);
  } catch {
    return result;
  }
  result.pending = inbox.pending.length;
  result.autoApplied = inbox.autoApplied.length;
  const dir = ensureAgentlasDir(projectDir);
  if (!dir) return result;
  const file = path.join(dir, "evolution-proposals.json");
  try {
    if (inbox.pending.length === 0 && inbox.autoApplied.length === 0) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      return result;
    }
    const payload = {
      contract: "agentlas.evolution-proposals.v1",
      generatedAt: new Date().toISOString(),
      reviewCommand: "agentlas evolve",
      pending: inbox.pending.map(toEntry),
      autoApplied: inbox.autoApplied.map(toEntry),
    };
    const tmp = path.join(dir, `.evolution-proposals.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 파일 쓰기 실패는 무해 — 인박스/명령 경로는 그대로 산다 */
  }
  return result;
}

/** 세션 시작 컨텍스트 한 줄 — 대기 중 고위험 제안이 있을 때만. content-free. */
export function evolutionSessionContextLine(pendingCount: number, locale: "ko" | "en"): string | null {
  if (pendingCount <= 0) return null;
  return locale === "ko"
    ? `[Agentlas] 검토 대기 중인 에이전트 성장 제안 ${pendingCount}건 — \`agentlas evolve\`로 확인하세요.`
    : `[Agentlas] ${pendingCount} agent growth proposal(s) pending — review with \`agentlas evolve\`.`;
}
