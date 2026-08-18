// 클라우드 업로드 세션 — 모듈 레벨 싱글톤 스토어.
//
// 오너 지시(2026-08-08): "에이전트 업로드 등 모든 메뉴에서 로딩·진행 중에 다른 메뉴
// 갔다 오면 초기화돼 있다."
//
// 실체: 업로드는 Main 프로세스에서 돌아가는데 진행 상태(단계·경과·결과)는 페이지의
// useState에만 살았다. 라우트를 떠나면 컴포넌트가 언마운트되며 그 상태가 통째로
// 사라지고, 돌아오면 아무 일도 없었던 초기 화면이 뜬다 — 업로드는 그동안 계속
// 돌고 있는데도. 빌드 화면은 이미 같은 이유로 build-session.ts라는 모듈 스토어를
// 쓴다. 업로드도 같은 자리로 옮긴다.
//
// 규칙: 진행 이벤트 구독도 여기서 한 번만 한다(화면 유무와 무관). 화면은
// useSyncExternalStore로 구독만 하고 아무것도 소유하지 않는다.
import { ipc } from "@/lib/ipc";
import type {
  CloudAgentPublishProgressEvent,
  CloudAgentPublishStage,
  FsPathGrant,
} from "@shared/types";

export type CloudUploadVisibility = "private-link" | "marketplace";

export interface CloudUploadIssue {
  severity: string;
  message: string;
  file?: string;
  remediation?: string;
}

export interface CloudUploadCareerGraphProof {
  indexStatus?: string;
  policy?: string;
  counts?: Record<string, number>;
  canonicalSources?: number;
  staleSourceCount?: number;
  nodeTypes?: Record<string, number>;
  edgeTypes?: Record<string, number>;
}

export interface CloudUploadResult {
  ok: boolean;
  title: string;
  issues: CloudUploadIssue[];
  visibility?: CloudUploadVisibility;
  detail?: string;
  link?: string;
  careerGraph?: CloudUploadCareerGraphProof;
  needsPurpose?: boolean;
  /**
   * The upload stopped on one question: something with this name is already in
   * the person's Cloud and this machine has no record of having uploaded it
   * from this folder. The card offers the replace action; main holds which
   * asset that is.
   */
  needsOverwriteConfirmation?: boolean;
  /**
   * The published listing's slug, kept so the result card can price it.
   *
   * Pricing is a separate call made after the publish succeeded, and the slug
   * is the only identifier the registration receipt carries — there is no
   * agentDefinitionId in it, which is why the server accepts a slug.
   */
  slug?: string;
}

export interface CloudUploadState {
  rootGrant: FsPathGrant | null;
  registeredKey: string;
  purposeAnswer: string;
  running: CloudUploadVisibility | null;
  result: CloudUploadResult | null;
  /** 이 실행을 식별한다. 버려진 실행의 늦은 이벤트가 현재 화면을 몰지 못하게 한다. */
  progressId: string;
  progressStage: CloudAgentPublishStage | null;
  progressDetail: string;
  startedAt: number | null;
}

const initial: CloudUploadState = {
  rootGrant: null,
  registeredKey: "",
  purposeAnswer: "",
  running: null,
  result: null,
  progressId: "",
  progressStage: null,
  progressDetail: "",
  startedAt: null,
};

let state: CloudUploadState = { ...initial };
let snapshot: CloudUploadState = { ...state };
const listeners = new Set<() => void>();
let progressBound = false;

function emit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function bindProgress(): void {
  if (progressBound) return;
  const off = ipc()?.cloudAgents?.onProgress?.((event: CloudAgentPublishProgressEvent) => {
    // 화면이 떠 있든 아니든 스토어는 계속 받는다 — 돌아왔을 때 진행 중인 단계가
    // 그대로 보이는 이유가 이것이다.
    if (!state.progressId || event.progressId !== state.progressId) return;
    state = { ...state, progressStage: event.stage, progressDetail: event.detail ?? "" };
    emit();
  });
  // 구독을 못 걸었으면(브라우저 프리뷰 등) 다음 마운트에서 다시 시도한다.
  progressBound = Boolean(off);
}

export function subscribeCloudUpload(listener: () => void): () => void {
  bindProgress();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCloudUploadSnapshot(): CloudUploadState {
  return snapshot;
}

/** SSR/정적 프리렌더용 — 서버에는 진행 중인 업로드가 없다. */
export function getCloudUploadServerSnapshot(): CloudUploadState {
  return initial;
}

export function setCloudUploadRootGrant(grant: FsPathGrant | null): void {
  state = { ...state, rootGrant: grant, registeredKey: "", result: null, purposeAnswer: "" };
  emit();
}

export function setCloudUploadRegisteredKey(key: string): void {
  state = { ...state, registeredKey: key, rootGrant: null, result: null, purposeAnswer: "" };
  emit();
}

export function setCloudUploadPurposeAnswer(answer: string): void {
  state = { ...state, purposeAnswer: answer };
  emit();
}

export function setCloudUploadResult(result: CloudUploadResult | null): void {
  state = { ...state, result };
  emit();
}

/** 실행 시작 — 새 progressId를 발급하고 그 값을 돌려준다(호출부가 IPC에 실어 보낸다). */
export function beginCloudUpload(visibility: CloudUploadVisibility): string {
  bindProgress();
  const progressId = globalThis.crypto?.randomUUID?.()
    ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state = {
    ...state,
    progressId,
    running: visibility,
    result: null,
    progressStage: "starting",
    progressDetail: "",
    startedAt: Date.now(),
  };
  emit();
  return progressId;
}

/**
 * 실행 종료. 자기 실행일 때만 쓴다 — 사용자가 화면을 떠났다가 새 업로드를 시작한
 * 뒤 옛 실행이 뒤늦게 끝나도 현재 진행을 지우지 못한다.
 */
export function finishCloudUpload(progressId: string, result: CloudUploadResult | null): void {
  if (state.progressId !== progressId) return;
  state = {
    ...state,
    running: null,
    progressId: "",
    progressStage: null,
    progressDetail: "",
    startedAt: null,
    ...(result ? { result } : {}),
  };
  emit();
}

/** 테스트/화면 전환용 초기화. 진행 중인 업로드가 있으면 지우지 않는다. */
export function resetCloudUploadSession(): void {
  if (state.running) return;
  state = { ...initial };
  emit();
}
