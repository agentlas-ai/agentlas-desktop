import type { NativeBrowserCookieImportResult } from "@shared/types";

/** Safe, value-free machine evidence for a failed Connect → Browser transfer. For a `data-` attribute or a log line only: it is never drawn as text on a screen (no code on a screen). */
export function browserLoginImportDiagnostic(result: NativeBrowserCookieImportResult | undefined, _ko?: boolean): string | null {
  if (!result || result.code === "imported" || result.code === "already-migrated") return null;
  const host = result.hostFailure ? ` · ${result.hostFailure.stage}/${result.hostFailure.code}` : "";
  const skipped = result.skipped;
  return `${result.code}${host} · observed ${result.observed} · imported ${result.imported} · preserved ${result.preserved ?? 0} · skipped expired ${skipped.expired}, partitioned ${skipped.partitioned}, invalid ${skipped.invalid}, write-failed ${skipped.writeFailed}`;
}

/** A copied session is not proof that the website accepted its login. */
export function browserLoginImportNotice(result: NativeBrowserCookieImportResult | undefined, ko: boolean): string | null {
  if (!result || (result.ok && (result.code === "imported" || result.code === "already-migrated"))) return null;
  if (result.code === "migration-requires-connect") return ko
    ? "이전 로그인 연결이 끝까지 완료되지 않았어요. 커넥트 → 브라우저에서 로그인을 다시 가져오거나, 이 브라우저에서 로그인해 주세요."
    : "The previous login transfer did not finish. Import logins again in Connect → Browser, or sign in here.";
  if (result.code === "partial") return ko
    ? "일부 로그인 정보가 작업 브라우저에 반영되지 않았어요. 해당 사이트에서 로그인 상태를 확인해 주세요."
    : "Some login data could not be added to the task browser. Check your sign-in on the website.";
  if (result.code === "source-empty" || result.code === "no-transferable-cookies") return ko
    ? "커넥트의 브라우저 프로필에 재사용할 로그인 정보가 없어요. 커넥트 → 브라우저에서 로그인을 가져오거나, 이 브라우저에서 로그인해 주세요."
    : "The Connect browser profile has no reusable login data. Import logins in Connect → Browser, or sign in here.";
  if (result.code === "authorization-required") return ko
    ? "작업 브라우저에서 사용할 로그인 승인을 확인하지 못했어요. 커넥트 → 브라우저에서 로그인 연결을 확인해 주세요."
    : "Login reuse could not be authorized. Check your login connections in Connect → Browser.";
  return ko
    ? "가져온 로그인 정보를 작업 브라우저에 반영하지 못했어요. 커넥트 → 브라우저에서 연결을 확인하거나, 이 브라우저에서 로그인해 주세요."
    : "Imported login data could not be added to the task browser. Check Connect → Browser, or sign in here.";
}
