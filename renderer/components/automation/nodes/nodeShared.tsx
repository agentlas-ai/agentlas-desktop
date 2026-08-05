// 워크플로우 커스텀 노드 공통 — 디자인 토큰 기반 미니멀 카드 셸.
// 각 노드 타입 컴포넌트가 이 셸을 감싸 아이콘+라벨+요약을 렌더한다.
"use client";
import type { CSSProperties, ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";

export const NODE_WIDTH = 216;

/** 노드 라이브 실행 상태별 테두리/글로우 색(설계 §5 P2 캔버스 오버레이). */
export const RUN_STATE_COLOR: Record<string, string> = {
  running: "var(--accent)",
  done: "var(--ok, #2e9e5b)",
  failed: "var(--danger, #d64545)",
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
 * 모든 커스텀 노드가 공유하는 카드 셸.
 * - 좌측 target 핸들 / 우측 source 핸들(트리거는 target 없음, output은 source 없음).
 * - selected면 액센트 링.
 */
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
   * ★없으면 "실패하면 이쪽으로"를 커널은 실행할 수 있는데 저작자가 **그릴 수가 없다**.
   * 만들어 놓고 닿을 수 없는 기능이 되는 그 모양이다.
   */
  outcomeHandles?: boolean;
}) {
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
      {props.hasIn !== false ? (
        <Handle type="target" position={Position.Left} style={handleStyle} isConnectable={connectable} />
      ) : null}
      <span
        className="automation-flow-node-type"
        style={{ color: accent }}
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
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            style={{ ...handleStyle, top: "32%", background: "var(--ok, #2e9e5b)" }}
            isConnectable={connectable}
          />
          <span style={branchLabelStyle("32%", "var(--ok, #2e9e5b)")}>T</span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            style={{ ...handleStyle, top: "68%", background: "var(--danger, #d64545)" }}
            isConnectable={connectable}
          />
          <span style={branchLabelStyle("68%", "var(--danger, #d64545)")}>F</span>
        </>
      ) : props.hasOut !== false ? (
        <Handle type="source" position={Position.Right} style={handleStyle} isConnectable={connectable} />
      ) : null}

      {/* 실패 출구와 정리 출구 — 평상시 출구와 **다른 자리**에 둔다(아래쪽).
          같은 자리에 겹치면 어느 선을 끌고 있는지 사람이 알 수 없다. */}
      {props.outcomeHandles ? (
        <>
          <Handle
            id="error"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "34%", background: "var(--danger, #d64545)" }}
            isConnectable={connectable}
          />
          <span style={outcomeLabelStyle("34%", "var(--danger, #d64545)")}>실패</span>
          <Handle
            id="always"
            type="source"
            position={Position.Bottom}
            style={{ ...handleStyle, left: "70%", background: "var(--muted-deep)" }}
            isConnectable={connectable}
          />
          <span style={outcomeLabelStyle("70%", "var(--muted-deep)")}>정리</span>
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
