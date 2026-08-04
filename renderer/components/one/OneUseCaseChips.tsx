"use client";

// One 홈 use-case 칩 — 새 대화가 시작되기 전에만 보이는 실 기능 진입점.
// 칩 4개는 고정(빌드/라이브러리/자동화/경험)이고, 다섯 번째 로테이션 슬롯은
// Main이 계산한 결정적 신호(이어하기/고치기 > 7일 미사용 기능 소개)로만 채운다.
// 어떤 칩도 실행 권한을 만들지 않는다 — 라우팅(딥링크)과 시트 열기만 한다.

import { tFor } from "@/lib/i18n";
import type { OneHomeSignalsV1 } from "@/lib/types";
import styles from "./OneUseCaseChips.module.css";

export type OneUseCaseChipId =
  | "build"
  | "library"
  | "automation"
  | "experience"
  | "resume_build"
  | "fix_automation"
  | "approve_graph"
  | "try_automation"
  | "try_experience"
  | "try_build"
  | "try_library";

export interface OneUseCaseChipAction {
  id: OneUseCaseChipId;
  /** 로테이션 칩의 딥링크 대상(실패한 자동화 id 등). 고정 칩은 없다. */
  targetId?: string;
}

interface OneUseCaseChipsProps {
  locale: "ko" | "en";
  /** 렌더러 로컬 신호 — 같은 창에서 진행 중이던 빌드가 있는지. */
  hasUnfinishedBuild: boolean;
  /** Main이 계산한 결정적 로테이션 신호. null이면 로테이션 슬롯을 비운다(fail-closed). */
  signals: OneHomeSignalsV1 | null;
  /** 케이스 B(브리핑 카드 아래)용 축소형. */
  compact?: boolean;
  onActivate: (action: OneUseCaseChipAction) => void;
}

/**
 * 로테이션 슬롯 결정 — 우선순위는 항상 같다:
 * 1) 이 창에서 만들다 만 빌드(이어하기) 2) 승인 대기 그래프 3) 최신 실행이 실패한 자동화(고치기)
 * 3) 최근 7일 미사용 기능 소개. 신호가 없으면 슬롯 자체를 그리지 않는다.
 */
export function resolveOneRotationChip(
  hasUnfinishedBuild: boolean,
  signals: OneHomeSignalsV1 | null,
): OneUseCaseChipAction | null {
  if (hasUnfinishedBuild) return { id: "resume_build" };
  // 승인 대기는 실패보다 앞선다. 고장난 게 아니라 사용자가 누르지 않아서 멈춘 것이라,
  // 알려주지 않으면 영영 그대로 있고 "고치기"로 안내하면 엉뚱한 길로 보낸다.
  if (signals?.approvalTarget) {
    return { id: "approve_graph", targetId: signals.approvalTarget.automationId };
  }
  if (signals?.fixTarget) {
    return { id: "fix_automation", targetId: signals.fixTarget.automationId };
  }
  // 첫 실행 사용자는 모든 기능이 "미사용"이라 소개 칩이 소음이 된다 —
  // 권장 배지가 그 역할을 대신하므로 로테이션은 비운다.
  if (!signals || signals.firstRun) return null;
  if (signals.staleCapability === "automation") return { id: "try_automation" };
  if (signals.staleCapability === "experience") return { id: "try_experience" };
  if (signals.staleCapability === "build") return { id: "try_build" };
  if (signals.staleCapability === "library") return { id: "try_library" };
  return null;
}

const FIXED_CHIPS: Array<{ id: OneUseCaseChipId; key: "one.chips.build" | "one.chips.library" | "one.chips.automation" | "one.chips.experience" }> = [
  { id: "build", key: "one.chips.build" },
  { id: "library", key: "one.chips.library" },
  { id: "automation", key: "one.chips.automation" },
  { id: "experience", key: "one.chips.experience" },
];

function rotationLabel(action: OneUseCaseChipAction, locale: "ko" | "en", signals: OneHomeSignalsV1 | null): string {
  if (action.id === "resume_build") return tFor(locale, "one.chips.resume_build");
  if (action.id === "approve_graph") {
    return tFor(locale, "one.chips.approve_graph", { name: signals?.approvalTarget?.name ?? "" });
  }
  if (action.id === "fix_automation") {
    return tFor(locale, "one.chips.fix_automation", { name: signals?.fixTarget?.name ?? "" });
  }
  if (action.id === "try_automation") return tFor(locale, "one.chips.try_automation");
  if (action.id === "try_experience") return tFor(locale, "one.chips.try_experience");
  if (action.id === "try_build") return tFor(locale, "one.chips.try_build");
  return tFor(locale, "one.chips.try_library");
}

export function OneUseCaseChips({
  locale,
  hasUnfinishedBuild,
  signals,
  compact = false,
  onActivate,
}: OneUseCaseChipsProps) {
  const rotation = resolveOneRotationChip(hasUnfinishedBuild, signals);
  const showRecommendedBadge = signals?.firstRun === true;
  return (
    <nav
      className={compact ? `${styles.chips} ${styles.compact}` : styles.chips}
      aria-label={tFor(locale, "one.chips.aria")}
      data-one-use-case-chips="true"
    >
      {FIXED_CHIPS.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className={styles.chip}
          data-chip-id={chip.id}
          onClick={() => onActivate({ id: chip.id })}
        >
          <span className={styles.chipLabel}>{tFor(locale, chip.key)}</span>
          {chip.id === "build" && showRecommendedBadge && (
            <span className={styles.badge}>{tFor(locale, "one.chips.recommended")}</span>
          )}
        </button>
      ))}
      {rotation && (
        <button
          type="button"
          className={`${styles.chip} ${styles.rotation}`}
          data-chip-id={rotation.id}
          onClick={() => onActivate(rotation)}
        >
          <span className={styles.chipLabel}>{rotationLabel(rotation, locale, signals)}</span>
        </button>
      )}
    </nav>
  );
}
