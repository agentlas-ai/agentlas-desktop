"use client";
// 카드 우측상단의 종류 아이콘 — 싱글/멀티 팀/플러그인/그래프를 글자 배지 대신 아이콘 하나로.
// 이름은 툴팁과 접근성 라벨이 말한다(오너 지시 2026-09-13: 표기는 아이콘으로 직관적이게).
import { entityClassLabel, type AgentEntityClass } from "@/lib/agent-entity-kind";
import { IconPuzzle, IconRoute, IconUser, IconUsers } from "@/components/Icon";
import type { Locale } from "@/lib/i18n";

export function EntityKindIcon({
  kind,
  locale,
  size = 14,
  className,
}: {
  kind: AgentEntityClass;
  locale: Locale;
  size?: number;
  className?: string;
}) {
  const label = entityClassLabel(kind, locale);
  const Icon = kind === "multi" ? IconUsers : kind === "plugin" ? IconPuzzle : kind === "graph" ? IconRoute : IconUser;
  return (
    <span
      className={["entity-kind-icon", className].filter(Boolean).join(" ")}
      data-entity-kind={kind}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon size={size} />
    </span>
  );
}
