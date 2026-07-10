// 소유 vs 빌림을 "외형(CSS)"이 아니라 "사실"로 가르는 단일 분류기.
// Agent Cloud 복원본은 로컬 실행 폴더를 가지지만 권위 출처는 Cloud다. localPath 유무만으로
// 출처를 추측하면 복원 자산이 로컬 임포트로 오표시되므로 assetSource를 먼저 판정한다.
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

/** 설치된 에이전트의 소유 클래스. Agent Cloud 복원본은 검증된 로컬 실행 사본을 함께 표시한다. */
export function classifyAgent(
  a: Pick<InstalledAgent, "localPath" | "slug" | "assetSource" | "packageHash">,
  locale: "ko" | "en" = "ko",
): OwnershipInfo {
  const ko = locale === "ko";
  if (a.assetSource === "agent-cloud") {
    // packageHash is immutable restore provenance. Current governed assets can
    // evolve locally and are shown separately by evolution version/receipts.
    const version = a.packageHash ? ` · ${ko ? "복원 원본 bundle" : "source bundle"} ${a.packageHash.slice(0, 12)}` : "";
    return {
      klass: "owned-cloud",
      owned: true,
      label: ko ? "내 자산" : "My asset",
      origin: ko
        ? `Agent Cloud에서 검증 복원된 실행 사본${version}`
        : `Verified execution copy restored from Agent Cloud${version}`,
      localPath: a.localPath,
      fragile: false,
    };
  }
  if (a.localPath) {
    const fromHub = a.assetSource === "hub";
    return {
      klass: "owned-local",
      owned: true,
      label: ko ? "내 자산" : "My asset",
      origin: fromHub
        ? (ko ? "Hub 패키지를 로컬 실행 사본으로 설치함" : "Hub package installed as a local execution copy")
        : a.localPath,
      localPath: a.localPath,
      fragile: false,
    };
  }
  return {
    klass: "owned-cloud",
    owned: true,
    label: ko ? "내 자산" : "My asset",
    origin: ko ? "클라우드에서 내 라이브러리에 설치됨" : "Installed to my library from the cloud",
    fragile: false,
  };
}

/** 허브에서 빌려쓰는(호출형) 게스트. 로컬에 파일이 없고 게시자 가용성에 종속된다. */
export function borrowedInfo(
  input: { publisher?: string; available?: boolean },
  locale: "ko" | "en" = "ko",
): OwnershipInfo {
  const ko = locale === "ko";
  const available = input.available !== false;
  return {
    klass: "borrowed",
    owned: false,
    label: ko ? "빌린 게스트" : "Borrowed guest",
    origin: ko
      ? (available
          ? `원격 게스트 — 호출만 함${input.publisher ? ` · 게시자 ${input.publisher}` : ""}`
          : `사용 불가 — 게시자가 내림${input.publisher ? ` (${input.publisher})` : ""}`)
      : (available
          ? `Remote guest — call-only${input.publisher ? ` · publisher ${input.publisher}` : ""}`
          : `Unavailable — publisher took it down${input.publisher ? ` (${input.publisher})` : ""}`),
    fragile: true,
  };
}

/** 영어 라벨이 필요할 때. */
export function ownershipLabelEn(info: OwnershipInfo): string {
  return info.owned ? "owned" : "borrowed";
}
