// 소유 vs 빌림을 "외형(CSS)"이 아니라 "사실"로 가르는 단일 분류기.
// 기획안 원칙: owned = 내 디스크에 파일이 실재(안 죽음) / borrowed = 로컬에 파일 없는 원격 게스트
// (게시자가 내리면 죽음). 경쟁사 스토어엔 이 구분 자체가 없다 — 이게 화면상 가장 강한 차별 증거다.
import type { InstalledAgent } from "./types";

export type OwnershipClass = "owned-local" | "owned-cloud" | "borrowed";

export interface OwnershipInfo {
  klass: OwnershipClass;
  /** 내 자산인가(파일을 내가 가졌나). borrowed 만 false. */
  owned: boolean;
  /** 짧은 배지 라벨 (ko) */
  label: string;
  /** 출처/경로를 설명하는 한 문장 (ko) — owned-local 은 실제 폴더 경로를 담는다. */
  origin: string;
  /** 실제 로컬 폴더 경로 (owned-local 일 때만) */
  localPath?: string;
  /** 외부 의존으로 사라질 수 있는가 (borrowed = true: 게시자가 내리면 404) */
  fragile: boolean;
}

/** 설치된 에이전트의 소유 클래스. localPath 가 있으면 내 디스크의 실제 폴더(owned-local),
 *  없으면 클라우드에서 내 라이브러리에 설치된 것(owned-cloud). 둘 다 내 자산이다. */
export function classifyAgent(a: Pick<InstalledAgent, "localPath" | "slug">): OwnershipInfo {
  if (a.localPath) {
    return {
      klass: "owned-local",
      owned: true,
      label: "내 직원",
      origin: a.localPath,
      localPath: a.localPath,
      fragile: false,
    };
  }
  return {
    klass: "owned-cloud",
    owned: true,
    label: "내 직원",
    origin: "클라우드에서 내 라이브러리에 설치됨",
    fragile: false,
  };
}

/** 허브에서 빌려쓰는(호출형) 게스트. 로컬에 파일이 없고 게시자 가용성에 종속된다. */
export function borrowedInfo(input: { publisher?: string; available?: boolean }): OwnershipInfo {
  const available = input.available !== false;
  return {
    klass: "borrowed",
    owned: false,
    label: "빌린 게스트",
    origin: available
      ? `원격 게스트 — 호출만 함${input.publisher ? ` · 게시자 ${input.publisher}` : ""}`
      : `사용 불가 — 게시자가 내림${input.publisher ? ` (${input.publisher})` : ""}`,
    fragile: true,
  };
}

/** 영어 라벨이 필요할 때. */
export function ownershipLabelEn(info: OwnershipInfo): string {
  return info.owned ? "owned" : "borrowed";
}
