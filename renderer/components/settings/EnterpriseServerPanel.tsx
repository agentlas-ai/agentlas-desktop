"use client";

// Settings → company server (Agentlas Enterprise Server). docs/enterprise-server/05-MIGRATION-AND-DESKTOP-SPLIT.md §4.
// Shows whether this Desktop is connected to a company server (a managed MDM/GPO file, or one entered here with a one-time
// enrollment code), the pinned server key, the seat token's mode and expiry, the license state the server reports and the last
// update-feed check. Actions: enter an enrollment code, re-check now, disconnect this device (asks first).
// Main sends status only — never the device key, the token or a managed file's code.
// A personal install sees nothing unless the organization rule's entry is open (shared/business/visibility.ts): then one short
// "connect" row.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ipc } from "@/lib/ipc";
import { confirmPopup } from "@/lib/popup";
import { IconAlertTriangle, IconBuilding, IconLock, IconRefresh } from "@/components/Icon";
import { useOrganizationUiVisibility } from "@/business/organization-visibility";
import {
  enterpriseCanEnroll, enterpriseServerPhase,
  type EnterpriseErrorCode, type EnterpriseServerActionResult, type EnterpriseServerPhase, type EnterpriseServerStatus,
} from "@shared/enterprise-server";
import styles from "./EnterpriseServerPanel.module.css";

type Copy = { ko: string; en: string };
const ERRORS: Record<EnterpriseErrorCode, Copy> = {
  enrollment_code_format: { ko: "등록 코드는 ENR-XXXX-XXXX-XXXX 형식입니다.", en: "Enrollment codes look like ENR-XXXX-XXXX-XXXX." },
  server_url_invalid: { ko: "서버 주소는 경로 없는 https:// 주소여야 합니다.", en: "Use an https:// address with no path." },
  fingerprint_invalid: { ko: "서버 키 지문은 64자리 16진수입니다. 회사 관리자 화면에 표시됩니다.", en: "The server key fingerprint is 64 hex characters, shown on the company admin screen." },
  managed_connection_locked: { ko: "회사에서 관리하는 설정이라 서버 주소를 바꿀 수 없습니다.", en: "This connection is managed by your company and can't be changed here." },
  already_enrolled: { ko: "이 기기는 이미 등록되어 있습니다. 다른 서버로 옮기려면 먼저 연결을 해제하세요.", en: "This device is already enrolled. Disconnect it first to move to another server." },
  not_connected: { ko: "연결된 회사 서버가 없습니다.", en: "No company server is connected." },
  not_enrolled: { ko: "이 기기는 아직 등록되지 않았습니다.", en: "This device isn't enrolled yet." },
  confirm_required: { ko: "확인이 필요합니다.", en: "Confirmation is required." },
  busy: { ko: "다른 작업을 처리하는 중입니다. 잠시 뒤 다시 시도하세요.", en: "Another action is in progress. Try again in a moment." },
  enrollment_code_invalid: { ko: "등록 코드가 맞지 않거나, 이미 쓰였거나, 만료되었습니다(72시간). 관리자에게 새 코드를 요청하세요.", en: "The code is wrong, already used, or expired (72 hours). Ask your admin for a new one." },
  seat_limit_reached: { ko: "좌석이 모두 찼습니다. 관리자에게 좌석 추가를 요청하세요.", en: "All seats are taken. Ask your admin to add seats." },
  device_limit_reached: { ko: "이 계정에 등록할 수 있는 기기 수를 넘었습니다. 관리자에게 이전 기기 해제를 요청하세요.", en: "This account has too many devices. Ask your admin to release an old one." },
  device_exists: { ko: "이 기기는 서버에 이미 있습니다. 연결을 해제한 뒤 새 코드로 다시 등록하세요.", en: "The server already knows this device. Disconnect, then enroll with a new code." },
  device_revoked: { ko: "회사 관리자가 이 기기의 연결을 해제했습니다. 새 등록 코드로 다시 등록할 수 있습니다.", en: "Your admin released this device. You can enroll again with a new code." },
  device_unknown: { ko: "서버가 이 기기를 모릅니다. 새 등록 코드로 다시 등록하세요.", en: "The server doesn't know this device. Enroll again with a new code." },
  "license_mode_blocks:enroll": { ko: "회사 라이선스가 읽기 전용이거나 정지되어 새 기기를 등록할 수 없습니다.", en: "The company license is read-only or stopped, so new devices can't enroll." },
  "license_mode_blocks:token": { ko: "회사 라이선스가 정지되어 좌석 토큰을 갱신할 수 없습니다.", en: "The company license is stopped, so the seat token can't be renewed." },
  rate_limited: { ko: "시도가 너무 많습니다. 1분 뒤 다시 시도하세요.", en: "Too many attempts. Try again in a minute." },
  invalid_request: { ko: "입력 형식이 맞지 않습니다.", en: "The input isn't in the expected format." },
  clock_skew: { ko: "이 컴퓨터의 시계가 서버와 5분 넘게 다릅니다. 시간을 맞춘 뒤 다시 확인하세요.", en: "This computer's clock is more than 5 minutes off the server. Fix the time and re-check." },
  replay: { ko: "서버가 이 기기의 서명을 받지 않았습니다. 잠시 뒤 다시 확인하세요.", en: "The server didn't accept this device's signature. Re-check in a moment." },
  signature_invalid: { ko: "서버가 이 기기의 서명을 받지 않았습니다. 연결을 해제하고 다시 등록하세요.", en: "The server rejected this device's signature. Disconnect and enroll again." },
  seat_token_untrusted: { ko: "서버가 보낸 토큰이 고정된 서버 키와 맞지 않습니다. 서버 주소와 지문을 확인하세요.", en: "The token isn't signed by the pinned server key. Check the address and fingerprint." },
  seat_response_invalid: { ko: "서버 응답 형식이 맞지 않습니다.", en: "The server's answer isn't in the expected format." },
  server_key_mismatch: { ko: "이 주소의 서버 키가 고정된 지문과 다릅니다. 관리자에게 확인하세요.", en: "The server at this address has a different key than the pinned fingerprint. Check with your admin." },
  server_status_invalid: { ko: "서버 상태 응답 형식이 맞지 않습니다.", en: "The server's status answer isn't in the expected format." },
  server_unreachable: { ko: "회사 서버에 닿지 못했습니다. 회사 네트워크나 VPN 연결을 확인하세요.", en: "Couldn't reach the company server. Check the company network or VPN." },
  server_error: { ko: "회사 서버가 요청을 처리하지 못했습니다.", en: "The company server couldn't handle the request." },
};

const PHASE: Record<Exclude<EnterpriseServerPhase, "not_connected">, { label: Copy; tone: "ok" | "warn" | "danger" | "neutral"; note?: Copy }> = {
  active: { label: { ko: "연결됨", en: "Connected" }, tone: "ok" },
  grace: { label: { ko: "유예 · 읽기 전용", en: "Grace · read-only" }, tone: "warn",
    note: { ko: "회사 라이선스가 유예 기간입니다. 읽기는 되지만 새 회사 작업은 잠깁니다.", en: "The company license is in its grace period. Reading works; new company work is locked." } },
  suspended: { label: { ko: "정지", en: "Suspended" }, tone: "danger",
    note: { ko: "회사 라이선스가 정지되었습니다. 회사 기능이 멈췄고 개인 기능은 그대로입니다.", en: "The company license is suspended. Company features are stopped; personal features are unaffected." } },
  revoked: { label: { ko: "해지", en: "Revoked" }, tone: "danger",
    note: { ko: "회사 라이선스가 해지되었습니다. 회사 기능을 쓸 수 없습니다.", en: "The company license was revoked. Company features are unavailable." } },
  expired: { label: { ko: "만료", en: "Expired" }, tone: "danger",
    note: { ko: "회사 라이선스가 만료되었습니다. 회사 관리자에게 문의하세요.", en: "The company license has expired. Contact your company admin." } },
  needs_enrollment: { label: { ko: "등록 필요", en: "Enrollment needed" }, tone: "neutral",
    note: { ko: "회사 관리자에게 받은 1회용 등록 코드로 이 기기를 등록하세요.", en: "Enroll this device with the one-time code from your company admin." } },
  unverified: { label: { ko: "확인 필요", en: "Needs a check" }, tone: "warn",
    note: { ko: "좌석 토큰이 만료되었습니다. 회사 네트워크에서 다시 확인하세요.", en: "The seat token expired. Re-check from the company network." } },
};

const LICENSE: Record<string, Copy> = {
  active: { ko: "활성", en: "Active" }, term_grace: { ko: "기간 종료 유예", en: "Term grace" }, payment_grace: { ko: "결제 유예", en: "Payment grace" },
  lease_expired: { ko: "임대 갱신 지연", en: "Lease overdue" }, clock_untrusted: { ko: "서버 시계 확인 필요", en: "Server clock untrusted" },
  suspended: { ko: "정지", en: "Suspended" }, revoked: { ko: "해지", en: "Revoked" }, expired: { ko: "만료", en: "Expired" },
  unlicensed: { ko: "라이선스 없음", en: "No license" }, invalid: { ko: "라이선스 오류", en: "License invalid" },
  not_yet_valid: { ko: "시작 전", en: "Not yet valid" }, activation_required: { ko: "활성화 필요", en: "Activation required" },
};

const pick = (c: Copy, ko: boolean) => (ko ? c.ko : c.en);
function when(iso: string | null, ko: boolean, withYear = false): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { ...(withYear ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(t);
}
const groupHex = (hex: string) => hex.replace(/(.{4})/g, "$1 ").trim();
const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ""; } catch { return url ?? ""; } };

export function EnterpriseServerPanel({ locale }: { locale: string }) {
  const ko = locale === "ko";
  const api = ipc()?.enterpriseServer;
  const entry = useOrganizationUiVisibility({ eligible: null }).entry;
  const [status, setStatus] = useState<EnterpriseServerStatus | null>(null);
  const [actionError, setActionError] = useState<EnterpriseErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [code, setCode] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [fingerprint, setFingerprint] = useState("");

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setStatus(await api.status()); } catch { /* keep the last view */ }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  // The first render is always empty: a personal install never sees this card flash.
  if (!api || !status) return null;
  const phase = enterpriseServerPhase(status);
  const managed = status.source === "managed";
  if (!status.connected && !entry && !status.managedFileIgnored) return null;

  const run = async (action: () => Promise<EnterpriseServerActionResult>, after?: (r: EnterpriseServerActionResult) => void) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await action();
      setStatus(r.status);
      setActionError(r.ok ? null : r.error);
      after?.(r);
    } catch {
      setActionError("server_error");
      await refresh();
    } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Without a connection the person supplies the server once; afterwards Main reuses the managed or entered one.
    const input = !status.connected
      ? { enrollmentCode: code, serverUrl: serverUrl.trim(), serverKeyFingerprint: fingerprint.trim() }
      : { enrollmentCode: code };
    void run(() => api.enroll(input), (r) => { if (r.ok) { setFormOpen(false); setCode(""); } });
  };
  const disconnect = async () => {
    const title = ko ? "이 기기의 회사 서버 연결을 해제할까요?" : "Disconnect this device from the company server?";
    const body = [
      ko ? "이 기기의 회사 키와 좌석 토큰을 지웁니다. 서버에 남은 이 기기 기록은 회사 관리자가 해제해야 합니다." : "This removes this device's company key and seat token. Your company admin releases the device record on the server.",
      managed ? (ko ? "회사 관리 설정 파일은 그대로 남습니다." : "The company-managed settings file stays.") : (ko ? "입력한 서버 주소도 지웁니다." : "The server address entered here is removed too."),
    ].join(" ");
    const ok = await confirmPopup(`${title}\n${body}`, {
      locale: ko ? "ko" : "en", tone: "danger", detail: status.deviceId ? `${ko ? "기기 ID" : "Device ID"}: ${status.deviceId}` : undefined,
      confirmLabel: ko ? "연결 해제" : "Disconnect", cancelLabel: ko ? "취소" : "Cancel",
    });
    if (ok) void run(() => api.disconnect({ confirm: true }));
  };

  const stopped = phase === "suspended" || phase === "revoked" || phase === "expired";
  // A stored error that only restates the phase (the note already says it) is not repeated; what the person just did always shows.
  const restated = status.lastError?.code === "device_revoked" || (stopped && status.lastError?.code === "license_mode_blocks:token");
  const shownError = actionError ?? (restated ? null : status.lastError?.code ?? null);
  const showForm = formOpen || (status.connected && phase === "needs_enrollment" && !status.managedEnrollmentCode);
  const askServer = !status.connected;

  const form = (
    <form className={styles.form} onSubmit={submit} data-testid="enterprise-server-enroll-form">
      {askServer && <>
        <label className={styles.field}>
          <span>{ko ? "서버 주소" : "Server address"}</span>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://agentlas.company.internal" spellCheck={false} autoComplete="off" inputMode="url" disabled={busy} data-testid="enterprise-server-url" />
        </label>
        <label className={styles.field}>
          <span>{ko ? "서버 키 지문 (SHA-256)" : "Server key fingerprint (SHA-256)"}</span>
          <input value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} placeholder={ko ? "관리자 화면의 64자리 값" : "64 characters from the admin screen"} spellCheck={false} autoComplete="off" className={styles.mono} disabled={busy} data-testid="enterprise-server-fingerprint" />
        </label>
      </>}
      <label className={styles.field}>
        <span>{ko ? "등록 코드 (1회용)" : "Enrollment code (one-time)"}</span>
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ENR-XXXX-XXXX-XXXX" spellCheck={false} autoComplete="off" className={styles.mono} maxLength={40} disabled={busy} data-testid="enterprise-server-code" />
      </label>
      <div className={styles.formActions}>
        <button type="submit" className={styles.primary} disabled={busy || !code.trim() || (askServer && (!serverUrl.trim() || !fingerprint.trim()))} data-testid="enterprise-server-enroll">
          {ko ? "이 기기 등록" : "Enroll this device"}
        </button>
        {(formOpen || !status.connected) && <button type="button" className={styles.ghost} disabled={busy} onClick={() => { setFormOpen(false); setActionError(null); }}>{ko ? "취소" : "Cancel"}</button>}
      </div>
    </form>
  );

  // Not connected: one quiet row (only when the organization entry is open), the form opens on demand.
  if (!status.connected) {
    return (
      <section className={styles.panel} aria-labelledby="enterprise-server-title" data-testid="enterprise-server-panel" data-phase="not_connected">
        <h2 id="enterprise-server-title" className={styles.title}>{ko ? "회사 서버" : "Company server"}</h2>
        <div className={styles.card}>
          {status.managedFileIgnored && (
            <div className={styles.notice} data-tone="warn" role="status">
              <IconAlertTriangle size={15} />
              <span>{ko ? "회사 관리 설정 파일이 있지만 형식이 맞지 않아 쓰지 않았습니다. IT 담당자에게 알려 주세요." : "A company-managed settings file exists but isn't valid, so it was ignored. Let your IT team know."}
                <code className={styles.path}>{status.managedFileIgnored}</code></span>
            </div>
          )}
          {!formOpen ? (
            <div className={styles.entryRow} data-testid="enterprise-server-connect-entry">
              <span className={styles.entryLabel}><IconBuilding size={16} />{ko ? "회사 서버에 연결" : "Connect to a company server"}</span>
              <button type="button" className={styles.secondary} onClick={() => setFormOpen(true)} data-testid="enterprise-server-open-form">{ko ? "등록 코드 입력" : "Enter enrollment code"}</button>
            </div>
          ) : form}
          {shownError && <div className={styles.error} role="alert" data-testid="enterprise-server-error" data-code={shownError}>{pick(ERRORS[shownError], ko)}</div>}
        </div>
      </section>
    );
  }

  const ph = PHASE[phase as Exclude<EnterpriseServerPhase, "not_connected">];
  const note = phase === "revoked" && status.lastError?.code === "device_revoked" ? ERRORS.device_revoked : ph.note;
  const seatText = stopped && status.seat.valid
    ? (ko ? "쓸 수 없음 · 회사 라이선스가 멈춤" : "Not usable · company license stopped")
    : status.seat.valid
    ? `${status.seat.mode === "readonly" ? (ko ? "읽기 전용" : "Read-only") : (ko ? "유효" : "Valid")} · ${ko ? `${when(status.seat.expiresAt, ko)}까지` : `until ${when(status.seat.expiresAt, ko)}`}`
    : status.enrolled ? (ko ? "만료됨" : "Expired") : (ko ? "없음" : "None");
  const licenseText = status.license
    ? `${pick(LICENSE[status.license.state] ?? { ko: status.license.state, en: status.license.state }, ko)}${status.license.termEndsAt ? ` · ${ko ? "기간" : "term"} ${when(status.license.termEndsAt, ko, true)}` : ""}`
    : (ko ? "아직 확인 전" : "Not checked yet");
  const feedText = `${status.updateFeed.source === "company" ? (ko ? "회사 서버에서 받음" : "From the company server") : (ko ? "Agentlas 공식" : "Agentlas official")}`
    + (status.updateFeed.lastCheckAt
      ? ` · ${ko ? "마지막 확인" : "last checked"} ${when(status.updateFeed.lastCheckAt, ko)}${status.updateFeed.ok === false ? (ko ? " (실패)" : " (failed)") : status.updateFeed.version ? ` (${status.updateFeed.version})` : ""}`
      : ` · ${ko ? "아직 확인 전" : "not checked yet"}`);

  return (
    <section className={styles.panel} aria-labelledby="enterprise-server-title" data-testid="enterprise-server-panel" data-phase={phase} data-source={status.source ?? ""}>
      <h2 id="enterprise-server-title" className={styles.title}>{ko ? "회사 서버" : "Company server"}</h2>
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.server}><IconBuilding size={16} /><span title={status.serverUrl ?? ""}>{hostOf(status.serverUrl)}</span></span>
          <span className={styles.badge} data-tone={ph.tone} data-testid="enterprise-server-phase">{pick(ph.label, ko)}</span>
        </div>
        {managed && (
          <div className={styles.notice} data-tone="neutral" data-testid="enterprise-server-managed">
            <IconLock size={15} />
            <span>{ko ? "회사에서 관리하는 설정입니다. 이 화면에서 바꿀 수 없습니다." : "Managed by your company. It can't be changed here."}
              {status.managedFile && <code className={styles.path}>{status.managedFile}</code>}</span>
          </div>
        )}
        {note && <div className={styles.notice} data-tone={ph.tone} data-testid="enterprise-server-note">{ph.tone !== "neutral" && <IconAlertTriangle size={15} />}<span>{pick(note, ko)}</span></div>}
        <dl className={styles.grid}>
          <dt>{ko ? "서버 주소" : "Server"}</dt><dd className={styles.mono}>{status.serverUrl}</dd>
          <dt>{ko ? "서버 키 지문" : "Key fingerprint"}</dt><dd className={`${styles.mono} ${styles.fingerprint}`} data-testid="enterprise-server-fingerprint-value">{status.serverKeyFingerprint ? groupHex(status.serverKeyFingerprint) : "—"}</dd>
          <dt>{ko ? "설정 출처" : "Configured by"}</dt><dd>{managed ? (ko ? "회사 관리 설정 (MDM/GPO)" : "Company-managed (MDM/GPO)") : (ko ? "이 기기에서 입력" : "Entered on this device")}</dd>
          <dt>{ko ? "좌석 토큰" : "Seat token"}</dt><dd data-testid="enterprise-server-seat">{seatText}</dd>
          <dt>{ko ? "라이선스" : "License"}</dt><dd data-testid="enterprise-server-license">{licenseText}</dd>
          <dt>{ko ? "업데이트" : "Updates"}</dt><dd data-testid="enterprise-server-feed">{feedText}</dd>
          <dt>{ko ? "마지막 확인" : "Last check"}</dt><dd>{status.lastCheckAt ? when(status.lastCheckAt, ko) : (ko ? "아직 안 함" : "Not yet")}</dd>
          {status.deviceId && <><dt>{ko ? "기기 ID" : "Device ID"}</dt><dd className={styles.mono}>{status.deviceId}</dd></>}
        </dl>
        {shownError && <div className={styles.error} role="alert" data-testid="enterprise-server-error" data-code={shownError}>{pick(ERRORS[shownError], ko)}</div>}
        {showForm && enterpriseCanEnroll(status) && form}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void run(() => api.recheck())} data-testid="enterprise-server-recheck">
            <IconRefresh size={14} />{ko ? "지금 다시 확인" : "Re-check now"}
          </button>
          {!showForm && enterpriseCanEnroll(status) && (
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setFormOpen(true); setActionError(null); }} data-testid="enterprise-server-open-form">
              {ko ? "등록 코드 입력" : "Enter enrollment code"}
            </button>
          )}
          {(status.enrolled || status.source === "user") && (
            <button type="button" className={styles.danger} disabled={busy} onClick={() => void disconnect()} data-testid="enterprise-server-disconnect">
              {ko ? "이 기기 연결 해제" : "Disconnect this device"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
