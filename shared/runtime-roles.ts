// 런타임 역할의 정본 — "어느 자리에 어떤 CLI를 앉히는가".
//
// ★이 파일이 있는 이유. 역할은 유니온 하나로만 선언돼 있었고, 실제로 역할을 순회하는
// 곳들은 손으로 쓴 `["orchestrator", "worker"]` 배열 9개였다. 유니온에 멤버를 더해도
// 그 배열들은 컴파일러가 잡아주지 않으므로, 새 역할은 조용히 누락된 채로 산다
// (같은 계열의 사고가 이 저장소에 이미 기록돼 있다).
//
// 그래서 목록은 여기 하나이고, 역할마다 "어떤 성격인가"를 아래 표가 답한다.
// Record<RuntimeRole, …> 라서 새 역할을 더하면 답하지 않은 칸이 컴파일 에러가 된다.

export const RUNTIME_ROLES = ["orchestrator", "worker", "multimodal"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export interface RuntimeRoleTraits {
  /** 프롬프트를 주고받고 도구를 쓰는 자리인가. */
  conversational: boolean;
  /**
   * 쿼터가 막혔을 때 풀에서 다른 런타임으로 자동 대체해도 되는가.
   *
   * 멀티모달은 false다. orchestrator 를 claude 에서 codex 로 바꾸면 같은 일을 계속할 수
   * 있지만, "codex 의 image_gen" 을 claude 로 대체할 수는 없다 — 그 자리는 능력 자체가
   * 런타임에 묶여 있다. 조용히 갈아치우면 사용자가 고른 엔진이 아닌 것이 그림을 그린다.
   */
  poolAutoPick: boolean;
  /**
   * 모바일 브리지가 이 역할을 읽고 쓰는가.
   *
   * 모바일은 데스크탑 미러링이고 대화 역할만 조작한다(authority.ts 의
   * MOBILE_RUNTIME_ROLES). 멀티모달 슬롯은 데스크탑에서 정한다.
   */
  mobileEditable: boolean;
  /** 무엇을 하는 자리인지 — 화면 문구가 아니라 계약 설명. */
  purpose: string;
}

export const RUNTIME_ROLE_TRAITS: Record<RuntimeRole, RuntimeRoleTraits> = {
  orchestrator: {
    conversational: true,
    poolAutoPick: true,
    mobileEditable: true,
    purpose: "Leads the turn: plans, delegates, and answers the user.",
  },
  worker: {
    conversational: true,
    poolAutoPick: true,
    mobileEditable: true,
    purpose: "Carries out delegated work inside a turn.",
  },
  multimodal: {
    conversational: false,
    poolAutoPick: false,
    mobileEditable: false,
    purpose:
      "Generates images, video, and audio. The conversational runtime writes the prompt; this slot's CLI renders it headlessly.",
  },
};

/** 대화 역할 — 쿼터 기반 풀 자동선택의 대상이기도 하다. */
export const CONVERSATIONAL_ROLES = RUNTIME_ROLES.filter(
  (role) => RUNTIME_ROLE_TRAITS[role].conversational,
);

/** 풀에서 자동으로 갈아끼워도 되는 역할. */
export const POOL_AUTOPICK_ROLES = RUNTIME_ROLES.filter(
  (role) => RUNTIME_ROLE_TRAITS[role].poolAutoPick,
);

export function isRuntimeRole(value: unknown): value is RuntimeRole {
  return typeof value === "string" && (RUNTIME_ROLES as readonly string[]).includes(value);
}
