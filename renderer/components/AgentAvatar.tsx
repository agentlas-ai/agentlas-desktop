// 에이전트 프로필 — 고른 외형 > 이름으로 정해지는 기본 캐릭터 얼굴 > 한 글자 이니셜.
// 외형이 없으면 회색 이니셜 원 대신 기본 캐릭터 얼굴(폰과 같은 규칙, shared/agent-default-looks.json).
// 그림을 못 불러오면 예전의 중성 이니셜 원으로 떨어진다. tone prop은 호출부 호환을 위해 유지(색에는 쓰지 않음).
"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { AgentAppearance } from "@shared/agent-appearance";
import { useAgentAppearance } from "@/lib/agent-appearance";
import { agentFace } from "@shared/agent-face";
import { agentFaceLookSrc } from "@/lib/agent-default-look";
import { AgentAppearanceImage } from "./agent-workspace/AgentAppearancePicker";

export function AgentAvatar({
  name,
  seedName,
  agentId,
  appearance: suppliedAppearance,
  size = 32,
}: {
  name: string;
  /** 기본 얼굴의 씨앗 — UI 언어와 무관한 이름(shared/agent-face.ts agentFaceSeedName). 비우면 name. 폰으로 가는 face 와 같은 얼굴이 되려면 name 이 언어별 표시 이름일 때 꼭 넘긴다. */
  seedName?: string;
  agentId?: string;
  appearance?: AgentAppearance | null;
  /** @deprecated 색에 더 이상 사용하지 않음 — 모노크롬 통일. 호출부 호환용으로만 남김. */
  tone?: "blue" | "green" | "purple" | "amber" | "peach";
  size?: number;
}) {
  const storedAppearance = useAgentAppearance(suppliedAppearance === undefined ? agentId : undefined);
  const appearance = suppliedAppearance === undefined ? storedAppearance : suppliedAppearance;
  const face = agentFace(appearance, seedName ?? name);
  const lookSrc = agentFaceLookSrc(face);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => { setFailedSrc(null); }, [lookSrc]);
  const showLook = !!lookSrc && failedSrc !== lookSrc;
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: showLook ? "transparent" : "var(--paper-edge)",
    color: "var(--ink-soft)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-head)",
    fontWeight: 600,
    fontSize: Math.max(11, Math.floor(size * 0.42)),
    flexShrink: 0,
  };
  return (
    <span style={style}>
      {appearance ? <AgentAppearanceImage value={appearance} size={size} fill />
        : showLook ? <img src={lookSrc} alt="" width={size} height={size} draggable={false} style={{ display: "block", width: size, height: size, borderRadius: "50%", objectFit: "cover" }} onError={() => setFailedSrc(lookSrc)} />
        : initial}
    </span>
  );
}
