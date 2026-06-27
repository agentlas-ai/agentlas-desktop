// 외부 MCP 툴 플러그인 매니저 — Slack/Discord/GitHub 등을 실제로 연결한다(Codex 스타일).
// 한 번 연결하면 모든 에이전트·팀이 공유한다 (에이전트별 연결 개념 없음 — 전역 원터치).
// 두 탭: 연결됨(설치/구성된 서버 + 상태/테스트/제거) · 도구 추가(카탈로그에서 연결).
// 키는 환경변수 vault에 저장되고 자동 주입 — LLM 무관.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  InstalledMcpServer,
  McpServerStatus,
  McpToolCatalogEntry,
} from "@/lib/types";
import {
  IconCheck,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShield,
  IconTrash,
  IconWand,
} from "@/components/Icon";

type Tab = "installed" | "catalog";

export default function LibraryMcpsPage() {
  const { t, locale } = useT();
  const [tab, setTab] = useState<Tab>("installed");
  const [catalog, setCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // 커스텀 MCP 추가 폼
  const [customOpen, setCustomOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cTransport, setCTransport] = useState<"stdio" | "sse" | "http">("stdio");
  const [cCommand, setCCommand] = useState("npx");
  const [cArgs, setCArgs] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cEnv, setCEnv] = useState("");
  const [cBusy, setCBusy] = useState(false);

  async function addCustom() {
    const api = ipc();
    if (!api || !cName.trim()) return;
    setCBusy(true);
    try {
      await api.mcpTools.installCustom({
        name: cName.trim(),
        transport: cTransport,
        command: cTransport === "stdio" ? cCommand.trim() || "npx" : undefined,
        args: cTransport === "stdio" ? cArgs.trim().split(/\s+/).filter(Boolean) : undefined,
        url: cTransport !== "stdio" ? cUrl.trim() : undefined,
        envKeys: cEnv.trim() ? cEnv.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : undefined,
      });
      setCName("");
      setCArgs("");
      setCUrl("");
      setCEnv("");
      setCustomOpen(false);
      await refresh();
      setTab("installed");
    } finally {
      setCBusy(false);
    }
  }

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [c, i] = await Promise.all([
      api.mcpTools.listCatalog(),
      api.mcpTools.listInstalled(),
    ]);
    setCatalog(c);
    setInstalled(i);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedCatalogIds = useMemo(
    () => new Set(installed.map((s) => s.catalogId).filter((x): x is string => !!x)),
    [installed],
  );

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((e) =>
      [e.name, e.nameEn, e.description, e.descriptionEn, e.category]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [catalog, query]);

  const byCatalogId = useMemo(() => {
    const m = new Map<string, McpToolCatalogEntry>();
    for (const e of catalog) m.set(e.id, e);
    return m;
  }, [catalog]);

  async function connect(catalogId: string) {
    const api = ipc();
    if (!api) return;
    setBusy(catalogId);
    try {
      await api.mcpTools.install(catalogId);
      await refresh();
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    const name = locale === "en" ? server.nameEn || server.name : server.name;
    if (!confirm(t("mcps.confirm_remove", { name }))) return;
    await api.mcpTools.remove(server.id);
    setStatuses((s) => {
      const next = { ...s };
      delete next[server.id];
      return next;
    });
    await refresh();
  }

  async function toggle(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    await api.mcpTools.setEnabled(server.id, !server.enabled);
    await refresh();
  }

  async function test(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    setTesting(server.id);
    try {
      const status = await api.mcpTools.test(server.id);
      setStatuses((s) => ({ ...s, [server.id]: status }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <section style={{ padding: "24px 32px", maxWidth: 880, margin: "0 auto" }}>
      <h2
        style={{
          fontFamily: "var(--font-head)",
          fontSize: 18,
          margin: "0 0 4px",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <IconWand size={18} style={{ color: "var(--accent)" }} />
        {t("mcps.title")}
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted-deep)", lineHeight: 1.6 }}>
        {t("mcps.subtitle")}
      </p>

      {/* 전역 공유 안내 — Codex/Claude 런타임 연결처럼 한 번 켜면 모두가 쓴다 */}
      <div
        className="glass-strong"
        style={{
          marginBottom: 16,
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 11.5,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <IconShield size={13} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>{t("mcps.shared_note")}</span>
      </div>

      {/* 탭 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, alignItems: "center" }}>
        {(["installed", "catalog"] as Tab[]).map((id) => {
          const active = tab === id;
          const label =
            id === "installed"
              ? `${t("mcps.tab.installed")}${installed.length ? ` · ${installed.length}` : ""}`
              : t("mcps.tab.catalog");
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: active ? 700 : 500,
                background: active ? "var(--paper)" : "var(--paper-2)",
                color: active ? "var(--ink)" : "var(--ink-soft)",
                border: "1px solid var(--paper-edge)",
                boxShadow: active ? "var(--neu-raised)" : "none",
              }}
            >
              {label}
            </button>
          );
        })}
        {tab === "catalog" && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("mcps.search")}
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              fontSize: 12.5,
              border: "1px solid var(--paper-edge)",
              borderRadius: 999,
              background: "var(--paper)",
              outline: "none",
              width: 200,
            }}
          />
        )}
      </div>

      {tab === "installed" ? (
        installed.length === 0 ? (
          <Empty text={t("mcps.installed_empty")} />
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {installed.map((server) => {
              const name = locale === "en" ? server.nameEn || server.name : server.name;
              const status = statuses[server.id];
              return (
                <li
                  key={server.id}
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Logo entry={server.catalogId ? byCatalogId.get(server.catalogId) : undefined} name={name} size={26} />
                    <strong style={{ fontSize: 14 }}>{name}</strong>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "var(--paper-2)",
                        color: "var(--muted-deep)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {t(`mcps.transport.${server.transport}` as "mcps.transport.stdio")}
                    </span>
                    {server.envKeys.length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--muted-deep)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <IconKey size={11} /> {t("mcps.needs_env", { n: server.envKeys.length })}
                      </span>
                    )}
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => void toggle(server)}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--paper-edge)",
                          background: server.enabled ? "rgba(86,161,74,0.16)" : "var(--paper-2)",
                          color: server.enabled ? "#2f6b2a" : "var(--ink-soft)",
                        }}
                      >
                        {server.enabled ? t("mcps.on") : t("mcps.off")}
                      </button>
                      <button
                        onClick={() => void test(server)}
                        disabled={testing === server.id || !server.enabled}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--paper-edge)",
                          background: "transparent",
                          color: "var(--accent)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          opacity: server.enabled ? 1 : 0.5,
                        }}
                      >
                        <IconRefresh size={11} />
                        {testing === server.id ? t("mcps.testing") : t("mcps.test")}
                      </button>
                      <button
                        onClick={() => void remove(server)}
                        aria-label={t("mcps.remove")}
                        title={t("mcps.remove")}
                        style={{
                          color: "var(--red-deep)",
                          background: "transparent",
                          border: "1px solid var(--paper-edge)",
                          borderRadius: 999,
                          padding: "4px 8px",
                        }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>

                  <StatusLine status={status} testing={testing === server.id} t={t} />
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <>
        {/* 커스텀 MCP 추가 */}
        <div style={{ marginBottom: 12 }}>
          {!customOpen ? (
            <button
              onClick={() => setCustomOpen(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--ink-soft)",
                background: "var(--paper-2)",
                border: "1px dashed var(--paper-edge)",
                borderRadius: 999,
                cursor: "pointer",
              }}
            >
              <IconPlus size={12} /> {t("mcps.custom.add")}
            </button>
          ) : (
            <div
              className="glass-strong"
              style={{ padding: 14, borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13, flex: 1 }}>{t("mcps.custom.title")}</strong>
                <button
                  onClick={() => setCustomOpen(false)}
                  style={{ fontSize: 12, color: "var(--muted-deep)", background: "transparent", border: "none", cursor: "pointer" }}
                >
                  {t("common.cancel")}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  placeholder={t("mcps.custom.name")}
                  style={{ ...customInput, flex: "1 1 160px" }}
                />
                <select value={cTransport} onChange={(e) => setCTransport(e.target.value as "stdio" | "sse" | "http")} style={customInput}>
                  <option value="stdio">stdio (npx)</option>
                  <option value="sse">SSE</option>
                  <option value="http">HTTP</option>
                </select>
              </div>
              {cTransport === "stdio" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input value={cCommand} onChange={(e) => setCCommand(e.target.value)} placeholder={t("mcps.custom.command")} style={{ ...customInput, flex: "0 0 100px", fontFamily: "var(--font-mono)" }} />
                  <input value={cArgs} onChange={(e) => setCArgs(e.target.value)} placeholder={t("mcps.custom.args")} style={{ ...customInput, flex: "1 1 200px", fontFamily: "var(--font-mono)" }} />
                </div>
              ) : (
                <input value={cUrl} onChange={(e) => setCUrl(e.target.value)} placeholder={t("mcps.custom.url")} style={{ ...customInput, fontFamily: "var(--font-mono)" }} />
              )}
              <input value={cEnv} onChange={(e) => setCEnv(e.target.value)} placeholder={t("mcps.custom.env")} style={{ ...customInput, fontFamily: "var(--font-mono)" }} />
              <button
                onClick={() => void addCustom()}
                disabled={!cName.trim() || cBusy}
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 16px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: cName.trim() && !cBusy ? "var(--neu-raised)" : "none",
                  background: cName.trim() && !cBusy ? "var(--paper)" : "var(--paper-2)",
                  color: cName.trim() && !cBusy ? "var(--ink)" : "var(--muted-deep)",
                }}
              >
                {cBusy ? t("mcps.testing") : t("mcps.custom.create")}
              </button>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
          {filteredCatalog.length === 0 ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Empty text={t("mcps.no_results")} />
            </div>
          ) : (
            filteredCatalog.map((entry) => {
              const name = locale === "en" ? entry.nameEn || entry.name : entry.name;
              const desc = locale === "en" ? entry.descriptionEn || entry.description : entry.description;
              const already = installedCatalogIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    padding: 14,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Logo entry={entry} name={name} size={28} />
                    <strong style={{ fontSize: 13.5, flex: 1 }}>{name}</strong>
                    <span
                      title={entry.trust === "official" ? t("mcps.official") : t("mcps.community")}
                      style={{
                        fontSize: 10,
                        padding: "2px 7px",
                        borderRadius: 999,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        background: entry.trust === "official" ? "rgba(168,217,155,0.20)" : "var(--paper-2)",
                        color: entry.trust === "official" ? "var(--green-deep)" : "var(--muted-deep)",
                        fontWeight: 600,
                      }}
                    >
                      <IconShield size={10} />
                      {entry.trust === "official" ? t("mcps.official") : t("mcps.community")}
                    </span>
                  </div>
                  {/* 키 발급 / 문서 링크 */}
                  {(entry.setupUrl || entry.docsUrl) && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {entry.setupUrl && (
                        <a
                          href={entry.setupUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
                        >
                          <IconKey size={11} /> {t("mcps.get_key")}
                        </a>
                      )}
                      {entry.docsUrl && (
                        <a
                          href={entry.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 11, color: "var(--muted-deep)", textDecoration: "none" }}
                        >
                          {t("mcps.docs")} ↗
                        </a>
                      )}
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5, minHeight: 32 }}>
                    {desc}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 10.5, color: "var(--muted)", flex: 1 }}>
                      {t(`mcps.cat.${entry.category}` as "mcps.cat.dev")}
                      {" · "}
                      {entry.envRequirements.length > 0
                        ? t("mcps.needs_env", { n: entry.envRequirements.length })
                        : t("mcps.no_env_needed")}
                    </span>
                    {already ? (
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: "var(--green-deep)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <IconCheck size={13} /> {t("mcps.connected")}
                      </span>
                    ) : (
                      <button
                        onClick={() => void connect(entry.id)}
                        disabled={busy === entry.id}
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          padding: "5px 12px",
                          borderRadius: 999,
                          background: "var(--paper)",
                          color: "var(--ink)",
                          border: "1px solid var(--paper-edge)",
                          boxShadow: "var(--neu-raised)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <IconPlus size={12} />
                        {t("mcps.connect")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        </>
      )}

      {/* 보안 노트 */}
      <div
        className="glass-strong"
        style={{
          marginTop: 18,
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 11.5,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <IconLock size={13} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>{t("env.security_note")}</span>
      </div>
    </section>
  );
}

function StatusLine({
  status,
  testing,
  t,
}: {
  status: McpServerStatus | undefined;
  testing: boolean;
  t: ReturnType<typeof useT>["t"];
}) {
  if (testing) {
    return <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("mcps.testing")}</div>;
  }
  if (!status) {
    return <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("mcps.untested")}</div>;
  }
  if (status.missingEnv.length > 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--peach-ink)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
        <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{t("mcps.status.missing_env", { keys: status.missingEnv.join(", ") })}</span>
        <Link href="/library/env" style={{ color: "var(--accent)", fontWeight: 600 }}>
          {t("mcps.missing_env_cta")}
        </Link>
      </div>
    );
  }
  if (status.connected) {
    return (
      <div style={{ fontSize: 12, color: "var(--green-deep)", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <IconCheck size={12} />
        {t("mcps.status.ok", { n: status.tools.length })}
        {status.tools.length > 0 && (
          <span
            style={{
              color: "var(--muted-deep)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              maxWidth: 240,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {" "}
            · {status.tools.slice(0, 4).map((tool) => tool.name).join(", ")}
            {status.tools.length > 4 ? " …" : ""}
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: "var(--red-deep)" }}>
      {t("mcps.status.error", { error: status.error ?? "unknown" })}
    </div>
  );
}

/** 외부 툴 로고 타일 — 브랜드 컬러 배경 + 모노그램. (브랜드 SVG 자산 없이 일관·안전하게 식별) */
function Logo({
  entry,
  name,
  size,
}: {
  entry?: McpToolCatalogEntry;
  name: string;
  size: number;
}) {
  // 브랜드 컬러가 없으면 accent로 폴백 — 흰 모노그램이 다크모드에서도 읽힌다 (var(--ink)는 다크에서 밝아짐).
  const bg = entry?.brandColor ?? "var(--accent)";
  const mark = entry?.mark ?? name.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size * 0.28,
        background: bg,
        color: "white",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-head)",
        fontWeight: 800,
        fontSize: size * (mark.length > 1 ? 0.4 : 0.5),
        letterSpacing: 0,
      }}
    >
      {mark}
    </span>
  );
}

const customInput: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 12.5,
  outline: "none",
};

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        color: "var(--muted-deep)",
        border: "1px dashed var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
