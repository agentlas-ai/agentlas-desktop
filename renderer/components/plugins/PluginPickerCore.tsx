"use client";

// 도구 고르기의 알맹이 — 목록·선택 판정·설치 실행·설치 뒤 후속 단계.
//
// 왜 껍데기와 갈라 놓았나: 같은 일을 두 자리에서 한다.
//  · 설정·Connect 화면에서 버튼으로 여는 **팝업**(PluginPickerDialog)
//  · 처음 실행 온보딩의 **전체화면 스텝**(WorkFirstRunOnboarding)
// 둘은 생김새가 아예 다르다(모달 카드 목록 vs. 큰 질문 + 타일 그리드). 그래서 공유하는
// 것은 마크업이 아니라 **행동**이다 — 무엇을 목록으로 받고, 무엇이 이미 설치돼 있고,
// 고른 것을 어떻게 설치하고, 설치 뒤에 무엇을 더 물어야 하는가. 이 파일이 그 답을
// 한 벌만 갖고, 두 껍데기가 각자 그려서 쓴다.
//
// 경계는 그대로다: 키 "값"은 여기를 지나 곧바로 env.set(키체인 vault)으로만 간다.
// 설치 IPC는 값을 싣지 않는다.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { PluginLogo, pluginSlugCandidates } from "@/components/PluginLogo";
import type {
  BrowserSite,
  InstalledMcpServer,
  MarketplaceListing,
  PluginAuthKind,
  PluginBrandAsset,
} from "@/lib/types";
import styles from "./PluginPickerDialog.module.css";

export interface PluginPickerResult {
  /** 이번에 실제로 서버가 등록된 플러그인. */
  installed: string[];
  /** 고르긴 했지만 붙일 서버가 없거나 실패한 항목 — 조용히 성공으로 위장하지 않는다. */
  skipped: Array<{ slug: string; reason: string }>;
  /** 사용자가 "나중에 입력"을 고른 환경변수 이름들. 값은 담지 않는다. */
  deferredKeys: string[];
}

// ── 카탈로그 ──────────────────────────────────────────────────────────────────

export interface PluginCatalog {
  listings: MarketplaceListing[];
  installed: InstalledMcpServer[];
  linkedSites: BrowserSite[];
  /** 첫 응답이 도착했는가. false 동안 "결과 없음"을 그리면 빈 화면과 구분되지 않는다. */
  loaded: boolean;
  loadError: string | null;
  refresh: () => Promise<void>;
  isInstalled: (listing: MarketplaceListing) => boolean;
  hasBrowserLogin: (listing: MarketplaceListing) => boolean;
}

/**
 * 허브 카탈로그 + 이 기계에 이미 붙어 있는 서버 + 이미 가져온 브라우저 로그인.
 *
 * `enabled`가 false면 아무것도 부르지 않는다 — 온보딩은 도구 스텝 근처에 와서야
 * 목록이 필요한데, 컴포넌트가 뜨자마자 받아 오면 화면을 보지도 않는 사람의 첫 실행에
 * 네트워크 요청만 남는다.
 */
export function usePluginCatalog(options?: { enabled?: boolean }): PluginCatalog {
  const enabled = options?.enabled ?? true;
  const api = ipc();
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [linkedSites, setLinkedSites] = useState<BrowserSite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !enabled) return;
    try {
      const [rows, servers, sites] = await Promise.all([
        api.marketplace.search(""),
        api.mcpTools.listInstalled().catch(() => [] as InstalledMcpServer[]),
        // 이미 브라우저 자격증명을 붙여 둔 사이트. 로그인이 필요한 도구가 "이미
        // 로그인돼 있다"를 말할 수 있는 유일한 근거다.
        api.browser.listSites().catch(() => [] as BrowserSite[]),
      ]);
      setListings((Array.isArray(rows) ? rows : []).filter(isPluginListing));
      setInstalled(servers ?? []);
      setLinkedSites(sites ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "load failed");
    } finally {
      setLoaded(true);
    }
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const installedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const server of installed) {
      for (const candidate of pluginSlugCandidates({
        catalogId: server.catalogId,
        name: server.name,
      })) set.add(candidate);
    }
    return set;
  }, [installed]);

  const isInstalled = useCallback(
    (listing: MarketplaceListing) =>
      pluginSlugCandidates({ slug: listing.slug, name: listing.name }).some((key) => installedSlugs.has(key)),
    [installedSlugs],
  );

  /**
   * 이 도구가 붙는 서비스에 이미 브라우저 로그인이 있는가.
   *
   * 있으면 로그인 타입 도구도 "아이디를 다시 치는 일"이 아니라 "동의 한 번"으로 끝난다.
   * 인가 창이 Agentlas 전용 Chrome에서 열리고 그 프로필에 세션이 이미 있기 때문이다.
   * 다만 "자동 로그인됨"이라고는 쓰지 않는다: 서비스에 따라 동의 화면은 여전히 뜬다.
   */
  const hasBrowserLogin = useCallback(
    (listing: MarketplaceListing) => {
      const domain = serviceDomainOf(listing);
      if (!domain) return false;
      return linkedSites.some((entry) => {
        // `site`는 보통 도메인이지만 주소 형태로 저장된 행도 있다. 둘 다 받는다.
        const host = (() => {
          try { return new URL(/^https?:\/\//i.test(entry.site) ? entry.site : `https://${entry.site}`).hostname; }
          catch { return entry.site; }
        })();
        return domainMatches(domain, host);
      });
    },
    [linkedSites],
  );

  return { listings, installed, linkedSites, loaded, loadError, refresh, isInstalled, hasBrowserLogin };
}

// ── 설치 실행 ─────────────────────────────────────────────────────────────────

export interface PluginInstallOutcome {
  result: PluginPickerResult;
  /** 설치는 됐지만 환경변수를 받아야 하는 항목. */
  needKeys: Array<{ slug: string; name: string; envKeys: string[] }>;
  /** 설치는 됐지만 인가(OAuth)를 돌려야 하는 항목. */
  needLogin: Array<{ slug: string; name: string; serverId: string }>;
}

/**
 * 고른 항목을 차례로 설치한다.
 *
 * 실패는 그 항목에서 멈추고 나머지를 계속한다 — 하나가 안 붙었다고 나머지 선택을
 * 버리면 사용자는 무엇이 됐고 무엇이 안 됐는지 모른 채 처음부터 다시 골라야 한다.
 */
/**
 * 이 서버가 지금 이미 붙는가. 붙으면 키를 물을 이유가 없다.
 *
 * 못 재면 **false** 를 돌려 원래대로 묻는다 — 확인 실패를 "괜찮다"로 읽으면 키가 정말
 * 필요한 도구가 조용히 죽은 채 남는다.
 */
async function alreadyConnects(
  api: NonNullable<ReturnType<typeof ipc>>,
  serverId: string | null,
): Promise<boolean> {
  if (!serverId) return false;
  try {
    const status = await api.mcpTools.test(serverId);
    // 도구를 실제로 받아 왔을 때만 "된다"로 본다. connected 만 보면 붙자마자 아무것도
    // 못 내주는 서버까지 통과시킨다. missingEnv 가 남아 있으면 당연히 물어야 한다.
    return Boolean(status?.connected)
      && (status.tools?.length ?? 0) > 0
      && (status.missingEnv?.length ?? 0) === 0;
  } catch {
    return false;
  }
}

export async function installPlugins(input: {
  chosen: MarketplaceListing[];
  ko: boolean;
  onProgress?: (name: string | null) => void;
}): Promise<PluginInstallOutcome> {
  const { chosen, ko, onProgress } = input;
  const api = ipc();
  const result: PluginPickerResult = { installed: [], skipped: [], deferredKeys: [] };
  const needKeys: PluginInstallOutcome["needKeys"] = [];
  const needLogin: PluginInstallOutcome["needLogin"] = [];
  if (!api || chosen.length === 0) return { result, needKeys, needLogin };

  try {
    for (const listing of chosen) {
      onProgress?.(listing.name);
      try {
        const preview = await api.mcpTools.previewHubPlugin(listing.manifestUrl);
        // 스킬 번들(실콘텐츠가 실린 skills[])은 서버 없이도 설치 대상이다 —
        // ~/.agentlas/plugins/<slug>/ 에 파일로 착지한다(오너 결정 2026-08-20).
        const previewSkills = preview
          ? ((preview as typeof preview & { skills?: Array<{ name: string }> }).skills ?? [])
          : [];
        if (!preview || (preview.rows.length === 0 && previewSkills.length === 0)) {
          result.skipped.push({
            slug: listing.slug,
            reason: listing.connectSetupRequired
              ? ko
                ? "계정별로 연결 주소가 달라 자동 설치할 수 없습니다. 제공사 안내를 따라 연결하세요."
                : "Its connection is minted per account, so it cannot be installed automatically. Follow the provider's setup guide."
              : ko
                ? "연결할 수 있는 MCP 서버 정보도 스킬 콘텐츠도 아직 없습니다."
                : "No connectable MCP server information or skill content yet.",
          });
          continue;
        }
        // stdio 행은 이 기계에서 명령을 실행한다는 뜻이다. 사용자가 명령 원문을 보고
        // 누른 것이 아니라 목록에서 체크만 했으므로 여기서 승인으로 취급하지 않는다 —
        // 비활성으로 등록되고 MCP 화면이 승인 대기로 표면화한다.
        const receipt = await api.mcpTools.installHubPlugin({
          slug: listing.slug,
          manifestUrl: listing.manifestUrl,
          approveLocalExecution: false,
        });
        const connected = receipt.receipts.filter(
          (row) => row.action === "connected" || row.action === "already-installed",
        );
        const pending = receipt.receipts.filter((row) => row.action === "needs-approval");
        const failed = receipt.receipts.filter((row) => row.action === "skipped");

        if (connected.length > 0 || pending.length > 0) {
          result.installed.push(listing.slug);
          /*
           * 다음에 무엇을 물을지는 **실제로 깔린 것**이 정한다 — 허브가 선언한 auth 가
           * 아니다. 그 둘은 갈린다(2026-08-20 실측):
           *   Notion — 허브 auth="oauth" 인데 우리가 까는 것은 stdio + NOTION_TOKEN.
           *     그래서 로그인 갈래로 새고, 메인은 "this server has no remote URL to
           *     authorize" 로 거절하고, 정작 필요한 토큰은 묻지도 않았다.
           * 원격(http/sse) 행이 있어야 인가할 대상이 있다. stdio 뿐이면 인가할 URL 자체가
           * 없으므로 로그인은 물어볼 수 없는 것이고, 필요한 것은 키다.
           */
          const serverId = connected.find((row) => row.serverId)
            ?? pending.find((row) => row.serverId)
            ?? null;
          const step = nextSetupStepFor({ listing, rows: preview.rows });

          if (step === "login" && serverId?.serverId) {
            needLogin.push({ slug: listing.slug, name: listing.name, serverId: serverId.serverId });
            continue;
          }
          if (step !== "keys") continue;
          // 키를 묻기 전에 **이미 되는지 본다.** 제공사가 토큰을 선언해도 익명으로 붙는
          // 서버가 있다. 되는 것에 키를 물으면 사용자는 없는 숙제를 받는다.
          if (await alreadyConnects(api, serverId?.serverId ?? null)) continue;
          const envKeys = [...new Set(preview.rows.flatMap((row) => row.envKeys ?? []))];
          needKeys.push({ slug: listing.slug, name: listing.name, envKeys });
        } else if (failed.length > 0) {
          result.skipped.push({
            slug: listing.slug,
            reason: failed[0]?.reason ?? (ko ? "설치하지 못했습니다." : "Install failed."),
          });
        }
      } catch (error) {
        result.skipped.push({
          slug: listing.slug,
          reason: error instanceof Error ? error.message.slice(0, 200) : "install failed",
        });
      }
    }
  } finally {
    onProgress?.(null);
  }

  return { result, needKeys, needLogin };
}

// ── 로그인(OAuth) 단계 ────────────────────────────────────────────────────────

export interface LoginStepState {
  queue: Array<{ slug: string; name: string; serverId: string }>;
  index: number;
  /** 로그인이 끝난 뒤에 이어서 물어볼 키 목록. */
  keyQueue: Array<{ slug: string; name: string; envKeys: string[] }>;
  result: PluginPickerResult;
}

/**
 * 서비스에 로그인해 권한을 준다.
 *
 * 버튼을 누르면 Agentlas 전용 Chrome에 동의 화면이 열린다. 그 프로필에는 사용자가
 * 가져온 브라우저 로그인이 들어 있으므로, 대개 아이디를 다시 칠 일이 없다. 창을
 * 못 열었으면 주소를 그대로 보여 준다 — 다른 브라우저로 조용히 흘려보내면 그
 * 로그인을 못 쓰고, 사용자는 왜 또 로그인해야 하는지 알 수 없다.
 *
 * 건너뛰기는 언제나 열려 있다. 서버는 이미 등록돼 있으므로 나중에 MCP 화면에서
 * 연결해도 된다.
 *
 * `chrome`: 팝업에서는 모달로 뜨고, 온보딩에서는 이미 열려 있는 전체화면 안에
 * 그대로 놓인다 — 온보딩 도중에 모달을 또 띄우지 않기 위해서다.
 */
export function LoginStep({
  ko,
  state,
  brandMap,
  chrome = "modal",
  onDone,
  onAdvance,
}: {
  ko: boolean;
  state: LoginStepState;
  brandMap: Record<string, PluginBrandAsset>;
  chrome?: "modal" | "inline";
  onDone: (result: PluginPickerResult, keyQueue: LoginStepState["keyQueue"]) => void;
  onAdvance: (next: LoginStepState) => void;
}) {
  const api = ipc();
  const current = state.queue[state.index];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setError(null);
    setManualUrl(null);
    setConnected(false);
  }, [state.index]);

  if (!current) {
    onDone(state.result, state.keyQueue);
    return null;
  }

  const advance = () => {
    if (state.index + 1 >= state.queue.length) onDone(state.result, state.keyQueue);
    else onAdvance({ ...state, index: state.index + 1 });
  };

  const connect = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.mcpTools.oauthConnect(current.serverId);
      if (out.ok) {
        setManualUrl(out.manualUrl);
        setConnected(true);
        // 창이 정상으로 열려 인가까지 끝났으면 바로 다음으로. 수동 URL이 남았다면
        // 사용자가 그 주소를 볼 수 있게 화면을 유지한다.
        if (!out.manualUrl) advance();
      } else {
        setError(out.error);
      }
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "connection failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StageShell chrome={chrome} labelledBy="plugin-login-title">
      <header className={styles.keyHeader}>
        <PluginLogo slug={current.slug} name={current.name} size={36} brandMap={brandMap} />
        <div>
          <h2 id="plugin-login-title" className={styles.title}>
            {ko ? `${current.name}에 로그인` : `Sign in to ${current.name}`}
          </h2>
          <p className={styles.keySub}>
            {ko
              ? "Agentlas 브라우저에서 동의 화면이 열립니다. 이미 로그인해 두셨다면 아이디를 다시 칠 필요 없이 허용만 누르시면 됩니다."
              : "A consent screen opens in the Agentlas browser. If you are already signed in there, just approve — no need to type your credentials again."}
          </p>
        </div>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      {manualUrl && (
        <p className={styles.keyNote}>
          {ko
            ? "Agentlas 브라우저를 열지 못했습니다. 아래 주소를 직접 열어 로그인하세요:"
            : "The Agentlas browser could not be opened. Open this address yourself to sign in:"}
          <br />
          <code style={{ wordBreak: "break-all" }}>{manualUrl}</code>
        </p>
      )}

      {connected && !manualUrl && (
        <p className={styles.keyNote}>{ko ? "연결됐습니다." : "Connected."}</p>
      )}

      <footer className={styles.footer}>
        <span className={styles.count}>
          {state.queue.length > 1
            ? ko ? `${state.index + 1} / ${state.queue.length}` : `${state.index + 1} of ${state.queue.length}`
            : ""}
        </span>
        <div className={styles.footerActions}>
          <button type="button" className={styles.ghost} disabled={busy} onClick={advance}>
            {ko ? "나중에 로그인" : "Sign in later"}
          </button>
          {/*
            수동 URL 이 뜬 상태에서는 라벨이 "다음"이므로 **실제로 다음으로 가야 한다.**
            예전에는 라벨만 바뀌고 onClick 이 그대로 connect() 였다 — 눌러도 같은 화면에서
            연결을 다시 시도할 뿐이라 큐가 영영 전진하지 않았고, 빠져나가는 길이
            "나중에 로그인" 하나뿐이었다. 버튼이 말한 것과 하는 일이 달랐다.
          */}
          <button
            type="button"
            className={styles.primary}
            onClick={() => (manualUrl ? advance() : void connect())}
            disabled={busy}
          >
            {busy
              ? ko ? "연결하는 중…" : "Connecting…"
              : manualUrl
                ? ko ? "다음" : "Next"
                : ko ? "로그인하고 연결" : "Sign in and connect"}
          </button>
        </div>
      </footer>
    </StageShell>
  );
}

// ── 키 입력 단계 ──────────────────────────────────────────────────────────────

export interface KeyStepState {
  queue: Array<{ slug: string; name: string; envKeys: string[] }>;
  index: number;
  result: PluginPickerResult;
}

/**
 * 설치된 서버가 요구하는 환경변수를 받는다.
 *
 * "나중에 입력하기"가 1급 선택지인 이유: 키는 대개 다른 사이트에 로그인해야 나온다.
 * 그걸 지금 강제하면 사용자는 이 흐름을 떠나고, 떠난 사람은 대부분 돌아오지 않는다.
 * 서버는 이미 등록돼 있으므로 키만 나중에 채우면 그대로 살아난다.
 */
export function KeyStep({
  ko,
  state,
  brandMap,
  chrome = "modal",
  onDone,
  onAdvance,
}: {
  ko: boolean;
  state: KeyStepState;
  brandMap: Record<string, PluginBrandAsset>;
  chrome?: "modal" | "inline";
  onDone: (result: PluginPickerResult) => void;
  onAdvance: (next: KeyStepState) => void;
}) {
  const api = ipc();
  const current = state.queue[state.index];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 다음 플러그인으로 넘어갈 때 앞 항목의 입력값이 남아 있으면 안 된다.
  useEffect(() => {
    setValues({});
    setError(null);
  }, [state.index]);

  if (!current) {
    onDone(state.result);
    return null;
  }

  const advance = (deferred: string[]) => {
    const result: PluginPickerResult = {
      ...state.result,
      deferredKeys: [...state.result.deferredKeys, ...deferred],
    };
    if (state.index + 1 >= state.queue.length) onDone(result);
    else onAdvance({ ...state, index: state.index + 1, result });
  };

  const save = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    const deferred: string[] = [];
    try {
      for (const key of current.envKeys) {
        const value = (values[key] ?? "").trim();
        // 값은 여기서 곧장 vault로 간다. 빈 칸은 저장하지 않고 "나중에"로 남긴다 —
        // 빈 문자열을 저장하면 "키가 있다"고 잘못 보고된다.
        if (!value) { deferred.push(key); continue; }
        await api.env.set(key, value);
      }
      advance(deferred);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StageShell chrome={chrome} labelledBy="plugin-key-title">
      <header className={styles.keyHeader}>
        <PluginLogo slug={current.slug} name={current.name} size={36} brandMap={brandMap} />
        <div>
          <h2 id="plugin-key-title" className={styles.title}>
            {ko ? `${current.name} 연결` : `Connect ${current.name}`}
          </h2>
          <p className={styles.keySub}>
            {ko
              ? "이 도구를 쓰려면 아래 값이 필요합니다. 지금 없으면 나중에 넣어도 됩니다."
              : "This tool needs the values below. If you don't have them now, you can add them later."}
          </p>
        </div>
      </header>

      <div className={styles.keyFields}>
        {current.envKeys.map((key) => (
          <label key={key} className={styles.keyField}>
            <span className={styles.keyLabel}>{key}</span>
            <input
              type="password"
              className={styles.keyInput}
              value={values[key] ?? ""}
              onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
              autoComplete="off"
              spellCheck={false}
              placeholder={ko ? "붙여넣기" : "Paste value"}
            />
          </label>
        ))}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <p className={styles.keyNote}>
        {ko
          ? "값은 이 컴퓨터의 키체인에만 저장되고 화면이나 기록에 남지 않습니다."
          : "Values are stored only in this computer's keychain — never shown or logged."}
      </p>

      <footer className={styles.footer}>
        <span className={styles.count}>
          {state.queue.length > 1
            ? ko ? `${state.index + 1} / ${state.queue.length}` : `${state.index + 1} of ${state.queue.length}`
            : ""}
        </span>
        <div className={styles.footerActions}>
          <button
            type="button"
            className={styles.ghost}
            disabled={busy}
            onClick={() => advance(current.envKeys)}
          >
            {ko ? "다음에 입력하기" : "Add later"}
          </button>
          <button type="button" className={styles.primary} onClick={() => void save()} disabled={busy}>
            {busy ? (ko ? "저장 중…" : "Saving…") : ko ? "저장하고 계속" : "Save and continue"}
          </button>
        </div>
      </footer>
    </StageShell>
  );
}

/** 후속 단계의 껍데기 하나 — 모달이거나, 이미 열려 있는 화면 안이거나. */
function StageShell({
  chrome,
  labelledBy,
  children,
}: {
  chrome: "modal" | "inline";
  labelledBy: string;
  children: React.ReactNode;
}) {
  if (chrome === "inline") {
    return <div className={styles.inlineStage}>{children}</div>;
  }
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className={styles.keyPanel}>{children}</div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function isPluginListing(listing: MarketplaceListing): boolean {
  return listing.entityKind === "plugin" || listing.source === "hub-plugin";
}

/**
 * 설치 뒤에 사용자가 무엇을 더 해야 하는가. 셋은 완전히 다른 일이라 화면도 갈려야 한다.
 *
 *  · "ready"  — 아무것도 없다. 고르면 그 자리에서 끝.
 *  · "login"  — 그 서비스에 로그인해 권한을 준다. 우리가 대신 줄여 줄 수 있는 유일한 갈래다.
 *  · "key"    — 사용자가 다른 사이트에서 키를 받아 와야 한다. 우리가 할 수 있는 건
 *               발급 페이지를 열어 주는 것까지 — 그래서 "나중에"가 1급 선택지다.
 *  · "unknown"— 허브가 종류를 알려주지 않았다(구버전 응답). 단정하지 않는다.
 */
export type PluginSetupKind = "ready" | "login" | "key" | "unknown";

/**
 * 설치가 끝난 뒤 **무엇을 더 물어야 하는가** — 허브가 선언한 auth 가 아니라 실제로 깔린
 * 행(rows)이 정한다.
 *
 * 두 근거가 갈린다는 것을 실측했다(2026-08-20, 라이브 허브 324항목 중):
 *   notion          auth=oauth  → 행은 stdio, envKeys 0개
 *   huggingface-mcp auth=token  → 행은 http,  envKeys 0개
 * 예전 코드는 auth 만 보고 notion 을 로그인 갈래로 보냈고, 메인은 stdio 서버에 인가할
 * URL 이 없다며 거절했다("this server has no remote URL to authorize"). 필요한 토큰은
 * 묻지도 않았다. 인가는 **원격 행이 있을 때만** 가능한 일이다.
 */
export function nextSetupStepFor(input: {
  listing: MarketplaceListing;
  rows: Array<{ transport: string; envKeys?: string[] }>;
}): "login" | "keys" | "none" {
  const { listing, rows } = input;
  const authorizable = rows.some((row) => row.transport === "http" || row.transport === "sse");
  if (authorizable && setupKindFor(listing) === "login") return "login";
  const envKeys = new Set(rows.flatMap((row) => row.envKeys ?? []));
  return envKeys.size > 0 ? "keys" : "none";
}

export function setupKindFor(listing: MarketplaceListing): PluginSetupKind {
  const auth: PluginAuthKind | undefined = listing.authKind;
  if (auth === "none") return "ready";
  if (auth === "oauth") return "login";
  if (auth === "api_key" || auth === "token") return "key";
  return "unknown";
}

/**
 * 이 플러그인이 붙는 서비스의 도메인. 브라우저 자격증명에 그 사이트 로그인이 이미
 * 있는지 맞춰 보는 데 쓴다. 허브가 준 homepage 를 근거로 하고, 없으면 아무 도메인도
 * 지어내지 않는다 — 슬러그로 도메인을 추측하면(slack → slack.com 은 맞지만
 * atlassian → ? 는 틀린다) 틀린 "이미 로그인됨"을 보여주게 된다.
 */
export function serviceDomainOf(listing: MarketplaceListing): string | null {
  const raw = listing.homepage;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** 등록 가능 도메인 수준에서 같은 서비스인가 (docs.gitlab.com ↔ gitlab.com). */
export function domainMatches(serviceDomain: string, linkedDomain: string): boolean {
  const a = serviceDomain.toLowerCase();
  const b = linkedDomain.toLowerCase().replace(/^www\./, "");
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function countByKind(listings: MarketplaceListing[]): { mcp: number; skill: number } {
  let mcp = 0;
  let skill = 0;
  for (const listing of listings) {
    if ((listing.pluginKind ?? "mcp") === "skill") skill += 1;
    else mcp += 1;
  }
  return { mcp, skill };
}

const CATEGORY_LABELS_KO: Record<string, string> = {
  analytics: "분석", business: "비즈니스", creative: "크리에이티브", design: "디자인",
  developer: "개발", productivity: "생산성", security: "보안", communication: "커뮤니케이션",
  crm: "CRM", finance: "금융", database: "데이터베이스", cloud: "클라우드",
  automation: "자동화", email: "메일·캘린더", marketing: "마케팅", search: "검색",
  ecommerce: "커머스", ai: "AI", media: "미디어", support: "고객지원", maps: "지도",
  reference: "레퍼런스",
};

export function groupByCategory(listings: MarketplaceListing[], ko: boolean): Array<[string, MarketplaceListing[]]> {
  const groups = new Map<string, MarketplaceListing[]>();
  for (const listing of listings) {
    const raw = (listing.category ?? "").trim() || "other";
    const label = ko ? CATEGORY_LABELS_KO[raw] ?? raw : raw.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
    const bucket = groups.get(label);
    if (bucket) bucket.push(listing);
    else groups.set(label, [listing]);
  }
  // 항목이 많은 갈래부터. 한 줄짜리 갈래가 위에 깔리면 스크롤만 길어진다.
  return [...groups.entries()].sort((left, right) => right[1].length - left[1].length);
}

/**
 * 이 항목을 고르면 그다음에 무슨 일이 생기는가 — 한 줄로.
 *
 * 고르기 전에 말해 주는 이유: 예전에는 전부 똑같이 "추가"였고, 누른 뒤에야 어떤 것은
 * 바로 끝나고 어떤 것은 API 키를 물었다. 그 차이를 미리 알면 사용자는 지금 할 수 있는
 * 것과 나중에 할 것을 스스로 나눠 고른다.
 *
 * 문자열만 돌려준다 — 팝업과 온보딩이 서로 다른 자리에 서로 다른 크기로 그린다.
 */
export function setupHintFor(input: {
  listing: MarketplaceListing;
  ko: boolean;
  hasLogin: boolean;
}): { tone: "ready" | "login" | "key"; text: string } | null {
  const { listing, ko, hasLogin } = input;
  const kind = setupKindFor(listing);
  if (kind === "unknown") return null;
  if (kind === "ready") {
    return { tone: "ready", text: ko ? "바로 사용" : "Ready to use" };
  }
  if (kind === "login") {
    return hasLogin
      ? { tone: "ready", text: ko ? "로그인 있음 · 동의만 하면 됩니다" : "Already signed in · just approve" }
      : { tone: "login", text: ko ? "로그인 필요" : "Sign-in required" };
  }
  if (listing.connectSetupRequired) {
    return { tone: "key", text: ko ? "제공사 안내에 따라 직접 연결" : "Connect via the provider's guide" };
  }
  // "필요"가 아니라 "필요할 수 있음"이다. 이 문구의 근거는 허브가 선언한 auth 인데, 실제로
  // 깔리는 매니페스트와 어긋난다(2026-08-20 실측: Hugging Face 는 auth="token" 인데 행은
  // http + envKeys 0개였고, 키 없이 도구 4개를 내줬다). 실제로 물을지는 설치 뒤에 정해지고,
  // 안 물어도 되면 안 묻는다 — 그러니 여기서 단정하지 않는다.
  return { tone: "key", text: ko ? "API 키가 필요할 수 있어요" : "May need an API key" };
}
