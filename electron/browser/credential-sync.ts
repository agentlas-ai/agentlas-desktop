import { developmentEffectsSuppressed, assertDevelopmentEffectAllowed } from "../development-effect-policy";
// 브라우저 자격증명을 **사용자가 한 번 승인하면 그 뒤로는 스스로** 최신으로 유지한다.
//
// 왜: 가져오기 버튼만 있으면 결국 사람이 눌러야 하고, 쿠키는 만료된다. 그러면 며칠 뒤 실행이
// 또 로그아웃 창을 잡고, 사용자는 "왜 또 로그인하래"를 겪는다. 승인은 한 번, 갱신은 제품이 한다.
//
// 경계:
//  - 자동 갱신은 **승인 당시 고른 도메인 집합만** 다시 가져온다. 범위는 저절로 넓어지지 않는다.
//  - 승인이 없으면 아무것도 복사하지 않는다. 조용한 수집은 하지 않는다.
//  - 더 최신인 원본과 전용 런타임이 읽지 못하는 암호문만 교체해, 에이전트가 만든 최신 세션은 보존한다.
import {
  BROWSER_CREDENTIAL_CONSENT_KEY,
  type BrowserCredentialConsent,
} from "../../shared/browser-credentials";
import { getMeta, setMeta } from "../store/meta";
import { importBrowserCredentials, listDiscoverableProfiles, scanBrowserCredentials } from "./credential-import";
import { registrableDomain } from "../../shared/registrable-domain";

/** 자동 갱신 주기. 쿠키 만료보다 짧게, 그러나 매 실행마다 파일을 뒤지지 않을 만큼 길게. */
const REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;

const EMPTY_CONSENT: BrowserCredentialConsent = {
  granted: false,
  grantedAt: null,
  domains: [],
  lastSyncedAt: null,
  profileId: null,
};

export function getBrowserCredentialConsent(): BrowserCredentialConsent {
  const raw = getMeta(BROWSER_CREDENTIAL_CONSENT_KEY);
  if (!raw) return { ...EMPTY_CONSENT };
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserCredentialConsent>;
    const canonicalDate = (value: unknown): value is string => typeof value === "string"
      && Number.isFinite(Date.parse(value))
      && new Date(value).toISOString() === value;
    const canonicalProfile = typeof parsed.profileId === "string"
      && /^(Google Chrome|Microsoft Edge|Brave|Chromium)::(Default|Profile [0-9]+)$/u.test(parsed.profileId);
    const canonicalDomains = Array.isArray(parsed.domains)
      && parsed.domains.length > 0
      && parsed.domains.length <= 256
      && new Set(parsed.domains).size === parsed.domains.length
      && parsed.domains.every((domain) => typeof domain === "string"
        && domain.length <= 253
        && registrableDomain(domain) === domain);
    if (parsed.granted !== true
      || !canonicalDate(parsed.grantedAt)
      || (parsed.lastSyncedAt !== null && !canonicalDate(parsed.lastSyncedAt))
      || !canonicalProfile
      || !canonicalDomains) {
      return { ...EMPTY_CONSENT };
    }
    return {
      granted: true,
      grantedAt: parsed.grantedAt,
      domains: [...parsed.domains!],
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      profileId: parsed.profileId!,
    };
  } catch {
    // 깨진 기록을 "승인됨"으로 읽는 쪽이 훨씬 나쁘다 — 승인 없음으로 떨어뜨린다.
    return { ...EMPTY_CONSENT };
  }
}

let consentRevision = 0;
/** Main-local epoch also distinguishes revoke/regrant while an import is pending. */
export function browserCredentialConsentRevision(): number { return consentRevision; }

function writeConsent(next: BrowserCredentialConsent): void {
  consentRevision += 1;
  setMeta(BROWSER_CREDENTIAL_CONSENT_KEY, JSON.stringify(next));
}

/** 사용자가 가져오기를 실행했을 때 그 선택을 승인으로 남긴다. 이후 갱신은 이 집합만 본다. */
export function recordBrowserCredentialConsent(profileId: string, domains: string[]): BrowserCredentialConsent {
  assertDevelopmentEffectAllowed("browser.credentials-consent-write");
  const prev = getBrowserCredentialConsent();
  const now = new Date().toISOString();
  // 두 번째 가져오기는 범위를 **넓힌다**(사용자가 또 골랐으므로). 줄이지는 않는다 —
  // 이전에 승인한 도메인을 조용히 갱신 대상에서 빼면 그 사이트만 며칠 뒤 로그아웃된다.
  const merged = [...new Set([...prev.domains, ...domains.map((d) => d.trim().toLowerCase())])].filter(Boolean);
  // ★도메인이 하나도 없는 "승인"은 자동 갱신이 영영 아무것도 하지 않는 상태다 — 사용자는
  //   승인했다고 믿는데 며칠 뒤 다시 로그아웃된다. 그런 기록은 남기지 않는다(실측으로 한 번 겪음).
  if (merged.length === 0) {
    console.warn("[browser-credentials] refusing to record consent with no domains");
    return prev;
  }
  const next: BrowserCredentialConsent = {
    granted: true,
    grantedAt: prev.grantedAt ?? now,
    domains: merged,
    lastSyncedAt: now,
    profileId,
  };
  writeConsent(next);
  return next;
}

export function revokeBrowserCredentialConsent(): BrowserCredentialConsent {
  writeConsent({ ...EMPTY_CONSENT });
  return { ...EMPTY_CONSENT };
}

/**
 * 아직 승인이 없고, 평소 브라우저에는 가져올 로그인이 있는가.
 * 이 질문이 참일 때만 사용자에게 한 번 묻는다. 거짓이면 화면에 아무것도 띄우지 않는다.
 */
export function browserCredentialConsentIsPending(): { pending: boolean; profileId: string | null; count: number } {
  assertDevelopmentEffectAllowed("browser.credentials-consent-discovery");
  const consent = getBrowserCredentialConsent();
  if (consent.granted) return { pending: false, profileId: consent.profileId, count: 0 };
  const profile = listDiscoverableProfiles().find((p) => p.readable);
  if (!profile) return { pending: false, profileId: null, count: 0 };
  const scan = scanBrowserCredentials(profile.id);
  if (!scan.ok) return { pending: false, profileId: profile.id, count: 0 };
  // "로그인된 것 같은" 것만 센다 — 만료 있는 쿠키가 하나도 없는 도메인은 물어볼 이유가 아니다.
  const count = scan.domains.filter((d) => d.hasPersistentCookie && !d.alreadyLinked).length;
  return { pending: count > 0, profileId: profile.id, count };
}

export interface BrowserCredentialRefreshReport {
  state: "not-consented" | "not-due" | "refreshed" | "failed" | "discarded" | "suppressed";
  suppressionReason?: "development_effect_policy_disabled";
  /** Value-free counts only; cookie names and values never leave the importer. */
  cookiesAdded: number;
  linkedSites: string[];
  requiresLoginSites: string[];
}

const NO_REFRESH_REPORT = (state: BrowserCredentialRefreshReport["state"]): BrowserCredentialRefreshReport => ({
  state,
  cookiesAdded: 0,
  linkedSites: [],
  requiresLoginSites: [],
});

let refreshInFlight: Promise<BrowserCredentialRefreshReport> | null = null;

/**
 * 승인된 도메인을 조용히 다시 가져온다. 승인이 없거나 아직 주기가 안 됐으면 아무것도 하지 않는다.
 * 앱 시작과 브라우저 도구가 실린 실행 앞에서 부른다 — 실패해도 그 실행을 막지 않는다.
 */
export function refreshBrowserCredentialsIfDue(opts?: { force?: boolean }): Promise<BrowserCredentialRefreshReport> {
  if (developmentEffectsSuppressed()) return Promise.resolve({ ...NO_REFRESH_REPORT("suppressed"), suppressionReason: "development_effect_policy_disabled" });
  if (refreshInFlight) return refreshInFlight;
  const consent = getBrowserCredentialConsent();
  if (!consent.granted || !consent.profileId || consent.domains.length === 0) {
    return Promise.resolve(NO_REFRESH_REPORT("not-consented"));
  }
  if (!opts?.force && consent.lastSyncedAt) {
    const age = Date.now() - Date.parse(consent.lastSyncedAt);
    if (Number.isFinite(age) && age < REFRESH_INTERVAL_MS) {
      return Promise.resolve(NO_REFRESH_REPORT("not-due"));
    }
  }
  const flight = (async (): Promise<BrowserCredentialRefreshReport> => {
    try {
      const result = await importBrowserCredentials(consent.profileId!, consent.domains);
      if (!result.ok) {
        // 전용 브라우저가 열려 있는 등 정당한 거절이 있다. 다음 기회에 다시 시도하도록
        // lastSyncedAt 을 갱신하지 않는다 — 실패를 성공으로 기록하면 영영 낡은 채로 남는다.
        console.warn("[browser-credentials] auto refresh skipped:", result.error);
        return {
          state: "failed",
          cookiesAdded: 0,
          linkedSites: result.linkedSites,
          requiresLoginSites: result.requiresLoginSites ?? [],
        };
      }
      // Import can take long enough for the user to revoke consent (or perform
      // a new manual import) while it is running. Never write the captured
      // snapshot back: that would re-grant a revoked scope or overwrite a
      // newer profile/domain selection. Only timestamp the still-exact grant.
      const current = getBrowserCredentialConsent();
      const sameDomains = current.domains.length === consent.domains.length
        && current.domains.every((domain, index) => domain === consent.domains[index]);
      if (!current.granted
        || current.grantedAt !== consent.grantedAt
        || current.profileId !== consent.profileId
        || !sameDomains) {
        return {
          state: "discarded",
          cookiesAdded: result.cookiesAdded,
          linkedSites: result.linkedSites,
          requiresLoginSites: result.requiresLoginSites ?? [],
        };
      }
      writeConsent({ ...current, lastSyncedAt: new Date().toISOString() });
      await (await import("./native-session-cookie-import")).syncConnectBrowserSession({
        domains: result.linkedSites.filter((site) => !result.requiresLoginSites?.includes(site)),
      });
      if (result.cookiesAdded > 0) {
        console.log(`[browser-credentials] refreshed ${result.linkedSites.length} site(s), +${result.cookiesAdded} cookies`);
      }
      return {
        state: "refreshed",
        cookiesAdded: result.cookiesAdded,
        linkedSites: result.linkedSites,
        requiresLoginSites: result.requiresLoginSites ?? [],
      };
    } catch (err) {
      console.warn("[browser-credentials] auto refresh failed:", err);
      return { ...NO_REFRESH_REPORT("failed") };
    }
  })();
  const tracked = flight.finally(() => {
    if (refreshInFlight === tracked) refreshInFlight = null;
  });
  refreshInFlight = tracked;
  return tracked;
}
