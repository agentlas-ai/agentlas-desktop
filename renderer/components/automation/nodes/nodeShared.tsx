// 워크플로우 커스텀 노드 공통 — 디자인 토큰 기반 미니멀 카드 셸.
// 각 노드 타입 컴포넌트가 이 셸을 감싸 아이콘+라벨+요약을 렌더한다.
"use client";
import type { CSSProperties, ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { useT } from "@/lib/i18n";

export const NODE_WIDTH = 216;

/** 노드 라이브 실행 상태별 테두리/글로우 색(설계 §5 P2 캔버스 오버레이). */
export const RUN_STATE_COLOR: Record<string, string> = {
  running: "var(--accent)",
  done: "var(--ok, var(--ok))",
  failed: "var(--danger, var(--danger))",
  skipped: "var(--muted-deep)",
  pending: "var(--paper-edge)",
};

/** 타입별 액센트 색(디자인 토큰만 사용). */
export const NODE_ACCENT: Record<string, string> = {
  trigger: "var(--accent)",
  agent: "var(--ink)",
  tool: "var(--muted-deep)",
  action: "var(--ink-soft)",
  condition: "var(--accent)",
  transform: "var(--muted-deep)",
  output: "var(--accent)",
  // 커널이 실행하는 종류는 화면도 알아야 한다 — 모르면 색이 없는 채로 그려진다.
  eval: "var(--accent)",
  subgraph: "var(--ink)",
  code: "var(--muted-deep)",
};

/**
 * 우상단 종류 태그의 배경·글자색 — 오너 지정 팔레트(2026-08-05), 2026-09-05 토큰화.
 * 원래 팔레트(Navy·Yellow·Green·Orange·Mint·Mauve·White)를 색상표 토큰에 1:1로 매핑해
 * 7개 카테고리 그룹이 서로 다른 색으로 남도록 했다: Navy→info · Yellow→warn · Green→ok ·
 * Orange→peach · Mint→teal · Mauve→purple-deep · White→paper.
 * 종류가 색으로 먼저 읽혀야 캔버스를 훑을 때 흐름이 보인다(실측 항목 7).
 */
export const NODE_TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  trigger: { bg: "var(--node-trigger)", fg: "var(--white)" },        // Navy — 시작점
  agent: { bg: "var(--node-worker)", fg: "var(--node-trigger)" },    // Yellow — 일꾼
  firm: { bg: "var(--node-worker)", fg: "var(--node-trigger)" },     // 일꾼 무리도 같은 계열
  code: { bg: "var(--node-compute)", fg: "var(--white)" },           // Green — 계산
  transform: { bg: "var(--node-compute)", fg: "var(--white)" },      // 값 가공도 계산 계열
  action: { bg: "var(--node-outbound)", fg: "var(--white)" },        // Orange — 바깥으로 나감
  output: { bg: "var(--node-outbound)", fg: "var(--white)" },        // 내보내기도 바깥 계열
  eval: { bg: "var(--node-eval)", fg: "var(--node-trigger)" },       // Mauve — 채점
  condition: { bg: "var(--node-branch)", fg: "var(--node-trigger)" },// Mint — 갈림길
  tool: { bg: "var(--node-tool)", fg: "var(--node-trigger)" },       // White — 도구
  subgraph: { bg: "var(--node-tool)", fg: "var(--node-trigger)" },
};

/**
 * 모든 커스텀 노드가 공유하는 카드 셸.
 * - 좌측 target 핸들 / 우측 source 핸들(트리거는 target 없음, output은 source 없음).
 * - selected면 액센트 링.
 */
/**
 * 연결을 붙일 수 있는 네 면. 순서가 곧 기본값이다(핸들 미지정 엣지는 첫 항목에 붙는다) —
 * 배치가 위→아래이므로 위·아래를 먼저 둔다.
 */
const SIDES = [
  { id: "t", position: Position.Top, offset: { left: "50%" } },
  { id: "b", position: Position.Bottom, offset: { left: "50%" } },
  { id: "l", position: Position.Left, offset: { top: "50%" } },
  { id: "r", position: Position.Right, offset: { top: "50%" } },
] as const;

export function NodeCard(props: {
  type: string;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  selected?: boolean;
  hasIn?: boolean;
  hasOut?: boolean;
  accent?: string;
  /** 편집 모드에서 핸들로 drag-connect를 허용할지. */
  connectable?: boolean;
  /** 라이브 실행 상태(설계 §5 P2) — 있으면 테두리를 상태색으로, running이면 펄스. */
  runState?: string;
  /** 지금 무엇을 하는 중인가 — 실패가 아닌 상태 변화(커넥터 C44). */
  progress?: string;
  /** condition 노드용 분기 소스 핸들(true/false) — 우측 상/하단에 배치. */
  branchHandles?: boolean;
  /**
   * 실패·정리 출구를 그릴 수 있게 한다 (커넥터 C40·C42).
   *
   * ★기본은 **꺼져 있다**(2026-08-06). 실측: 저장된 그래프 13개·연결 57개 중
   *   실패 연결 0개, 정리 연결 0개 — 모든 노드에 아무도 쓰지 않는 포트 2개와 라벨 2개가
   *   늘 붙어 있었다. 그럴 만한 이유가 있다:
   *     · "실패하면 알려줘"는 이미 제품이 한다(automation-scheduler의 데스크탑 알림).
   *     · 임시 파일 정리도 이미 자동이다(code-runner의 cleanup()).
   *   즉 두 포트는 **이미 기본 동작인 것을 사람이 선으로 다시 그리라고 요구**하고 있었다.
   *   커널은 그대로 그 연결을 실행하므로(run-graph의 error/always 처리) 예전 그래프는
   *   계속 돌고, 고급 사용자가 이 prop을 켜면 다시 그릴 수 있다.
   */
  outcomeHandles?: boolean;
  /** 실패·정리 출구의 이름·설명(로케일 주입). 없으면 현재 로케일 기본값. */
  outcomeStrings?: { fail: string; failHint: string; cleanup: string; cleanupHint: string };
  /** 좌상단 AI 주석 버튼(항목 5) — 누르면 "이 단계만 AI에게" 팝업이 열린다. 편집 모드에서만 주입된다. */
  onAiNote?: () => void;
  /** 그 버튼의 설명(로케일 주입). 없으면 현재 로케일 기본값. */
  aiHint?: string;
}) {
  // The fallbacks used to be Korean literals, and no caller ever passed
  // `outcomeStrings` — so every node rendered "실패"/"정리" to English users
  // too. Defaults now follow the active locale; useT falls back to `en`
  // outside a provider, so a node rendered in isolation stays English.
  const { locale } = useT();
  const outcomeFallback = locale === "ko"
    ? {
        fail: "실패",
        failHint: "이 단계가 실패했을 때만 가는 길입니다",
        cleanup: "정리",
        cleanupHint: "성공하든 실패하든 마지막에 한 번 도는 뒷정리 길입니다",
      }
    : {
        fail: "on failure",
        failHint: "Taken only when this step fails",
        cleanup: "cleanup",
        cleanupHint: "Runs once at the end whether the step succeeded or failed",
      };
  const accent = props.accent ?? NODE_ACCENT[props.type] ?? "var(--muted-deep)";
  const connectable = props.connectable ?? false;
  const runColor = props.runState ? RUN_STATE_COLOR[props.runState] : undefined;
  const borderColor = runColor && props.runState !== "pending" ? runColor : props.selected ? accent : "var(--paper-edge)";
  const isRunning = props.runState === "running";
  return (
    <div
      className="automation-flow-node-card"
      data-node-type={props.type}
      data-selected={props.selected ? "true" : "false"}
      data-running={isRunning ? "true" : "false"}
      style={{
        width: NODE_WIDTH,
        background: "var(--paper)",
        border: `${runColor && props.runState !== "pending" ? 1.6 : 1}px solid ${borderColor}`,
        borderRadius: 12,
        boxShadow: isRunning
          ? `0 0 0 3px color-mix(in srgb, ${runColor} 30%, transparent)`
          : props.selected
            ? "var(--neu-raised)"
            : "none",
        padding: "14px 14px 13px",
        fontFamily: "var(--font-body)",
        position: "relative",
        opacity: props.runState === "skipped" ? 0.55 : 1,
        transition: "border-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease",
      }}
    >
      {/* ★"실행 중"만 보이면 사람은 멈춘 걸로 읽는다. 지금 무엇을 하는 중인지를 그 자리에 쓴다.
          실패가 아니라 상태 변화이므로 색을 쓰지 않고 조용히 둔다(커넥터 C44). */}
      {isRunning && props.progress ? (
        <div
          data-testid="node-progress"
          style={{
            position: "absolute", left: 14, right: 14, bottom: -18,
            fontSize: 10, color: "var(--muted-deep)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {props.progress}
        </div>
      ) : null}
      {/* ★들어오고 나가는 자리를 **네 면 모두** 연다(오너 결정 2026-08-06).
          배치가 위→아래라 기본은 위(들어옴)·아래(나감)이고, 옆으로 도는 선은 좌우로 붙인다.
          ★그리는 순서가 곧 기본값이다 — 핸들을 지정하지 않은 옛 엣지는 React Flow가
          **처음 나온 핸들**에 붙이므로, 위(target)·아래(source)를 맨 앞에 둔다. */}
      {props.hasIn !== false ? SIDES.map((side) => (
        <Handle
          key={`t-${side.id}`}
          id={`in-${side.id}`}
          type="target"
          position={side.position}
          style={{ ...handleStyle, ...side.offset }}
          isConnectable={connectable}
        />
      )) : null}
      {props.onAiNote ? (
        <button
          type="button"
          className="automation-flow-node-ai"
          title={props.aiHint ?? (locale === "ko"
            ? "AI에게 이 단계 주석·수정 맡기기"
            : "Leave a note for the AI, or have it set this step up")}
          onClick={(e) => { e.stopPropagation(); props.onAiNote?.(); }}
        >
          AI
        </button>
      ) : null}
      <span
        className="automation-flow-node-type"
        style={{
          background: (NODE_TAG_COLORS[props.type] ?? { bg: "var(--paper)" }).bg,
          color: (NODE_TAG_COLORS[props.type] ?? { fg: accent }).fg,
          borderColor: "transparent",
        }}
      >
        {props.type}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in oklch, var(--fill-1) 76%, var(--paper))",
            color: accent,
            flexShrink: 0,
          }}
        >
          {props.icon}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {props.title}
          </div>
        </div>
      </div>
      {props.subtitle ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--ink-soft)",
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {props.subtitle}
        </div>
      ) : null}
      {props.badge ? <div style={{ marginTop: 8 }}>{props.badge}</div> : null}
      {props.branchHandles ? (
        <>
          {/* true 핸들(상단) / false 핸들(하단) — sourceHandle id로 엣지가 분기를 실어나른다. */}
          {/* 세로 흐름이라 참/거짓은 **아래쪽 좌우**로 갈린다 — 오른쪽 위아래로 두면
              위→아래로 읽는 눈에 어느 쪽이 먼저인지 안 보인다. */}
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "30%", background: "var(--ok, var(--ok))" }}
            isConnectable={connectable}
          />
          <span style={branchLabelStyle("30%", "var(--ok, var(--ok))")}>T</span>
          <Handle
            id="false"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "70%", background: "var(--danger, var(--danger))" }}
            isConnectable={connectable}
          />
          <span style={branchLabelStyle("70%", "var(--danger, var(--danger))")}>F</span>
        </>
      ) : props.hasOut !== false ? SIDES.map((side) => (
        <Handle
          key={`s-${side.id}`}
          id={`out-${side.id}`}
          type="source"
          position={side.position}
          style={{ ...handleStyle, ...side.offset }}
          isConnectable={connectable}
        />
      )) : null}

      {/* 실패 출구와 정리 출구 — 평상시 출구와 **다른 자리**에 둔다(아래쪽).
          같은 자리에 겹치면 어느 선을 끌고 있는지 사람이 알 수 없다. */}
      {props.outcomeHandles ? (
        <>
          <Handle
            id="error"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "34%", background: "var(--danger, var(--danger))" }}
            isConnectable={connectable}
          />
          {/* ★이름표에 설명을 단다 — "실패, 정리가 뭐지"가 실측 첫 반응이었다(항목 2). */}
          <span
            title={props.outcomeStrings?.failHint ?? outcomeFallback.failHint}
            style={{ ...outcomeLabelStyle("34%", "var(--danger, var(--danger))"), pointerEvents: "auto", cursor: "help" }}
          >
            {props.outcomeStrings?.fail ?? outcomeFallback.fail}
          </span>
          <Handle
            id="always"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "70%", background: "var(--muted-deep)" }}
            isConnectable={connectable}
          />
          <span
            title={props.outcomeStrings?.cleanupHint ?? outcomeFallback.cleanupHint}
            style={{ ...outcomeLabelStyle("70%", "var(--muted-deep)"), pointerEvents: "auto", cursor: "help" }}
          >
            {props.outcomeStrings?.cleanup ?? outcomeFallback.cleanup}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** condition 분기 핸들 옆 T/F 라벨. */
/** 실패·정리 출구의 이름표. 핸들만 있으면 무엇인지 모른다. */
function outcomeLabelStyle(left: string, color: string): CSSProperties {
  return {
    position: "absolute",
    bottom: -16,
    left,
    transform: "translateX(-50%)",
    fontSize: 9,
    color,
    pointerEvents: "none",
    whiteSpace: "nowrap",
  };
}

function branchLabelStyle(top: string, color: string): CSSProperties {
  return {
    position: "absolute",
    right: -14,
    top,
    transform: "translateY(-50%)",
    fontSize: 8,
    fontWeight: 700,
    fontFamily: "var(--font-mono)",
    color,
    pointerEvents: "none",
  };
}

const handleStyle = {
  width: 8,
  height: 8,
  background: "var(--muted-deep)",
  border: "1px solid var(--paper)",
} as const;

/** "서비스 연결 필요" 배지 — 자격증명 미충족 툴 노드용. */
export function ConnectServiceBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        background: "var(--paper-2)",
        border: "1px solid var(--accent-soft)",
        color: "var(--accent)",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: "var(--accent)",
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

/** config에서 문자열 필드 안전 추출. */
export function cfgStr(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}
