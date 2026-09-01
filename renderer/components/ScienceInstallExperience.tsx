"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconClose } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import { OPEN_SCIENCE_INSTALL_EVENT } from "@/lib/science-install-entry";
import type {
  ScienceSuiteInstallProgress,
  ScienceSuiteStatus,
} from "@shared/product-extension";
import styles from "./ScienceInstallExperience.module.css";

const PROMO_DISMISSED_KEY = "agentlas.science-promo.dismissed.v1";

type Surface = "closed" | "promo" | "plan" | "installing" | "error";

const FALLBACK_COMPONENTS = [
  {
    id: "agentlas-science",
    displayName: "Science Workspace",
    description: "Projects, literature, evidence graphs, statistics, and research writing",
    packageBytes: 11_000_000,
  },
  {
    id: "agentlas-science-renderer-ketcher",
    displayName: "Chemistry Tools",
    description: "Ketcher structure editor and Indigo chemistry runtime",
    packageBytes: 46_697_538,
  },
  {
    id: "agentlas-science-renderer-molstar",
    displayName: "Molecular Visualization",
    description: "Mol* protein and molecular structure viewer",
    packageBytes: 5_144_268,
  },
] as const;

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function componentCopy(id: string, ko: boolean, fallbackName: string, fallbackDescription: string) {
  if (!ko) return { name: fallbackName, description: fallbackDescription };
  if (id === "agentlas-science") return { name: "Science 작업 공간", description: "프로젝트, 문헌, 근거 그래프, 통계 분석, 연구 문서" };
  if (id === "agentlas-science-renderer-ketcher") return { name: "화학 구조 도구", description: "Ketcher 구조 편집기와 Indigo 화학 런타임" };
  if (id === "agentlas-science-renderer-molstar") return { name: "분자 시각화", description: "Mol* 단백질·분자 구조 뷰어" };
  return { name: fallbackName, description: fallbackDescription };
}

function initialProgress(totalBytes: number): ScienceSuiteInstallProgress {
  return {
    id: "agentlas-science-suite",
    phase: "checking",
    componentId: null,
    componentIndex: 0,
    componentCount: 3,
    completedBytes: 0,
    totalBytes,
    percent: 0,
    message: "Checking the signed Science package",
  };
}

export function ScienceInstallExperience({
  eligible,
  locale,
  onVisibilityChange,
}: {
  eligible: boolean;
  locale: "ko" | "en";
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const router = useRouter();
  const ko = locale === "ko";
  const [surface, setSurface] = useState<Surface>("closed");
  const [suite, setSuite] = useState<ScienceSuiteStatus | null>(null);
  const [progress, setProgress] = useState<ScienceSuiteInstallProgress>(() => initialProgress(62_841_806));
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const autoOfferCheckedRef = useRef(false);
  const visible = surface !== "closed";

  const components = suite?.components ?? FALLBACK_COMPONENTS.map((component) => ({
    ...component,
    status: {
      id: component.id,
      phase: "not-installed" as const,
      installed: false,
      enabled: false,
      version: null,
      installedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  }));
  const totalBytes = suite?.totalPackageBytes ?? components.reduce((sum, component) => sum + component.packageBytes, 0);

  const loadStatus = useCallback(async () => {
    const api = ipc();
    if (!api?.productExtensions?.scienceSuiteStatus) return null;
    const next = await api.productExtensions.scienceSuiteStatus();
    setSuite(next);
    return next;
  }, []);

  const openFromEntry = useCallback(async () => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = await loadStatus().catch(() => suite);
    if (current?.installed && current.enabled) {
      router.push("/science");
      return;
    }
    setErrorCode(null);
    setSurface("promo");
  }, [loadStatus, router, suite]);

  useEffect(() => {
    void loadStatus();
    const off = ipcEvents()?.onProductExtensionChanged?.(() => {
      void loadStatus();
    });
    return () => off?.();
  }, [loadStatus]);

  useEffect(() => {
    window.addEventListener(OPEN_SCIENCE_INSTALL_EVENT, openFromEntry);
    return () => window.removeEventListener(OPEN_SCIENCE_INSTALL_EVENT, openFromEntry);
  }, [openFromEntry]);

  useEffect(() => {
    if (!eligible || suite === null || autoOfferCheckedRef.current) return;
    autoOfferCheckedRef.current = true;
    if (suite.installed && suite.enabled) return;
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(PROMO_DISMISSED_KEY) === "1";
    } catch {
      dismissed = false;
    }
    if (!dismissed) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSurface("promo");
    }
  }, [eligible, suite]);

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [onVisibilityChange, visible]);

  const close = useCallback((remember = false) => {
    if (surface === "installing") return;
    if (remember) {
      try {
        window.localStorage.setItem(PROMO_DISMISSED_KEY, "1");
      } catch {
        // The sidebar remains the durable entry when renderer storage is unavailable.
      }
    }
    setSurface("closed");
    window.setTimeout(() => restoreFocusRef.current?.focus(), 0);
  }, [surface]);

  useEffect(() => {
    if (!visible) return;
    primaryRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && surface !== "installing") {
        event.preventDefault();
        close(surface === "promo");
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, surface, visible]);

  const runInstall = useCallback(async () => {
    const api = ipc();
    if (!api?.productExtensions?.installScienceSuite) {
      setErrorCode("science-suite-installer-unavailable");
      setSurface("error");
      return;
    }
    setErrorCode(null);
    setProgress(initialProgress(totalBytes));
    setSurface("installing");
    const off = ipcEvents()?.onScienceSuiteProgress?.((next) => setProgress(next));
    try {
      const receipt = await api.productExtensions.installScienceSuite();
      if (!receipt.ok) {
        setErrorCode(receipt.code ?? "science-suite-install-failed");
        setSurface("error");
        return;
      }
      const next = await loadStatus();
      if (!next?.installed || !next.enabled) {
        setErrorCode("science-suite-health-check-failed");
        setSurface("error");
        return;
      }
      setProgress({
        ...initialProgress(next.totalPackageBytes),
        phase: "installed",
        componentIndex: components.length,
        completedBytes: next.totalPackageBytes,
        percent: 100,
        message: "Agentlas Science is ready",
      });
      window.setTimeout(() => {
        setSurface("closed");
        router.push("/science");
      }, 650);
    } catch {
      setErrorCode("science-suite-install-failed");
      setSurface("error");
    } finally {
      off?.();
    }
  }, [components.length, loadStatus, router, totalBytes]);

  const progressLabel = useMemo(() => {
    if (progress.phase === "installed") return ko ? "설치 완료" : "Installation complete";
    const component = components.find((item) => item.id === progress.componentId);
    if (component) {
      const copy = componentCopy(component.id, ko, component.displayName, component.description);
      return ko ? `${copy.name} 설치 중` : `Installing ${copy.name}`;
    }
    return ko ? "설치 패키지 확인 중" : "Checking installation package";
  }, [components, ko, progress.componentId, progress.phase]);

  if (!visible) return null;

  const errorText = errorCode === "science-suite-package-unavailable"
    ? (ko ? "Science 배포 패키지가 아직 Desktop에 연결되지 않았습니다." : "The Science release package is not connected to this Desktop build yet.")
    : errorCode === "science-suite-health-check-failed"
      ? (ko ? "설치 파일 검증을 통과하지 못했습니다. 다시 다운로드해 주세요." : "The installed files did not pass verification. Download them again.")
      : (ko ? "설치를 완료하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요." : "Installation could not be completed. Check your connection and try again.");

  return (
    <div
      className={`${styles.backdrop} titlebar-nodrag`}
      role="presentation"
      data-testid="science-install-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close(surface === "promo");
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        data-surface={surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby="science-install-title"
        aria-describedby="science-install-description"
      >
        {surface !== "installing" && (
          <button
            type="button"
            className={styles.close}
            aria-label={ko ? "닫기" : "Close"}
            onClick={() => close(surface === "promo")}
          >
            <IconClose size={16} />
          </button>
        )}

        {surface === "promo" && (
          <>
            <div className={styles.hero}>
              <img src="/brand/agentlas-science-hero.png" alt="" aria-hidden="true" />
              <div className={styles.heroBrand}>
                <img src="/brand/agentlas-mark.png" alt="" aria-hidden="true" />
                <span>Agentlas Science</span>
              </div>
            </div>
            <div className={styles.promoBody}>
              <span className={styles.kicker}>{ko ? "새 제품" : "NEW PRODUCT"}</span>
              <h2 id="science-install-title">
                {ko ? "연구에 필요한 도구를 한 번에 설치하세요." : "Install the complete research workspace."}
              </h2>
              <p id="science-install-description">
                {ko
                  ? "선행연구 조사, 가설과 근거 관리, 데이터 분석, 화학 구조 편집, 분자 시각화를 하나의 프로젝트에서 실행합니다."
                  : "Run literature review, hypothesis and evidence tracking, data analysis, chemistry editing, and molecular visualization in one project."}
              </p>
              <ul className={styles.promoPoints}>
                <li>{ko ? "논문과 데이터 출처를 프로젝트에 기록" : "Keep paper and data sources with the project"}</li>
                <li>{ko ? "주장과 근거의 연결 상태를 확인" : "Review how claims connect to evidence"}</li>
                <li>{ko ? "Ketcher와 Mol* 연구 도구 포함" : "Includes Ketcher and Mol* research tools"}</li>
              </ul>
              <div className={styles.actions}>
                <button ref={primaryRef} type="button" className={styles.primary} data-testid="science-promo-download" onClick={() => setSurface("plan")}>
                  {ko ? "Agentlas Science 다운로드" : "Download Agentlas Science"}
                </button>
                <button type="button" className={styles.secondary} onClick={() => close(true)}>
                  {ko ? "나중에" : "Not now"}
                </button>
              </div>
            </div>
          </>
        )}

        {surface === "plan" && (
          <div className={styles.installBody}>
            <BrandHeader />
            <div className={styles.heading}>
              <h2 id="science-install-title">{ko ? "Agentlas Science 다운로드" : "Download Agentlas Science"}</h2>
              <p id="science-install-description">
                {ko ? "필요한 연구 도구를 한 번에 설치합니다." : "All required research tools are installed together."}
              </p>
            </div>
            <div className={styles.packageList}>
              {components.map((component) => {
                const copy = componentCopy(component.id, ko, component.displayName, component.description);
                return (
                <div className={styles.packageRow} key={component.id}>
                  <span className={styles.packageMark}><img src="/brand/agentlas-mark.png" alt="" /></span>
                  <span className={styles.packageCopy}>
                    <strong>{copy.name}</strong>
                    <small>{copy.description}</small>
                  </span>
                  <span className={styles.packageSize}>{formatMegabytes(component.packageBytes)}</span>
                </div>
                );
              })}
            </div>
            <div className={styles.totalRow}>
              <span>{ko ? "예상 설치 용량" : "Estimated installed size"}</span>
              <strong>{ko ? `약 ${formatMegabytes(totalBytes)}` : `About ${formatMegabytes(totalBytes)}`}</strong>
            </div>
            <p className={styles.installNote}>
              {ko ? "서명과 파일 무결성을 확인한 뒤 설치합니다." : "Signatures and file integrity are verified before activation."}
            </p>
            <div className={styles.actions}>
              <button ref={primaryRef} type="button" className={styles.primary} data-testid="science-plan-download" onClick={() => void runInstall()}>
                {ko ? "다운로드" : "Download"}
              </button>
              <button type="button" className={styles.secondary} onClick={() => setSurface("promo")}>
                {ko ? "뒤로" : "Back"}
              </button>
            </div>
          </div>
        )}

        {surface === "installing" && (
          <div className={styles.installBody}>
            <BrandHeader />
            <div className={styles.heading}>
              <h2 id="science-install-title">{progress.phase === "installed" ? (ko ? "설치 완료" : "Installation complete") : (ko ? "Agentlas Science 설치 중" : "Installing Agentlas Science")}</h2>
              <p id="science-install-description">{progressLabel}</p>
            </div>
            <div className={styles.progressCard} data-complete={progress.phase === "installed" ? "true" : "false"}>
              <div className={styles.progressHead}>
                <span className={styles.progressIcon}>
                  {progress.phase === "installed" ? <IconCheck size={19} /> : <img src="/brand/agentlas-mark.png" alt="" />}
                </span>
                <span className={styles.progressTitle}>
                  <strong>Agentlas Science</strong>
                  <small>{progressLabel}</small>
                </span>
                <strong className={styles.percent}>{progress.percent}%</strong>
              </div>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label={progressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
              >
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <div className={styles.progressMeta}>
                <span>{formatMegabytes(progress.completedBytes)} / {formatMegabytes(progress.totalBytes)}</span>
                <span>{ko ? `${Math.min(progress.componentIndex + 1, progress.componentCount)} / ${progress.componentCount} 구성 요소` : `${Math.min(progress.componentIndex + 1, progress.componentCount)} of ${progress.componentCount} components`}</span>
              </div>
            </div>
          </div>
        )}

        {surface === "error" && (
          <div className={styles.installBody}>
            <BrandHeader />
            <div className={styles.heading}>
              <h2 id="science-install-title">{ko ? "설치를 완료하지 못했습니다" : "Installation did not finish"}</h2>
              <p id="science-install-description">{errorText}</p>
            </div>
            <div className={styles.errorCard}>
              <strong>{ko ? "확인 코드" : "Reference code"}</strong>
              <code>{errorCode ?? "science-suite-install-failed"}</code>
            </div>
            <div className={styles.actions}>
              <button ref={primaryRef} type="button" className={styles.primary} onClick={() => void runInstall()}>
                {ko ? "다시 시도" : "Try again"}
              </button>
              <button type="button" className={styles.secondary} onClick={() => close(false)}>
                {ko ? "닫기" : "Close"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BrandHeader() {
  return (
    <div className={styles.brandHeader} aria-hidden="true">
      <span><img src="/brand/agentlas-mark.png" alt="" /></span>
      <strong>Agentlas Science</strong>
    </div>
  );
}
