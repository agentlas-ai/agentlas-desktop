"use client";

import type { McpBuildAttachmentReceipt, McpBuildReceiptItem } from "@/lib/types";

/** 사유 코드를 사람 말로. 이유 없는 상태 칩은 "고장인가?"를 사용자에게 떠넘긴다. */
function reasonText(reason: string, ko: boolean): string | null {
  if (reason === "no_connectable_server") {
    return ko
      ? "붙일 MCP 서버가 없는 스킬 묶음입니다 — 고장이 아닙니다"
      : "a skill bundle with no MCP server to attach — not a failure";
  }
  if (reason === "missing_key") return ko ? "API 키 미설정" : "API key not set";
  if (reason === "runtime_incompatible") return ko ? "이 런타임과 호환되지 않음" : "not compatible with this runtime";
  if (reason === "disabled") return ko ? "꺼져 있음" : "turned off";
  return null;
}

function ReceiptGroup(props: { label: string; items: McpBuildReceiptItem[]; state: string; ko: boolean }) {
  if (props.items.length === 0) return null;
  // 같은 칸 안에서도 사유가 갈리면 사유별로 나눠 적는다.
  const byReason = new Map<string, string[]>();
  for (const item of props.items) {
    const key = item.reason ?? "";
    byReason.set(key, [...(byReason.get(key) ?? []), item.name]);
  }
  return (
    <div className="build-mcp-receipt-group" data-state={props.state}>
      <strong>{props.label} · {props.items.length}</strong>
      <span>
        {[...byReason.entries()].map(([reason, names]) => {
          const why = reasonText(reason, props.ko);
          return why ? `${names.join(", ")} — ${why}` : names.join(", ");
        }).join(" / ")}
      </span>
    </div>
  );
}

export function McpAttachmentReceiptCard(props: { receipt: McpBuildAttachmentReceipt; ko: boolean }) {
  const itemNames = new Map(
    [
      ...props.receipt.attached,
      ...props.receipt.skipped,
      ...props.receipt.missingKey,
      ...props.receipt.failed,
      ...props.receipt.degraded,
    ].map((item) => [item.candidateId, item.name]),
  );
  const fallbackNames = props.receipt.fallback
    .map((item) => `${itemNames.get(item.fromCandidateId) ?? (props.ko ? "기본 MCP" : "Primary MCP")} → ${itemNames.get(item.toCandidateId) ?? (props.ko ? "대체 MCP" : "Fallback MCP")}`)
    .join(", ");
  return (
    <section className="build-card build-mcp-receipt-card" aria-label={props.ko ? "MCP 연결 결과" : "MCP attachment receipt"}>
      <div className="build-card-head">
        <span>{props.ko ? "MCP 연결 결과" : "MCP attachment receipt"}</span>
        <span>{props.receipt.emptyMode ? (props.ko ? "MCP 없는 제한 모드" : "empty MCP mode") : (props.ko ? "연결 확인됨" : "resolved")}</span>
      </div>
      <div className="build-mcp-receipt-grid">
        <ReceiptGroup label={props.ko ? "붙음" : "Attached"} items={props.receipt.attached} state="attached" ko={props.ko} />
        <ReceiptGroup label={props.ko ? "건너뜀" : "Skipped"} items={props.receipt.skipped} state="skipped" ko={props.ko} />
        <ReceiptGroup label={props.ko ? "키 없음" : "Missing key"} items={props.receipt.missingKey} state="missing" ko={props.ko} />
        <ReceiptGroup label={props.ko ? "연결 실패" : "Failed"} items={props.receipt.failed} state="failed" ko={props.ko} />
        <ReceiptGroup label={props.ko ? "제한됨" : "Degraded"} items={props.receipt.degraded} state="degraded" ko={props.ko} />
        {fallbackNames && <div className="build-mcp-receipt-group" data-state="fallback"><strong>{props.ko ? "폴백 사용" : "Fallback used"}</strong><span>{fallbackNames}</span></div>}
        {props.receipt.emptyMode && <div className="build-mcp-empty">{props.ko ? "MCP가 하나도 붙지 않아도 빌드 자체는 계속됩니다." : "The Build continues even when no MCP can be attached."}</div>}
        {props.receipt.hostReceiptWarning === "receipt_storage_failed" && (
          <div className="build-mcp-empty">
            {props.ko
              ? "연결 결과를 로컬 기록으로 저장하지 못했지만 빌드는 계속됩니다."
              : "The local attachment receipt could not be stored, but the Build continues."}
          </div>
        )}
      </div>
    </section>
  );
}
