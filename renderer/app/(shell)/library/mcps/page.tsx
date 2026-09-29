// 외부 MCP 툴 플러그인 매니저 — Slack/Discord/GitHub 등을 실제로 연결한다(Codex 스타일).
// 한 번 연결하면 모든 에이전트·팀이 공유한다 (에이전트별 연결 개념 없음 — 전역 원터치).
// 세 갈래: 연결됨(설치된 서버 + 상태/테스트/제거) · 커스텀 도구 추가(URL·명령 직접
// 등록) · 허브에서 찾아보기(카탈로그 전체는 허브 화면이 담당 — 웹이 정본이라
// 카탈로그를 여기 복제하지 않는다).
// 키는 환경변수 vault에 저장되고 자동 주입 — LLM 무관.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { ChipGrid, ConnectChip } from "@/components/connect/RuntimeConnect";
import { ServiceConnectPopup, waitForConnectPoll, type ServiceConnectRun } from "@/components/connect/ServiceConnect";
import { PluginLogo, usePluginBrandMap } from "@/components/PluginLogo";
import { PluginPickerDialog } from "@/components/plugins/PluginPickerDialog";
import { useT } from "@/lib/i18n";
import type {
  InstalledMcpServer,
  McpServerStatus,
  McpToolCatalogEntry,
} from "@/lib/types";
import {
  IconLock,
  IconShield,
  IconWand,
} from "@/components/Icon";

type Tab = "installed" | "catalog";

export default function LibraryMcpsPage() {
  const { t, locale } = useT();
  const ko = locale === "ko";
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
  const [connecting, setConnecting] = useState<InstalledMcpServer | null>(null);
  // Without this the empty state renders on first paint and stays for the
  // 10-15s the initial listing takes, pixel-identical to "nothing is
  // connected" — a user checking plugin status in that window concludes the
  // app has no tools and leaves.
  const [loaded, setLoaded] = useState(false);
  /* ★읽기 실패를 "없음" 으로 그리지 않기 위한 표식 (실측 2026-09-08). */
  const [loadFailed, setLoadFailed] = useState(false);
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
    /*
     * ★못 읽었는데 화면은 "아직 연결한 도구가 없습니다" 를 그렸다 (읽기 실패 실측
     *   2026-09-08). 도구를 연결해 둔 사람에게는 거짓말이고, 다시 연결하러 가게 만든다.
     *   실패는 사실이 아니다 — 읽지 못했다는 것을 말한다.
     */
    let loadedRows;
    try {
      loadedRows = await Promise.all([
        api.mcpTools.listCatalog(),
        api.mcpTools.listInstalled(),
        api.mcpTools.status(),
      ]);
    } catch {
      setLoadFailed(true);
      setLoaded(true);
      return;
    }
    const [c, i, s] = loadedRows;
    setLoadFailed(false);
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

  const connectServer = useCallback<ServiceConnectRun>(async (signal, update) => {
    const api = ipc();
    if (!api || !connecting) throw new Error(ko ? "연결을 사용할 수 없어요. (bridge_unavailable)" : "Connection is unavailable. (bridge_unavailable)");
    const assertActive = () => { if (signal.aborted) throw new Error("cancelled"); };
    update({ step: "setup", note: ko ? "저장된 연결 설정을 확인하고 있어요." : "Checking the saved configuration." });
    if (!connecting.enabled) { assertActive(); await api.mcpTools.setEnabled(connecting.id, true); assertActive(); }
    const probe = async () => {
      assertActive();
      const result = await api.mcpTools.test(connecting.id);
      assertActive();
      setStatuses((previous) => ({ ...previous, [connecting.id]: result }));
      return result;
    };
    let status = await probe();
    if (status.missingEnv.length) throw new Error(`${ko ? "필수 키를 설정해 주세요" : "Set the required keys"}: ${status.missingEnv.join(", ")} (missing_env)`);
    if (!status.connected) {
      const auth = await api.mcpTools.oauthStatus(connecting.id);
      assertActive();
      if (auth.supported && !auth.connected) {
        update({ step: "login", note: ko ? "공식 로그인·동의 페이지를 열고 있어요. 브라우저에서 마쳐 주세요." : "Opening official sign-in and consent. Finish in the browser." });
        const result = await api.mcpTools.oauthConnect(connecting.id);
        assertActive();
        if (!result.ok) throw new Error(`${result.error} (oauth_failed)`);
        if (result.manualUrl) {
          update({ step: "login", note: ko ? "아래 공식 페이지를 열어 로그인을 마쳐 주세요." : "Open the official page below to finish sign-in.", manualUrl: result.manualUrl });
          for (let attempt = 0; attempt < 60; attempt += 1) {
            await waitForConnectPoll(signal);
            const current = await api.mcpTools.oauthStatus(connecting.id);
            assertActive();
            if (current.supported && current.connected) break;
            if (attempt === 59) throw new Error(ko ? "로그인을 제한 시간 안에 확인하지 못했어요. (login_timeout)" : "Sign-in was not verified in time. (login_timeout)");
          }
        }
        update({ step: "verifying", note: ko ? "서버에 실제로 연결해 도구 목록을 확인하고 있어요." : "Connecting to the server to read its live tool list." });
        status = await probe();
      }
    }
    if (!status.connected) throw new Error(`${status.error || (ko ? "서버에 연결하지 못했어요." : "Could not connect to the server.")} (probe_failed)`);
    if (!status.tools.length) throw new Error(ko ? "서버 응답은 있지만 사용 가능한 도구가 없어요. (empty_tools)" : "The server responded but supplied no tools. (empty_tools)");
    return { evidence: [`tools/list · ${status.tools.length} ${ko ? "개 도구" : "tools"}`, status.tools.slice(0, 3).map((tool) => tool.name).join(", "), new Date(status.checkedAt).toLocaleTimeString()] };
  }, [connecting, ko]);

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
              ? `${ko ? "설치된 도구" : "Installed tools"}${installed.length ? ` · ${installed.length}` : ""}`
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
        ) : loadFailed ? (
          <Empty text={locale === "ko"
            ? "도구 목록을 불러오지 못했습니다. 연결이 끊긴 것이 아니라 읽지 못한 것입니다 — 잠시 뒤 다시 열어 보세요."
            : "The tool list could not be loaded. Nothing was disconnected — the read failed. Try again in a moment."} />
        ) : installed.length === 0 ? (
          <Empty text={t("mcps.installed_empty")} />
        ) : (
          <ChipGrid label={ko ? "MCP 연결" : "MCP connections"}>
            {installed.map((server) => {
              const name = locale === "en" ? server.nameEn || server.name : server.name;
              const status = statuses[server.id];
              const ready = server.enabled && Boolean(status?.connected && status.tools.length > 0 && status.missingEnv.length === 0);
              const badge = !server.enabled ? (ko ? "꺼짐" : "Off") : ready ? (ko ? "연결됨" : "Connected") : status?.missingEnv.length ? (ko ? "키 필요" : "Keys needed") : status?.deferred ? (ko ? "확인 필요" : "Check needed") : (ko ? "연결 확인 필요" : "Unverified");
              return <ConnectChip key={server.id} icon={<PluginLogo catalogId={server.catalogId} name={server.name} size={26} brandColor={server.catalogId ? byCatalogId.get(server.catalogId)?.brandColor : undefined} mark={server.catalogId ? byCatalogId.get(server.catalogId)?.mark : undefined} brandMap={brandMap} />}
                name={name} sub={t(`mcps.transport.${server.transport}` as "mcps.transport.stdio")} ready={ready} badge={badge} badgeTone={ready ? "ok" : status?.missingEnv.length ? "warn" : undefined}
                facts={ready && status ? [`tools/list · ${status.tools.length} ${ko ? "개 도구" : "tools"}`, status.tools.slice(0, 3).map((tool) => tool.name).join(", "), new Date(status.checkedAt).toLocaleTimeString()] : status?.missingEnv.length ? [status.missingEnv.join(", ")] : []}
                action={{ label: ready ? (ko ? "다시 확인" : "Recheck") : (ko ? "연결" : "Connect"), onClick: () => setConnecting(server) }}
                secondaryActions={[{ label: server.enabled ? t("mcps.off") : t("mcps.on"), onClick: () => void toggle(server) }, { label: t("mcps.remove"), onClick: () => void remove(server) }]} />;
            })}
          </ChipGrid>
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

      {connecting && <ServiceConnectPopup name={locale === "en" ? connecting.nameEn || connecting.name : connecting.name} icon={<PluginLogo catalogId={connecting.catalogId} name={connecting.name} size={28} brandMap={brandMap} />} ko={ko} run={connectServer}
        setupLink={connecting.envKeys.length ? { label: ko ? "필수 키 설정" : "Set required keys", href: "/library/env" } : undefined}
        onClose={() => { setConnecting(null); void refresh(); }} onDone={() => { setConnecting(null); void refresh(); }} />}

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
