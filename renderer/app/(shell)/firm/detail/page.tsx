// 회사 상세 — 헤더(이름·CEO 채팅 버튼) + 조직도 시각화 + 회사 내 채팅 목록.
"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { Chat, InstalledAgent, InstalledFirm, ResolvedOrg, ResolvedNode } from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { IconBuilding, IconChat, IconTrash, IconUsers } from "@/components/Icon";

export default function FirmDetailWrapper() {
  return (
    <Suspense fallback={null}>
      <FirmDetailPage />
    </Suspense>
  );
}

function FirmDetailPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { t, locale } = useT();
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState("");
  const [resolvedOrg, setResolvedOrg] = useState<ResolvedOrg | null>(null);
  // 조직도 패널 너비 — 가운데 분할선을 끌어 조절 (Agents 화면과 동일 UX). localStorage 영속.
  const [orgWidth, setOrgWidth] = useState(360);
  useEffect(() => {
    try {
      const n = parseInt(window.localStorage.getItem("agentlas.firm.orgWidth") ?? "", 10);
      if (Number.isFinite(n) && n >= 260 && n <= 640) setOrgWidth(n);
    } catch {
      // ignore
    }
  }, []);
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      const startX = e.clientX;
      const startW = orgWidth;
      let finalW = startW;
      function onMove(ev: MouseEvent) {
        const dx = startX - ev.clientX; // 우측 패널: 왼쪽으로 끌면 넓어짐
        finalW = Math.max(260, Math.min(640, startW + dx));
        setOrgWidth(finalW);
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        try {
          window.localStorage.setItem("agentlas.firm.orgWidth", String(finalW));
        } catch {
          // ignore
        }
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    },
    [orgWidth],
  );

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !id) return;
    const [f, ag, cs, org] = await Promise.all([
      api.firms.get(id),
      api.team.list(),
      api.chats.listByFirm(id),
      api.firms.getResolvedOrg(id),
    ]);
    if (!f) {
      navigate("/marketplace?tab=firms", "replace");
      return;
    }
    setFirm(f);
    setAgents(ag);
    setChats(cs);
    setResolvedOrg(org);
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startCeoChat() {
    const api = ipc();
    if (!api || !firm) return;
    const chat = await api.chats.create({ firmId: firm.id });
    navigate(`/chat?id=${chat.id}`);
  }

  // 임포트한 팀 폴더를 LLM으로 분석해 3-tier(본부·전문가) 구조를 생성/갱신
  async function resolveOrg() {
    const api = ipc();
    if (!api || !firm || resolving) return;
    setResolving(true);
    setResolveMsg("");
    try {
      const r = await api.firms.resolveOrg(firm.id);
      setResolveMsg(r.ok ? t("firm.resolve_ok") : t("firm.resolve_fail", { error: r.error ?? "?" }));
      if (r.ok && r.org) setResolvedOrg(r.org); // 차트 즉시 3-tier로 갱신
    } catch (e) {
      // IPC가 reject해도 무반응으로 끝나지 않게 — 항상 메시지로 피드백.
      setResolveMsg(t("firm.resolve_fail", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setResolving(false);
    }
  }

  async function uninstall() {
    const api = ipc();
    if (!api || !firm) return;
    if (!confirm(t("firm.confirm_uninstall", { name: pickLocalized(firm, locale).name }))) return;
    await api.firms.uninstall(firm.id);
    navigate("/marketplace?tab=firms", "replace");
  }

  if (!firm) return null;
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const firmLoc = pickLocalized(firm, locale);

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          minHeight: 56,
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "var(--fill-1)",
            color: "var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <IconBuilding size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--muted-deep)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontFamily: "var(--font-mono)",
            }}
          >
            {t("firm.kind")} · {firm.persona}
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-head)",
              fontSize: 18,
              fontWeight: 700,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {firmLoc.name}
          </h1>
        </div>
        <button
          onClick={() => void startCeoChat()}
          className="titlebar-nodrag"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 16px",
            borderRadius: 999,
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
          }}
        >
          <IconChat size={14} />
          {t("firm.ceo.command")}
        </button>
        <button
          onClick={() => void uninstall()}
          className="titlebar-nodrag"
          aria-label={t("common.delete")}
          style={{ color: "var(--muted-deep)", padding: 6 }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}
      >
        <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)" }}>
          {firmLoc.tagline}
        </p>

        {/* 회사 채팅 목록 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px" }}>
          {t("firm.section.chats")} ({chats.length})
        </h2>
        {chats.length === 0 ? (
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              textAlign: "center",
              fontSize: 13,
            }}
          >
            {t("firm.empty_chats")}
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {chats.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/chat?id=${c.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    textDecoration: "none",
                    color: "var(--ink)",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontWeight: 500,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.title.trim() || t("chat.untitled")}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0 }}>
                    {new Date(c.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
                      month: "numeric",
                      day: "numeric",
                      hour: "numeric",
                      minute: "numeric",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>

      {/* 우측 — 팀 분해 조직도 (가운데 분할선 드래그로 너비 조절) */}
      <aside
        className="glass-thin"
        style={{
          position: "relative",
          width: orgWidth,
          flexShrink: 0,
          borderLeft: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
        }}
      >
        {/* 좌측 가장자리 드래그 핸들 */}
        <div
          role="separator"
          aria-label={t("workspace.resize")}
          onMouseDown={startResize}
          style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "ew-resize", zIndex: 2 }}
        />
        <header style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--glass-border)", display: "flex", alignItems: "center", gap: 8 }}>
          <IconUsers size={15} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-head)" }}>
              {t("firm.section.orgchart")}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
              {resolveMsg ||
                t("firm.orgchart_sub", {
                  n: resolvedOrg
                    ? 1 +
                      resolvedOrg.divisions.length +
                      resolvedOrg.divisions.reduce((a, d) => a + d.specialists.length, 0)
                    : firm.orgChart.length,
                })}
            </div>
          </div>
          <button
            onClick={() => void resolveOrg()}
            disabled={resolving}
            title={t("firm.resolve_hint")}
            style={{
              flexShrink: 0,
              fontSize: 11,
              fontWeight: 600,
              padding: "5px 10px",
              borderRadius: 999,
              color: "var(--ink-soft)",
              background: "var(--paper)",
              border: "1px solid var(--paper-edge)",
              boxShadow: "var(--neu-raised)",
              cursor: resolving ? "default" : "pointer",
              opacity: resolving ? 0.6 : 1,
            }}
          >
            {resolving ? t("firm.resolving") : t("firm.resolve")}
          </button>
        </header>
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {resolvedOrg ? (
            <ResolvedOrgChart org={resolvedOrg} />
          ) : (
            <OrgChart firm={firm} agentMap={agentMap} locale={locale} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ── 정규화된 3-tier 조직 렌더 — CEO → 본부 → 전문가(들여쓰기 중첩) ──────────
function ResolvedOrgChart({ org }: { org: ResolvedOrg }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <OrgNodeCard node={org.ceo} tier={1} />
      {org.divisions.map((d) => (
        <div key={d.id}>
          <OrgNodeCard node={d} tier={2} />
          {d.specialists.length > 0 && (
            <div
              style={{
                marginLeft: 28,
                paddingLeft: 14,
                borderLeft: "1px solid var(--paper-edge)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginTop: 8,
              }}
            >
              {d.specialists.map((s) => (
                <OrgNodeCard key={s.id} node={s} tier={3} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OrgNodeCard({ node, tier }: { node: ResolvedNode; tier: 1 | 2 | 3 }) {
  const isCeo = tier === 1;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: isCeo ? "var(--fill-1)" : "var(--paper)",
        border: isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <AgentAvatar name={node.name} size={tier === 3 ? 26 : 32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <strong
            style={{
              fontSize: tier === 3 ? 12.5 : 13,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.name}
          </strong>
          {node.role && node.role !== node.name && (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 999,
                background: isCeo ? "var(--ink)" : "var(--paper-2)",
                color: isCeo ? "var(--paper)" : "var(--ink-soft)",
                fontWeight: 600,
              }}
            >
              {node.role}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 조직도: reportsTo 트리 재귀 렌더 ────────────────────────
function OrgChart({
  firm,
  agentMap,
  locale,
}: {
  firm: InstalledFirm;
  agentMap: Map<string, InstalledAgent>;
  locale: Locale;
}) {
  // CEO부터 트리 BFS
  const ceo = firm.orgChart.find((n) => n.reportsTo === null);
  if (!ceo) return <div>조직도가 비어있습니다.</div>;

  function children(parentSlug: string) {
    return firm.orgChart.filter((n) => n.reportsTo === parentSlug);
  }

  function renderNode(node: typeof firm.orgChart[number], depth: number): React.ReactNode {
    const agent = agentMap.get(node.agentId);
    const agentLoc = agent ? pickLocalized(agent, locale) : null;
    const kids = children(node.agentSlug);
    const isCeo = node.reportsTo === null;
    return (
      <div key={node.agentSlug} style={{ marginTop: depth === 0 ? 0 : 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: isCeo ? "var(--fill-1)" : "var(--paper)",
            border: isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {/* 부서는 라벨 전용(agentId 없음)일 수 있음 — 그래도 역할명으로 아바타를 그려 빈 노드/(missing) 방지 */}
          <AgentAvatar name={agentLoc?.name ?? node.role} tone={agent?.tone} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <strong
                style={{
                  fontSize: 13,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {agentLoc?.name ?? node.role}
              </strong>
              {(isCeo || agentLoc) && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: isCeo ? "var(--ink)" : "var(--paper-2)",
                    color: isCeo ? "var(--paper)" : "var(--ink-soft)",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {node.role}
                </span>
              )}
            </div>
            {agentLoc && (
              <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 2, overflowWrap: "anywhere" }}>
                {agentLoc.tagline}
              </div>
            )}
          </div>
        </div>
        {kids.length > 0 && (
          <div
            style={{
              marginLeft: 28,
              paddingLeft: 14,
              borderLeft: "1px dashed var(--paper-edge)",
              marginTop: 6,
            }}
          >
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return renderNode(ceo, 0);
}
