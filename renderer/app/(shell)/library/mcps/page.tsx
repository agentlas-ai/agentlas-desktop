// 외부 MCP 툴 플러그인 매니저 — Slack/Discord/GitHub 등을 실제로 연결한다(Codex 스타일).
// 한 번 연결하면 모든 에이전트·팀이 공유한다 (에이전트별 연결 개념 없음 — 전역 원터치).
// 세 갈래: 연결됨(설치된 서버 + 상태/테스트/제거) · 커스텀 도구 추가(URL·명령 직접
// 등록) · 허브에서 찾아보기(카탈로그 전체는 허브 화면이 담당 — 웹이 정본이라
// 카탈로그를 여기 복제하지 않는다).
// 키는 환경변수 vault에 저장되고 자동 주입 — LLM 무관.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import { PluginPickerDialog } from "@/components/plugins/PluginPickerDialog";
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
  IconRefresh,
  IconShield,
  IconTrash,
  IconWand,
} from "@/components/Icon";

type Tab = "installed" | "catalog";

export default function LibraryMcpsPage() {
  const { t, locale } = useT();
  const router = useRouter();
  const brandMap = usePluginBrandMap();
  const [tab, setTab] = useState<Tab>("installed");
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 마지막 추가에서 **못 붙은 것들**. 화면에 안 나오면 "추가했는데 없다"가 된다.
   *
   * 실측(2026-08-20): 팝업이 돌려주던 skipped 를 이 페이지가 통째로 버리고 있었다.
   * 허브 목록에는 있지만 연결 정보(mcp 행)가 아직 없는 항목이 적지 않고, 그런 것을
   * 고르면 팝업이 조용히 닫히고 목록은 그대로였다 — 사용자에게는 아무 일도 안 일어난
   * 것처럼 보이고, 왜인지 알 길이 없었다.
   */
  const [addSkipped, setAddSkipped] = useState<Array<{ slug: string; reason: string }>>([]);
  const [catalog, setCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [testing, setTesting] = useState<string | null>(null);
  // Without this the empty state renders on first paint and stays for the
  // 10-15s the initial listing takes, pixel-identical to "nothing is
  // connected" — a user checking plugin status in that window concludes the
  // app has no tools and leaves.
  const [loaded, setLoaded] = useState(false);
  // 커스텀 MCP 추가 폼
  const [cName, setCName] = useState("");
  const [cTransport, setCTransport] = useState<"stdio" | "sse" | "http">("stdio");
  const [cCommand, setCCommand] = useState("npx");
  const [cArgs, setCArgs] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cEnv, setCEnv] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const customOpenCrabUrl = cTransport !== "stdio" && isOpenCrabCredentialUrl(cUrl);

  async function addCustom() {
    const api = ipc();
    if (!api || !cName.trim() || customOpenCrabUrl) return;
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
      await refresh();
      setTab("installed");
    } finally {
      setCBusy(false);
    }
  }

  // URL을 붙여넣으면 원격 트랜스포트를 자동 감지하고 이름을 유추한다.
  // (경로/쿼리에 sse가 있으면 레거시 SSE, 아니면 현대 표준 Streamable HTTP)
  function onUrlChange(v: string) {
    setCUrl(v);
    const trimmed = v.trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    try {
      const u = new URL(trimmed);
      const isSse = /(^|[/?&#])sse($|[/?&#])/i.test(u.pathname + u.search);
      setCTransport(isSse ? "sse" : "http");
      if (!cName.trim()) {
        // TLD가 포함된 완전한 호스트일 때만 이름 유추 — 한 글자씩 타이핑하는 도중
        // "https://o" 같은 미완성 호스트("o")로 이름이 조기 확정되는 걸 막는다.
        const host = u.hostname.replace(/^www\./, "");
        if (host.includes(".")) {
          const label = host.split(".")[0];
          if (label) setCName(label);
        }
      }
    } catch {
      /* 아직 완성되지 않은 URL — 무시 */
    }
  }

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [c, i, s] = await Promise.all([
      api.mcpTools.listCatalog(),
      api.mcpTools.listInstalled(),
      api.mcpTools.status(),
    ]);
    setCatalog(c);
    setInstalled(i);
    setStatuses(Object.fromEntries(s.map((status) => [status.id, status])));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byCatalogId = useMemo(() => {
    const m = new Map<string, McpToolCatalogEntry>();
    for (const e of catalog) m.set(e.id, e);
    return m;
  }, [catalog]);

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

      {/* 탭 — 세 번째는 탭이 아니라 허브 화면으로 나가는 문이다.
          카탈로그의 정본은 웹(허브)이므로 여기에 사본을 두지 않는다. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, alignItems: "center", flexWrap: "wrap" }}>
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
        {/* 예전에는 이 자리가 마켓플레이스로 나가는 문이었다. 도구 하나를 붙이려던
            사람이 에이전트·팀·그래프가 섞인 장터로 튕겨 나가 하려던 일을 잃었으므로,
            고르는 화면을 이 자리에 띄운다(라우팅 없음). */}
        <button
          onClick={() => setPickerOpen(true)}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12.5,
            fontWeight: 600,
            background: "var(--one-primary)",
            color: "var(--white)",
            border: "1px solid transparent",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {locale === "en" ? "Add tools" : "도구 추가"}
        </button>
      </div>

      {pickerOpen && (
        <PluginPickerDialog
          ko={locale !== "en"}
          // 닫기로도 새로고침한다. 로그인·키 단계에서 X 나 Esc 로 나가면 onCompleted 가
          // 오지 않는데, 그때도 서버는 이미 등록돼 있다 — 새로고침을 안 하면 방금 깐 것이
          // 목록에 없는 것처럼 보인다.
          onClose={() => { setPickerOpen(false); void refresh(); }}
          onCompleted={(result) => {
            // 팝업이 등록한 서버는 이 목록에 즉시 나타나야 한다. 새로고침을 사용자가
            // 직접 하게 두면 "추가했는데 없다"로 읽힌다.
            void refresh();
            setTab("installed");
            setAddSkipped(result?.skipped ?? []);
          }}
        />
      )}

      {addSkipped.length > 0 && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: "12px 14px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          <strong style={{ display: "block", marginBottom: 6 }}>
            {locale === "en"
              ? `${addSkipped.length} of the tools you picked could not be connected`
              : `고른 것 중 ${addSkipped.length}개는 연결하지 못했어요`}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 16, color: "var(--ink-soft)" }}>
            {addSkipped.map((row) => (
              <li key={row.slug}>{`${row.slug} — ${row.reason}`}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setAddSkipped([])}
            style={{
              marginTop: 8, border: 0, background: "transparent",
              color: "var(--ink-soft)", cursor: "pointer", padding: 0, fontSize: 12.5,
            }}
          >
            {locale === "en" ? "Dismiss" : "닫기"}
          </button>
        </div>
      )}

      {tab === "installed" ? (
        !loaded ? (
          <Empty text={t("mcps.installed_loading")} />
        ) : installed.length === 0 ? (
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
                    <PluginLogo
                      catalogId={server.catalogId}
                      name={server.name}
                      size={26}
                      brandColor={server.catalogId ? byCatalogId.get(server.catalogId)?.brandColor : undefined}
                      mark={server.catalogId ? byCatalogId.get(server.catalogId)?.mark : undefined}
                      brandMap={brandMap}
                    />
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
                          color: server.enabled ? "var(--ok)" : "var(--ink-soft)",
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
        {/* 커스텀 MCP 추가 — 이 탭의 본체다. 카탈로그에서 고르는 길은 허브 화면이 맡는다. */}
        <div style={{ marginBottom: 12 }}>
          {(
            <div
              className="glass-strong"
              style={{ padding: 14, borderRadius: "var(--radius-md)", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13, flex: 1 }}>{t("mcps.custom.title")}</strong>
              </div>
              <input
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                placeholder={t("mcps.custom.name")}
                style={{ ...customInput, width: "100%" }}
              />
              {/* 로컬(명령) / 원격(URL) 세그먼트 — 원격 URL 진입로를 명확히 노출 */}
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => setCTransport("stdio")} style={segBtn(cTransport === "stdio")}>
                  {t("mcps.custom.mode_local")}
                </button>
                <button
                  type="button"
                  onClick={() => setCTransport(cTransport === "stdio" ? "http" : cTransport)}
                  style={segBtn(cTransport !== "stdio")}
                >
                  {t("mcps.custom.mode_remote")}
                </button>
              </div>
              {cTransport === "stdio" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input value={cCommand} onChange={(e) => setCCommand(e.target.value)} placeholder={t("mcps.custom.command")} style={{ ...customInput, flex: "0 0 100px", fontFamily: "var(--font-mono)" }} />
                  <input value={cArgs} onChange={(e) => setCArgs(e.target.value)} placeholder={t("mcps.custom.args")} style={{ ...customInput, flex: "1 1 200px", fontFamily: "var(--font-mono)" }} />
                </div>
              ) : (
                <>
                  <input
                    value={cUrl}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder={t("mcps.custom.url")}
                    style={{ ...customInput, width: "100%", fontFamily: "var(--font-mono)" }}
                  />
                  {cUrl.trim() ? (
                    <div style={{ fontSize: 11, color: "var(--muted-deep)", display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{t("mcps.custom.detected")}:</span>
                      <button type="button" onClick={() => setCTransport("http")} style={detBtn(cTransport === "http")}>HTTP</button>
                      <button type="button" onClick={() => setCTransport("sse")} style={detBtn(cTransport === "sse")}>SSE</button>
                    </div>
                  ) : null}
                  {customOpenCrabUrl && (
                    <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--peach-ink)" }}>
                      {/* 카탈로그가 허브 화면으로 옮겨졌으므로 "아래 카드"가 아니라 그 화면을 가리킨다. */}
                      {locale === "en"
                        ? "Private OpenCrab URLs contain a credential. Connect OpenCrab from “Browse the Hub” so the URL stays in Keychain."
                        : "OpenCrab 개인 URL에는 인증정보가 들어 있습니다. URL이 키체인에만 남도록 ‘허브에서 찾아보기’에서 OpenCrab을 연결하세요."}
                    </div>
                  )}
                </>
              )}
              <input
                value={cEnv}
                onChange={(e) => setCEnv(e.target.value)}
                placeholder={cTransport === "stdio" ? t("mcps.custom.env") : t("mcps.custom.header")}
                style={{ ...customInput, width: "100%", fontFamily: "var(--font-mono)" }}
              />
              <button
                onClick={() => void addCustom()}
                disabled={!cName.trim() || cBusy || customOpenCrabUrl}
                style={{
                  alignSelf: "flex-start",
                  padding: "7px 16px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 700,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--neu-raised)" : "none",
                  background: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--paper)" : "var(--paper-2)",
                  color: cName.trim() && !cBusy && !customOpenCrabUrl ? "var(--ink)" : "var(--muted-deep)",
                }}
              >
                {cBusy ? t("mcps.testing") : t("mcps.custom.create")}
              </button>
            </div>
          )}
        </div>

        {/* 카탈로그의 정본은 여전히 허브다 — 사본을 두지 않고 그 목록을 팝업으로
            읽어 온다. 달라진 것은 화면을 떠나지 않는다는 점뿐이다. */}
        <button
          onClick={() => setPickerOpen(true)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "16px 18px",
            borderRadius: "var(--radius-md)",
            border: "1px dashed var(--paper-edge)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <IconWand size={18} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{t("mcps.tab.hub")}</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--muted-deep)", marginTop: 2 }}>
              {t("mcps.tab.hub_note")}
            </span>
          </span>
          <span aria-hidden style={{ color: "var(--muted-deep)" }}>→</span>
        </button>
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

function isOpenCrabCredentialUrl(value: string): boolean {
  const raw = value.trim();
  if (/ocm_[A-Za-z0-9_-]{12,}/.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return host === "opencrab.sh" || host.endsWith(".opencrab.sh");
  } catch {
    return false;
  }
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
  /*
   * ★확인을 미룬 것은 실패가 아니다(2026-09-03 실측).
   *
   * 브라우저처럼 사람에게 보이는 창을 여는 서버는 수동 점검이 일부러 건너뛴다
   * (statusAllServers → deferredInteractiveStatus). 그런데 화면은 그 표식을 안 읽고
   * 빨간 "연결 실패: unknown" 으로 그렸다 — 원인도 해법도 없는 문구다. 실제로는 멀쩡한
   * 플러그인 둘(Agentlas 브라우저 · Playwright)이 고장난 것처럼 보였다.
   */
  if (status.deferred === "interactive") {
    return (
      <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
        {t("mcps.status.deferred")}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: "var(--red-deep)" }}>
      {t("mcps.status.error", { error: status.error ?? "unknown" })}
    </div>
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

/** 로컬/원격 세그먼트 버튼 스타일 (active면 강조). */
function segBtn(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "7px 12px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: "var(--radius-md)",
    border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
    background: active ? "var(--paper)" : "var(--paper-2)",
    color: active ? "var(--ink)" : "var(--muted-deep)",
    boxShadow: active ? "var(--neu-raised)" : "none",
    cursor: "pointer",
  };
}

/** 감지된 트랜스포트(HTTP/SSE) 배지 버튼 — 클릭으로 수동 오버라이드. */
function detBtn(active: boolean): React.CSSProperties {
  return {
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
    background: active ? "var(--paper)" : "transparent",
    color: active ? "var(--ink)" : "var(--muted-deep)",
    cursor: "pointer",
  };
}

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
