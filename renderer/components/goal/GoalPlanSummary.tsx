"use client";

import type { GoalPlanView } from "../../../shared/goal-shape";
import styles from "./GoalPlanSummary.module.css";

const SHAPE_LABEL: Record<GoalPlanView["shape"], { ko: string; en: string }> = {
  single_tactic: { ko: "단일 전술", en: "Single tactic" },
  tactic_list: { ko: "전술 목록", en: "Tactic list" },
  mission_tree: { ko: "대계·전략·전술", en: "Mission tree" },
};

/** Main 이 목표 문맥에 실어 보내는 계획 읽기 모델을 꺼낸다(없으면 null). */
export function goalPlanOf(context: unknown): GoalPlanView | null {
  const plan = context && typeof context === "object" ? (context as { plan?: unknown }).plan : null;
  return plan && typeof plan === "object" && typeof (plan as GoalPlanView).shape === "string" ? plan as GoalPlanView : null;
}

const STATUS_MARK: Record<string, string> = { done: "✓", retired: "–", active: "•", proposed: "○" };

/**
 * 골 구조 판단 결과 — 모양과 지금 전술을 한 줄로, 트리면 접힌 작은 트리.
 * Main 읽기 모델(GoalPlanView)만 그린다. 좁은 폭: 모든 글은 줄바꿈되고 가로로 넘치지 않는다.
 */
export function GoalPlanSummary({ plan, locale, variant = "inline" }: {
  plan: GoalPlanView | null | undefined;
  locale: "ko" | "en";
  /** "composer-tab": continues the Work composer goal tab (same border/background, attached to the composer). */
  variant?: "inline" | "composer-tab";
}) {
  if (!plan) return null;
  const ko = locale === "ko";
  const shape = SHAPE_LABEL[plan.shape][ko ? "ko" : "en"];
  const current = plan.currentTactic
    ? `${plan.currentTactic.id} ${plan.currentTactic.description}`
    : (ko ? "계획된 전술 완료 · 기준 확인 중" : "All planned tactics done · checking criteria");
  return <div className={variant === "composer-tab" ? `${styles.root} ${styles.composerTab}` : styles.root} data-goal-plan={plan.shape} data-goal-plan-fallback={plan.fallback ? "true" : "false"}>
    <p className={styles.line}>
      <span className={styles.shape}>{ko ? "구조" : "Plan"}: {shape}{plan.fallback ? (ko ? " (임시)" : " (provisional)") : ""}</span>
      <span className={styles.sep} aria-hidden="true"> · </span>
      <span className={styles.current}>{ko ? "지금" : "Now"}: {current}</span>
    </p>
    {plan.shape === "mission_tree" && <details className={styles.tree}>
      <summary>{ko ? "트리 보기" : "Show tree"}</summary>
      {plan.mission && <p className={styles.mission}>{plan.mission.objective}</p>}
      {plan.mission?.keyResults.length ? <ul className={styles.krs}>
        {plan.mission.keyResults.map((kr) => <li key={kr.metric}>
          {kr.metric} → {kr.target.toLocaleString(ko ? "ko-KR" : "en-US")}{kr.unit ? ` ${kr.unit}` : ""}
          {kr.requiredPerDay !== null ? ` · ${ko ? "필요" : "need"} ${kr.requiredPerDay}/${ko ? "일" : "day"}` : ""}
          {kr.sensor === "no_sensor" ? ` · ${ko ? "측정 없음" : "no sensor"}` : ""}
        </li>)}
      </ul> : null}
      <ul className={styles.strategies}>
        {plan.strategies.map((strategy) => <li key={strategy.id} data-status={strategy.status}>
          <span>{STATUS_MARK[strategy.status] ?? "•"} {strategy.id} {strategy.hypothesis}</span>
          {strategy.tactics.length ? <ul className={styles.tactics}>
            {strategy.tactics.map((tactic) => <li key={tactic.id} data-status={tactic.status}>
              {STATUS_MARK[tactic.status] ?? "•"} {tactic.id} {tactic.description}
            </li>)}
          </ul> : null}
        </li>)}
      </ul>
    </details>}
  </div>;
}
