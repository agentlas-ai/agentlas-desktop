import type { NativeBrowserCookieImportResult } from "@shared/types";

/** Safe, value-free machine evidence for a failed Connect → Browser transfer. */
export function browserLoginImportDiagnostic(result: NativeBrowserCookieImportResult | undefined, ko: boolean): string | null {
  if (!result || result.code === "imported" || result.code === "already-migrated") return null;
  const host = result.hostFailure ? ` · ${result.hostFailure.stage}/${result.hostFailure.code}` : "";
  const skipped = result.skipped;
  return ko
    ? `오류 코드: ${result.code}${host} · 확인 ${result.observed} · 반영 ${result.imported} · 보존 ${result.preserved ?? 0} · 건너뜀 만료 ${skipped.expired}, 분할 ${skipped.partitioned}, 잘못됨 ${skipped.invalid}, 쓰기실패 ${skipped.writeFailed}`
    : `Error code: ${result.code}${host} · observed ${result.observed} · imported ${result.imported} · preserved ${result.preserved ?? 0} · skipped expired ${skipped.expired}, partitioned ${skipped.partitioned}, invalid ${skipped.invalid}, write-failed ${skipped.writeFailed}`;
}

/** A copied session is not proof that the website accepted its login. */
export function browserLoginImportNotice(result: NativeBrowserCookieImportResult | undefined, ko: boolean): string | null {
  if (!result || (result.ok && (result.code === "imported" || result.code === "already-migrated"))) return null;
  if (result.code === "migration-requires-connect") return ko
    ? "이전 로그인 연결이 끝까지 완료되지 않았습니다. 커넥트 → 브라우저에서 로그인을 다시 가져오거나, 이 브라우저에서 로그인하세요."
    : "The previous login transfer did not finish. Import logins again in Connect → Browser, or sign in here.";
  if (result.code === "partial") return ko
    ? "일부 로그인 정보가 작업 브라우저에 반영되지 않았습니다. 해당 사이트에서 로그인 상태를 확인하세요."
    : "Some login data could not be added to the task browser. Check your sign-in on the website.";
  if (result.code === "source-empty" || result.code === "no-transferable-cookies") return ko
    ? "커넥트의 브라우저 프로필에 재사용할 로그인 정보가 없습니다. 커넥트 → 브라우저에서 로그인을 가져오거나, 이 브라우저에서 로그인하세요."
    : "The Connect browser profile has no reusable login data. Import logins in Connect → Browser, or sign in here.";
  if (result.code === "authorization-required") return ko
    ? "작업 브라우저에서 사용할 로그인 승인을 확인하지 못했습니다. 커넥트 → 브라우저에서 로그인 연결을 확인하세요."
    : "Login reuse could not be authorized. Check your login connections in Connect → Browser.";
  return ko
    ? "가져온 로그인 정보를 작업 브라우저에 반영하지 못했습니다. 커넥트 → 브라우저에서 연결을 확인하거나, 이 브라우저에서 로그인하세요."
    : "Imported login data could not be added to the task browser. Check Connect → Browser, or sign in here.";
}
