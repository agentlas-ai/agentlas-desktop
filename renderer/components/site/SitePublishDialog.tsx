"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  SiteAgentAppPublishBackendResult,
  SiteAgentAppPublishConsent,
  SiteAgentAppPublishProviderStatus,
  SiteLlmProvider,
  SiteProjectPublicMeta,
  SitePublishProvider,
  SitePublishProviderPage,
} from "@shared/site-studio";
import styles from "./SitePublishDialog.module.css";

type Props = {
  project: SiteProjectPublicMeta;
  locale: "ko" | "en";
  onClose: () => void;
  onPublished: (result: SiteAgentAppPublishBackendResult) => void | Promise<void>;
};

const PROVIDERS: Array<{ id: SitePublishProvider; label: string; captionKo: string; captionEn: string }> = [
  { id: "vercel", label: "Vercel", captionKo: "로컬 패키지 직접 배포", captionEn: "Direct local-package deploy" },
  { id: "railway", label: "Railway", captionKo: "서버 앱 직접 배포", captionEn: "Direct server-app deploy" },
  { id: "render", label: "Render", captionKo: "Git 저장소 연결 필요", captionEn: "Git repository required" },
];

const LLM_PROVIDERS: Array<{ id: SiteLlmProvider; label: string; keyLabel: string }> = [
  { id: "openai", label: "OpenAI", keyLabel: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", keyLabel: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini", keyLabel: "GEMINI_API_KEY" },
];

const EMPTY_CONSENT: SiteAgentAppPublishConsent = {
  providerAccountReady: false,
  providerTermsHandledByUser: false,
  planConfirmedByUser: false,
  deploymentApproved: false,
  llmKeyTransferApproved: false,
};

function providerNote(provider: SitePublishProvider, ko: boolean): string {
  if (provider === "vercel") {
    return ko
      ? "Hobby는 개인·비상업 용도 정책이 적용될 수 있습니다. 현재 계정과 사용 목적이 맞는지 Vercel에서 확인하세요."
      : "Hobby may be limited to personal, non-commercial use. Confirm that your account and use case qualify in Vercel.";
  }
  if (provider === "railway") {
    return ko
      ? "무료 사용은 제한된 크레딧입니다. 크레딧 소진 뒤 중단 또는 과금 여부는 Railway에서 직접 확인하세요."
      : "Free use is limited by credits. Confirm what happens after those credits are exhausted in Railway.";
  }
  return ko
    ? "무료 웹 서비스는 유휴 시 중지될 수 있습니다. Render는 로컬 폴더를 직접 받지 않아 동일한 생성 패키지가 들어 있는 Git 저장소가 필요합니다."
    : "Free web services may sleep when idle. Render cannot receive a local folder, so it requires a Git repository containing the same generated package.";
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateAppAccessPasscode(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function validAppAccessPasscode(value: string): boolean {
  return value.length >= 32 && value.length <= 256 && /^[\x21-\x7E]+$/.test(value);
}

export function SitePublishDialog({ project, locale, onClose, onPublished }: Props) {
  const ko = locale !== "en";
  const pendingVerificationReceipt = project.agentAppArtifact?.publish &&
    project.agentAppArtifact.publish.status === "verification-required" &&
    (project.agentAppArtifact.publish.provider === "vercel" || project.agentAppArtifact.publish.provider === "railway")
      ? project.agentAppArtifact.publish
      : null;
  const pendingRenderReceipt = project.agentAppArtifact?.publish?.provider === "render" &&
    project.agentAppArtifact.publish.status === "configuration-required"
      ? project.agentAppArtifact.publish
      : null;
  const [provider, setProvider] = useState<SitePublishProvider>(pendingVerificationReceipt?.provider || (pendingRenderReceipt ? "render" : "vercel"));
  const [llmProvider, setLlmProvider] = useState<SiteLlmProvider>(pendingVerificationReceipt?.llmProvider || pendingRenderReceipt?.llmProvider || "openai");
  const [statuses, setStatuses] = useState<SiteAgentAppPublishProviderStatus[]>([]);
  const [keyPresence, setKeyPresence] = useState<Record<SiteLlmProvider, boolean>>({
    openai: false,
    anthropic: false,
    google: false,
  });
  const [providerToken, setProviderToken] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [appAccessKey, setAppAccessKey] = useState("");
  const [renderRepositoryUrl, setRenderRepositoryUrl] = useState("");
  const [renderOwnerId, setRenderOwnerId] = useState("");
  const [renderBranch, setRenderBranch] = useState("main");
  const [renderRootDir, setRenderRootDir] = useState("");
  const [renderSourceConfirmed, setRenderSourceConfirmed] = useState(false);
  const [consent, setConsent] = useState<SiteAgentAppPublishConsent>(EMPTY_CONSENT);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"connect" | "provider-key" | "llm-key" | "publish" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<SiteAgentAppPublishBackendResult | null>(null);

  const refresh = useCallback(async () => {
    const bridge = ipc();
    if (!bridge?.site?.listPublishProviderStatuses) {
      throw new Error(ko ? "배포 브리지를 사용할 수 없습니다." : "The publishing bridge is unavailable.");
    }
    const [nextStatuses, openai, anthropic, google] = await Promise.all([
      bridge.site.listPublishProviderStatuses(),
      bridge.secrets.hasApiKey("openai"),
      bridge.secrets.hasApiKey("anthropic"),
      bridge.secrets.hasApiKey("google"),
    ]);
    setStatuses(nextStatuses);
    setKeyPresence({ openai, anthropic, google });
  }, [ko]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void refresh()
      .catch((error) => {
        if (alive) setNotice(shortError(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [refresh]);

  useEffect(() => {
    setProviderToken("");
    setLlmKey("");
    setProviderAccountId("");
    setAppAccessKey("");
    setRenderRepositoryUrl("");
    setRenderOwnerId("");
    setRenderBranch("main");
    setRenderRootDir("");
    setRenderSourceConfirmed(false);
    setConsent(EMPTY_CONSENT);
    setNotice(null);
    setResult(null);
  }, [provider]);

  useEffect(() => {
    setLlmKey("");
    setConsent((current) => ({ ...current, llmKeyTransferApproved: false }));
    setNotice(null);
    setResult(null);
  }, [llmProvider]);

  useEffect(() => {
    if (provider !== "render" || !pendingRenderReceipt) return;
    setLlmProvider(pendingRenderReceipt.llmProvider);
    setNotice(pendingRenderReceipt.reason || (ko
      ? "Render 서비스는 생성되었지만 LLM 키와 app access key 설정이 필요합니다. 새 서비스를 만들지 않고 기존 receipt를 사용합니다."
      : "The Render service exists but still needs its LLM key and app access key. Agentlas will reuse this receipt instead of creating another service."));
  }, [ko, pendingRenderReceipt, provider]);

  useEffect(() => {
    if (!pendingVerificationReceipt) return;
    setProvider(pendingVerificationReceipt.provider);
    setLlmProvider(pendingVerificationReceipt.llmProvider);
    setNotice(pendingVerificationReceipt.reason || (ko
      ? "기존 provider resource의 공개 페이지, /healthz, 인증된 무추론 /api/run contract를 다시 검증합니다. 새 배포나 secret 전송은 하지 않습니다."
      : "Recheck the existing provider resource's page, /healthz, and authenticated no-inference /api/run contract. This does not create a deployment or transfer secrets."));
  }, [ko, pendingVerificationReceipt]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, working]);

  const currentStatus = useMemo(
    () => statuses.find((status) => status.provider === provider) ?? null,
    [provider, statuses],
  );
  const currentKey = LLM_PROVIDERS.find((entry) => entry.id === llmProvider)!;
  const allConsent = Boolean(
    consent.providerAccountReady &&
    consent.providerTermsHandledByUser &&
    consent.planConfirmedByUser &&
    consent.deploymentApproved &&
    (provider === "render" || consent.llmKeyTransferApproved),
  );
  const renderReady = provider !== "render" || Boolean(pendingRenderReceipt) || Boolean(
    renderRepositoryUrl.trim() &&
    renderOwnerId.trim() &&
    renderSourceConfirmed,
  );
  const canPublish = Boolean(
    project.agentAppArtifact?.status === "ready" &&
    (pendingVerificationReceipt
      ? provider === pendingVerificationReceipt.provider && validAppAccessPasscode(appAccessKey)
      : Boolean(
          currentStatus?.ready &&
          (provider === "render" || keyPresence[llmProvider]) &&
          (provider === "render" || validAppAccessPasscode(appAccessKey)) &&
          allConsent &&
          renderReady &&
          !(provider === "render" && pendingRenderReceipt)
        )) &&
    !working,
  );

  const openProviderPage = async (page: SitePublishProviderPage) => {
    try {
      const bridge = ipc();
      if (!bridge?.site?.openPublishProviderPage) throw new Error(ko ? "브라우저 연결을 사용할 수 없습니다." : "Browser handoff is unavailable.");
      await bridge.site.openPublishProviderPage({ provider, page });
      setNotice(
        ko
          ? "브라우저에서 계정 생성·로그인·약관을 직접 완료한 뒤 여기로 돌아오세요."
          : "Complete account creation, login, and terms in the provider, then return here.",
      );
    } catch (error) {
      setNotice(shortError(error));
    }
  };

  const connectProvider = async () => {
    const bridge = ipc();
    if (!bridge?.site?.connectPublishProvider || working) return;
    setWorking("connect");
    setNotice(ko ? "Provider가 여는 브라우저에서 직접 로그인해 주세요." : "Complete login in the browser opened by the provider.");
    try {
      const next = await bridge.site.connectPublishProvider({ provider });
      setStatuses((current) => current.map((status) => status.provider === provider ? next.status : status));
      setNotice(next.ok
        ? (ko ? "계정 연결을 확인했습니다." : "Provider connection verified.")
        : next.userAction?.message || next.status.reason || (ko ? "연결을 확인하지 못했습니다." : "Could not verify the connection."));
    } catch (error) {
      setNotice(shortError(error));
    } finally {
      setWorking(null);
    }
  };

  const saveProviderToken = async () => {
    const bridge = ipc();
    if (!bridge?.site?.savePublishProviderToken || !providerToken.trim() || working) return;
    setWorking("provider-key");
    setNotice(null);
    try {
      const next = await bridge.site.savePublishProviderToken({ provider, token: providerToken });
      setProviderToken("");
      setStatuses((current) => current.map((status) => status.provider === provider ? next.status : status));
      setNotice(next.status.ready
        ? (ko ? "Provider 토큰을 Keychain에 저장하고 연결을 확인했습니다." : "Provider token saved to Keychain and verified.")
        : next.status.reason || (ko ? "토큰은 저장했지만 연결을 확인하지 못했습니다." : "Token saved, but the connection could not be verified."));
    } catch (error) {
      setNotice(shortError(error));
    } finally {
      setWorking(null);
    }
  };

  const removeProviderToken = async () => {
    const bridge = ipc();
    if (!bridge?.site?.removePublishProviderToken || working) return;
    setWorking("provider-key");
    try {
      const next = await bridge.site.removePublishProviderToken({ provider });
      setStatuses((current) => current.map((status) => status.provider === provider ? next.status : status));
      setNotice(ko ? "저장된 Provider 토큰을 삭제했습니다." : "Stored provider token removed.");
    } catch (error) {
      setNotice(shortError(error));
    } finally {
      setWorking(null);
    }
  };

  const saveLlmKey = async () => {
    const bridge = ipc();
    if (!bridge?.secrets || !llmKey.trim() || working) return;
    setWorking("llm-key");
    setNotice(null);
    try {
      await bridge.secrets.saveApiKey(llmProvider, llmKey);
      setLlmKey("");
      setKeyPresence((current) => ({ ...current, [llmProvider]: true }));
      setNotice(ko ? "LLM 키를 macOS Keychain에 저장했습니다." : "LLM key saved to macOS Keychain.");
    } catch (error) {
      setNotice(shortError(error));
    } finally {
      setWorking(null);
    }
  };

  const publish = async () => {
    const bridge = ipc();
    if (!bridge?.site?.publishAgentApp || !canPublish) return;
    setWorking("publish");
    setNotice(pendingVerificationReceipt
      ? (ko ? "기존 공개 페이지, /healthz, 인증된 무추론 /api/run contract를 검증 중입니다…" : "Checking the existing page, /healthz, and authenticated no-inference /api/run contract…")
      : provider === "render"
      ? (ko ? "LLM 키와 app access key를 전송하지 않고 Render 서비스를 생성 중입니다…" : "Creating the Render service without transferring either secret…")
      : (ko ? "패키지와 secret 경계를 검증한 뒤 공개 배포 중입니다…" : "Validating the package and secret boundary, then deploying…"));
    setResult(null);
    try {
      const next = await bridge.site.publishAgentApp({
        projectId: project.id,
        provider,
        llmProvider,
        consent,
        appAccessKey: provider === "render" ? undefined : appAccessKey,
        providerAccountId: providerAccountId.trim() || undefined,
        renderRepositoryUrl: provider === "render" ? renderRepositoryUrl.trim() : undefined,
        renderOwnerId: provider === "render" ? renderOwnerId.trim() : undefined,
        renderBranch: provider === "render" ? renderBranch.trim() || "main" : undefined,
        renderRootDir: provider === "render" ? renderRootDir.trim() || undefined : undefined,
        renderRepositoryContainsValidatedPackage: provider === "render" ? renderSourceConfirmed : undefined,
      });
      setResult(next);
      setNotice(next.ok
        ? (ko ? "공개 배포가 완료되었습니다." : "Public deployment completed.")
        : next.userAction?.message || next.reason || (ko ? "배포를 완료하지 못했습니다." : "Deployment did not complete."));
      const durableRenderReceiptCreated = Boolean(
        next.provider === "render" &&
        next.status === "needs-user-action" &&
        next.userAction?.code === "render-llm-key-required" &&
        next.url &&
        next.providerProjectId,
      );
      const durableVerificationReceiptCreated = Boolean(
        (next.provider === "vercel" || next.provider === "railway") &&
        next.status === "needs-user-action" &&
        next.userAction?.code === "deployment-verification-required" &&
        next.url &&
        next.providerProjectId,
      );
      const durableProviderMutationReceipt = Boolean(!next.ok && (next.providerProjectId || next.url));
      // Refresh the parent for both a completed deployment and a durable
      // provider receipt. Pending configuration or HTTPS verification must
      // never be surfaced through published/live copy.
      if (next.ok || durableRenderReceiptCreated || durableVerificationReceiptCreated || durableProviderMutationReceipt) await onPublished(next);
    } catch (error) {
      setNotice(shortError(error));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !working) onClose();
    }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="site-publish-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>PUBLIC AGENT APP</span>
            <h2 id="site-publish-title">{project.agentAppTarget?.name || project.name}</h2>
            <p>{pendingVerificationReceipt
              ? (ko ? "기존 원격 resource를 다시 검증합니다. 새 배포나 secret 전송은 수행하지 않습니다." : "Reverify the existing remote resource without creating a deployment or transferring secrets.")
              : provider === "render" && pendingRenderReceipt
              ? (ko ? "기존 Render 서비스가 LLM 키와 app access key의 수동 설정을 기다리고 있습니다. 아직 게시 완료 상태가 아닙니다." : "The existing Render service is awaiting manual LLM-key and app-access-key configuration. It is not published yet.")
              : provider === "render"
              ? (ko ? "Render 서비스만 생성하며 LLM 키와 app access key는 Render 화면에서 직접 추가합니다." : "Agentlas creates the Render service; you add both secrets directly in Render.")
              : (ko ? "호스팅 계정, 서버 전용 LLM 키, 방문자용 app passcode를 연결해 Astryx 앱을 공개합니다." : "Connect hosting, a server-only LLM key, and a visitor app passcode to publish this Astryx app.")}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} disabled={Boolean(working)} aria-label={ko ? "닫기" : "Close"}>×</button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <span>01</span>
              <div><h3>{ko ? "호스팅 선택" : "Choose hosting"}</h3><p>{ko ? "계정 생성과 약관 동의는 Provider 화면에서 직접 진행합니다." : "Account creation and terms stay on the provider surface."}</p></div>
            </div>
            <div className={styles.providerGrid} role="tablist" aria-label={ko ? "호스팅 Provider" : "Hosting provider"}>
              {PROVIDERS.map((entry) => {
                const status = statuses.find((item) => item.provider === entry.id);
                return (
                  <button
                    type="button"
                    key={entry.id}
                    role="tab"
                    aria-selected={provider === entry.id}
                    className={styles.providerCard}
                    data-selected={provider === entry.id ? "true" : "false"}
                    disabled={Boolean(pendingVerificationReceipt && entry.id !== pendingVerificationReceipt.provider)}
                    onClick={() => setProvider(entry.id)}
                  >
                    <span className={styles.providerTop}><b>{entry.label}</b><i data-ready={status?.ready ? "true" : "false"}>{status?.ready ? (ko ? "연결됨" : "Ready") : (ko ? "미연결" : "Not ready")}</i></span>
                    <small>{ko ? entry.captionKo : entry.captionEn}</small>
                  </button>
                );
              })}
            </div>

            <div className={styles.connectionPanel}>
              <div className={styles.connectionCopy}>
                <strong>{currentStatus?.ready ? (ko ? "계정 연결 확인됨" : "Account verified") : (ko ? "계정 연결 필요" : "Account connection required")}</strong>
                <span>{loading ? (ko ? "확인 중…" : "Checking…") : currentStatus?.accountLabel || currentStatus?.reason || providerNote(provider, ko)}</span>
                {currentStatus?.cliVersion && <small>CLI {currentStatus.cliVersion}</small>}
              </div>
              <div className={styles.inlineActions}>
                <button type="button" onClick={() => void openProviderPage("signup")}>{ko ? "가입 / 로그인" : "Sign up / login"}</button>
                <button type="button" onClick={() => void openProviderPage("token")}>{ko ? "토큰 만들기" : "Create token"}</button>
                {provider !== "render" && (
                  <button type="button" className={styles.darkButton} disabled={Boolean(working)} onClick={() => void connectProvider()}>{working === "connect" ? (ko ? "연결 중…" : "Connecting…") : (ko ? "브라우저 연결" : "Connect browser")}</button>
                )}
              </div>
              <div className={styles.secretRow}>
                <input
                  type="password"
                  autoComplete="off"
                  value={providerToken}
                  onChange={(event) => setProviderToken(event.target.value)}
                  placeholder={provider === "render"
                    ? "Render API key"
                    : (ko ? `${PROVIDERS.find((entry) => entry.id === provider)?.label} access token` : `${provider} access token`)}
                  aria-label={ko ? "Provider access token" : "Provider access token"}
                />
                <button type="button" disabled={!providerToken.trim() || Boolean(working)} onClick={() => void saveProviderToken()}>{ko ? "Keychain에 저장" : "Save to Keychain"}</button>
                {currentStatus?.tokenStored && <button type="button" className={styles.textButton} disabled={Boolean(working)} onClick={() => void removeProviderToken()}>{ko ? "삭제" : "Remove"}</button>}
              </div>
              <p className={styles.providerWarning}>{currentStatus?.freePlanNote || providerNote(provider, ko)}</p>
            </div>

            {(provider === "vercel" || provider === "railway") && (
              <label className={styles.optionalField}>
                <span>{ko ? "팀 / Workspace ID (선택)" : "Team / workspace ID (optional)"}</span>
                <input value={providerAccountId} onChange={(event) => setProviderAccountId(event.target.value)} placeholder={ko ? "개인 계정이면 비워 두세요" : "Leave blank for a personal account"} />
              </label>
            )}

            {provider === "render" && (
              <div className={styles.renderFields}>
                {pendingRenderReceipt ? (
                  <div className={styles.renderNotice}>
                    {ko ? "새 Render 서비스를 만들지 않습니다." : "Agentlas will not create another Render service."}
                    {` ${ko ? "기존 Service ID" : "Existing service ID"}: ${pendingRenderReceipt.providerProjectId}. `}
                    {ko ? "LLM 키와 AGENTLAS_APP_ACCESS_KEY를 Render Environment에 직접 추가하세요." : "Add the LLM key and AGENTLAS_APP_ACCESS_KEY directly to Render Environment."}
                  </div>
                ) : (
                  <>
                    <div className={styles.renderNotice}>{ko ? "Render는 로컬 생성물을 직접 업로드할 수 없습니다. 아래 저장소에 이 앱의 검증된 astryx-app 패키지가 실제로 있어야 합니다." : "Render cannot upload the local artifact directly. This app's validated astryx-app package must already exist in the repository below."}</div>
                    <label><span>{ko ? "Git 저장소 URL" : "Git repository URL"}</span><input value={renderRepositoryUrl} onChange={(event) => setRenderRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" /></label>
                    <label><span>{ko ? "Render Owner ID" : "Render owner ID"}</span><input value={renderOwnerId} onChange={(event) => setRenderOwnerId(event.target.value)} /></label>
                    <div className={styles.fieldPair}>
                      <label><span>{ko ? "브랜치" : "Branch"}</span><input value={renderBranch} onChange={(event) => setRenderBranch(event.target.value)} /></label>
                      <label><span>{ko ? "Root directory (선택)" : "Root directory (optional)"}</span><input value={renderRootDir} onChange={(event) => setRenderRootDir(event.target.value)} placeholder="astryx-app" /></label>
                    </div>
                    <label className={styles.checkRow}><input type="checkbox" checked={renderSourceConfirmed} onChange={(event) => setRenderSourceConfirmed(event.target.checked)} /><span>{ko ? "이 저장소 경로에 현재 검증된 Agent App 패키지가 들어 있음을 확인했습니다. 실제 service 생성 전 native 창에서 repository·owner·service·API key fingerprint를 다시 승인합니다." : "I confirm that this repository path contains the currently validated Agent App package. Before service creation, a native dialog will require approval of the repository, owner, service, and API-key fingerprint."}</span></label>
                  </>
                )}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <span>02</span>
              <div><h3>{ko ? "LLM 연결" : "Connect the LLM"}</h3><p>{provider === "render"
                ? (ko ? "모델 provider만 선택합니다. Agentlas는 Render 배포에서 저장된 LLM 키나 app access key를 읽거나 전송하지 않습니다." : "Choose the model provider only. Agentlas never reads or transfers an LLM key or app access key to Render.")
                : (ko ? "키는 브라우저 번들에 들어가지 않고 서버 secret으로만 배포됩니다." : "The key stays out of the browser bundle and is deployed only as a server secret.")}</p></div>
            </div>
            <div className={styles.llmTabs} role="tablist" aria-label={ko ? "LLM Provider" : "LLM provider"}>
              {LLM_PROVIDERS.map((entry) => (
                <button type="button" key={entry.id} role="tab" aria-selected={llmProvider === entry.id} data-selected={llmProvider === entry.id ? "true" : "false"} disabled={Boolean(pendingVerificationReceipt)} onClick={() => setLlmProvider(entry.id)}>
                  <span>{entry.label}</span><i data-ready={(provider === "render" ? llmProvider === entry.id : keyPresence[entry.id]) ? "true" : "false"}>{(provider === "render" ? llmProvider === entry.id : keyPresence[entry.id]) ? "✓" : ""}</i>
                </button>
              ))}
            </div>
            {provider === "render" ? (
              <div className={styles.renderNotice}>{ko
                ? `서비스 생성 후 Render dashboard의 Environment에 ${currentKey.keyLabel}와 AGENTLAS_APP_ACCESS_KEY를 직접 추가해야 앱이 작동합니다. AGENTLAS_APP_ACCESS_KEY는 LLM 키와 다른 방문자용 passcode이며 32~256자의 공백 없는 printable ASCII여야 합니다. Agentlas는 Render 흐름에서 두 secret을 읽거나 전송하지 않습니다.`
                : `After service creation, add both ${currentKey.keyLabel} and AGENTLAS_APP_ACCESS_KEY directly under Environment in the Render dashboard. AGENTLAS_APP_ACCESS_KEY is a separate visitor passcode, never the LLM key, and must be 32–256 printable non-space ASCII characters. Agentlas does not read or transfer either secret in the Render flow.`}</div>
            ) : (
              <>
                <div className={styles.secretRow}>
                  <input type="password" autoComplete="off" value={llmKey} onChange={(event) => setLlmKey(event.target.value)} placeholder={currentKey.keyLabel} aria-label={currentKey.keyLabel} />
                  <button type="button" disabled={!llmKey.trim() || Boolean(working)} onClick={() => void saveLlmKey()}>{keyPresence[llmProvider] ? (ko ? "키 교체" : "Replace key") : (ko ? "Keychain에 저장" : "Save to Keychain")}</button>
                </div>
                <div className={styles.renderNotice}>{ko
                  ? "공개 앱 방문자에게 공유할 별도 access passcode입니다. LLM API 키를 공유하지 마세요. 배포 전에는 현재 창 메모리에만 있고 Site 메타데이터에는 저장되지 않으며, native 승인 뒤 provider의 서버 secret으로 한 번 전송됩니다."
                  : "This separate app access passcode is what you share with visitors. Never share your LLM API key. Before publish it stays only in this dialog's memory and is never persisted in Site metadata; after native approval it is transferred once into provider server-secret storage."}</div>
                <div className={styles.secretRow}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={appAccessKey}
                    onChange={(event) => setAppAccessKey(event.target.value)}
                    placeholder="AGENTLAS_APP_ACCESS_KEY"
                    aria-label="AGENTLAS_APP_ACCESS_KEY"
                  />
                  <button type="button" disabled={Boolean(working)} onClick={() => {
                    try {
                      setAppAccessKey(generateAppAccessPasscode());
                      setNotice(ko ? "고엔트로피 app passcode를 생성했습니다. 배포 전에 복사해 안전하게 공유하세요." : "Generated a high-entropy app passcode. Copy it before publishing and share it securely.");
                    } catch (error) {
                      setNotice(shortError(error));
                    }
                  }}>{ko ? "안전하게 생성" : "Generate securely"}</button>
                  <button type="button" disabled={!validAppAccessPasscode(appAccessKey) || Boolean(working)} onClick={() => {
                    if (!navigator.clipboard) {
                      setNotice(ko ? "클립보드를 사용할 수 없습니다." : "Clipboard access is unavailable.");
                      return;
                    }
                    void navigator.clipboard.writeText(appAccessKey)
                      .then(() => setNotice(ko ? "App passcode를 클립보드에 복사했습니다. LLM 키가 아니라 이 값만 방문자에게 공유하세요." : "Copied the app passcode. Share this value with visitors, never the LLM key."))
                      .catch((error) => setNotice(shortError(error)));
                  }}>{ko ? "Passcode 복사" : "Copy passcode"}</button>
                </div>
              </>
            )}
            <p className={styles.securityNote}>{provider === "render"
              ? (ko ? "Render 서비스에는 provider 선택값과 warm-instance 기준 일일 100회 best-effort 가드만 자동 설정됩니다. 콜드 스타트·수평 확장 시 카운터가 나뉘거나 초기화되므로 분산 과금 한도가 아닙니다. 공개 앱 호출에는 호스팅 비용과 별도로 LLM 사용료가 발생할 수 있습니다." : "Agentlas sets only the provider selector and a best-effort 100-run daily guard per warm Render instance. Cold starts and horizontal scaling split or reset it, so it is not a distributed billing cap. Public app calls may incur LLM charges separately from hosting.")
              : (ko ? "키 값은 저장 후 UI가 다시 읽지 않습니다. 공개 앱 호출에는 호스팅 비용과 별도로 선택한 LLM 사용료가 발생할 수 있습니다. 기본 일일 100회 가드는 warm instance별 best-effort 안전장치이며 콜드 스타트·수평 확장을 아우르는 분산 과금 한도가 아닙니다." : "The UI cannot read the key back after saving it. Public app calls may incur LLM charges separately from hosting. The default 100-run daily guard is a best-effort per-warm-instance safeguard, not a distributed billing cap across cold starts or horizontal scaling.")}</p>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <span>03</span>
              <div><h3>{ko ? "공개 범위 확인" : "Confirm public scope"}</h3><p>{ko ? "자동 가입·약관 동의·요금제 변경은 수행하지 않습니다." : "Agentlas will not create accounts, accept terms, or change plans for you."}</p></div>
            </div>
            {pendingVerificationReceipt ? (
              <div className={styles.renderNotice}>{ko
                ? `Provider resource ID ${pendingVerificationReceipt.providerProjectId ?? "확인 불가"}의 공개 페이지와 /healthz를 확인하고, 위 passcode로 /api/run에 고의로 잘못된 빈 body를 보내 400 invalid-input 계약만 검사합니다. 이 요청은 모델 호출 전에 종료되며 새 resource나 secret 전송은 없습니다.`
                : `Agentlas checks the public page and /healthz of provider resource ${pendingVerificationReceipt.providerProjectId ?? "unavailable"}, then sends a deliberately invalid empty body to /api/run with the passcode above and requires the 400 invalid-input contract. It stops before model inference and creates no resource or secret transfer.`}</div>
            ) : <div className={styles.consentList}>
              {([
                ["providerAccountReady", ko ? "내가 Provider 계정 생성과 로그인을 완료했습니다." : "I created and signed in to the provider account."],
                ["providerTermsHandledByUser", ko ? "Provider 화면에서 필요한 약관과 동의를 직접 확인했습니다." : "I reviewed required terms and consent on the provider surface."],
                ["planConfirmedByUser", ko ? "무료 범위, 크레딧, 중지·과금 조건을 확인했습니다." : "I reviewed free limits, credits, sleeping, and billing conditions."],
                ["deploymentApproved", provider === "render"
                  ? (ko ? "두 secret이 없어 API가 fail-closed인 공개 Render service 생성 intent를 제출합니다. 이 체크는 최종 승인이 아니며 native 창에서 account·repository·service·API key fingerprint를 다시 확인합니다." : "I submit the intent to create a public Render service whose API fails closed without both secrets. This checkbox is not final approval; the native dialog will confirm the account, repository, service, and API-key fingerprint.")
                  : (ko ? "공개 버전은 로컬 메모리·파일·도구를 싣지 않은 설명+I/O 기반 BYOK 런타임이며, 공개 URL의 추론 API는 위 app passcode로 보호됨을 확인했습니다." : "I confirm this public BYOK runtime is based on the target description and I/O without local memory, files, or tools, and its public inference API is protected by the app passcode above.")],
                ...(provider === "render" ? [] : [["llmKeyTransferApproved", ko
                  ? `Keychain의 ${currentKey.keyLabel} 값과 위 app passcode를 provider의 서버 secret storage로 전송할 의사를 확인했습니다. 이 체크는 최종 승인이 아니며, Electron native 창에서 artifact·계정·fingerprint를 다시 확인해야 합니다.`
                  : `I acknowledge transfer of ${currentKey.keyLabel} from Keychain and the app passcode above into provider server secrets. This checkbox is not final authorization; I must confirm the artifact, account, and fingerprints again in the native Electron dialog.`]]),
              ] as Array<[keyof SiteAgentAppPublishConsent, string]>).map(([key, label]) => (
                <label className={styles.checkRow} key={key}>
                  <input type="checkbox" checked={consent[key]} onChange={(event) => setConsent((current) => ({ ...current, [key]: event.target.checked }))} />
                  <span>{label}</span>
                </label>
              ))}
            </div>}
          </section>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerStatus} data-success={result?.ok ? "true" : "false"}>
            {notice || (ko ? "연결과 동의를 모두 확인하면 배포할 수 있습니다." : "Connect accounts and confirm every consent to deploy.")}
            {result?.userAction?.url && (
              <button type="button" onClick={() => void ipc()?.fs.openPath(result.userAction!.url!)}>{ko ? "Provider 설정 열기 ↗" : "Open provider settings ↗"}</button>
            )}
            {!result?.userAction?.url && pendingRenderReceipt && (
              <button type="button" onClick={() => void ipc()?.fs.openPath("https://dashboard.render.com/")}>{ko ? "Render 설정 열기 ↗" : "Open Render settings ↗"}</button>
            )}
            {(result?.url || (provider === "render" ? pendingRenderReceipt?.url : null)) && (
              <button type="button" onClick={() => void ipc()?.fs.openPath((result?.url || pendingRenderReceipt?.url)!)}>{(!result || !result.ok) ? (ko ? "생성된 resource URL ↗" : "Created resource URL ↗") : (ko ? "공개 앱 열기 ↗" : "Open public app ↗")}</button>
            )}
          </div>
          <div className={styles.footerActions}>
            <button type="button" className={styles.cancelButton} onClick={onClose} disabled={Boolean(working)}>{ko ? "취소" : "Cancel"}</button>
            <button type="button" className={styles.publishButton} disabled={!canPublish} onClick={() => void publish()}>{pendingVerificationReceipt
              ? (working === "publish" ? (ko ? "검증 중…" : "Verifying…") : (ko ? "기존 배포 다시 검증" : "Reverify deployment"))
              : pendingRenderReceipt && provider === "render"
              ? (ko ? "Render 키 설정 필요" : "Render key required")
              : working === "publish" ? (ko ? "배포 중…" : "Deploying…") : `${PROVIDERS.find((entry) => entry.id === provider)?.label}${ko ? "에 게시" : " publish"}`}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
