// Why Science could not open, told to the person looking at it.
//
// The Science UI prints whatever message science:bootstrap rejects with. In the daemon build the store is
// opened by the execution owner, and main used to answer every non-ready owner with the bare
// "science_daemon_science_unavailable" -- the owner's own errorCode (for example
// "science-schema-incompatible:database-newer-than-app|database=N|app=M") was dropped, so a Science data
// file written by a newer build read as an unexplained outage with no way out. The machine code is kept at
// the end of the sentence; nothing here parses prose, only the code prefix and its key=value fields.

export type ScienceBootstrapLocale = "ko" | "en";

const SCHEMA_INCOMPATIBLE = "science-schema-incompatible";

function field(detail: string, key: string): string | null {
  const match = new RegExp(`(?:^|[|:])${key}=([0-9]{1,9})(?:$|[|])`).exec(detail);
  return match ? match[1] : null;
}

/** A bounded, single-line copy of a machine code that is safe to show. */
function visibleCode(code: string): string {
  return code.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

export function scienceBootstrapFailureMessage(input: {
  /** The owner's errorCode, or the thrown error's message on the in-process path. */
  code: string | null | undefined;
  /** The owner's state when it is not ready (daemon path). */
  state?: string | null;
  locale: ScienceBootstrapLocale;
}): string {
  const ko = input.locale === "ko";
  const raw = typeof input.code === "string" && input.code.trim() ? input.code.trim() : null;
  const code = raw ? visibleCode(raw) : `science_daemon_science_unavailable${input.state ? `:${input.state}` : ""}`;

  if (raw && raw.startsWith(SCHEMA_INCOMPATIBLE)) {
    const detail = raw.slice(SCHEMA_INCOMPATIBLE.length);
    const database = field(detail, "database");
    const app = field(detail, "app");
    if (/database-newer-than-app/.test(detail) || (database && app && Number(database) > Number(app))) {
      const versions = database && app
        ? (ko ? ` (데이터 형식 ${database}, 이 앱이 읽을 수 있는 형식 ${app})` : ` (data format ${database}; this app reads up to ${app})`)
        : "";
      return ko
        ? `Science 데이터가 이 Agentlas보다 새 버전에서 저장되어 열 수 없습니다${versions}. 데이터는 바뀌지 않았습니다. Agentlas를 최신 버전으로 업데이트한 뒤 다시 시작하세요. 개발용 빌드에서 만든 데이터라면 그 빌드로 여세요. [${code}]`
        : `Science data was saved by a newer version of Agentlas and cannot be opened here${versions}. Your data has not been changed. Update Agentlas to the latest version and restart it. If a development build wrote this data, open it with that build. [${code}]`;
    }
    if (/database-version-unreadable/.test(detail)) {
      return ko
        ? `Science 데이터 파일의 형식 번호를 읽을 수 없어 열지 않았습니다. 데이터는 바뀌지 않았습니다. Agentlas를 최신 버전으로 업데이트한 뒤 다시 시작하고, 그래도 같으면 이 코드와 함께 알려 주세요. [${code}]`
        : `The Science data file's format number could not be read, so it was not opened. Your data has not been changed. Update Agentlas and restart it; if this persists, report it with this code. [${code}]`;
    }
    return ko
      ? `Science 데이터 형식이 이 Agentlas와 맞지 않아 열 수 없습니다. 데이터는 바뀌지 않았습니다. Agentlas를 최신 버전으로 업데이트한 뒤 다시 시작하세요. [${code}]`
      : `Science data is in a format this Agentlas cannot open. Your data has not been changed. Update Agentlas to the latest version and restart it. [${code}]`;
  }

  // Other owner failures keep their exact code; no instruction is given that is not known to help (the daemon
  // survives a same-version app restart, so "restart" is not a proven way out here).
  return ko
    ? `Science 실행 서비스가 준비되지 않아 열 수 없습니다. 끝의 코드가 원인입니다. [${code}]`
    : `The Science service is not ready, so Science cannot open. The code at the end is the cause. [${code}]`;
}

export function scienceBootstrapFailure(input: { code: string | null | undefined; state?: string | null; locale: ScienceBootstrapLocale }): Error {
  const error = new Error(scienceBootstrapFailureMessage(input));
  (error as Error & { code?: string }).code = typeof input.code === "string" && input.code
    ? input.code.split(":", 1)[0] : "science_daemon_science_unavailable";
  return error;
}

export function isScienceStoreFormatRefusal(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith(SCHEMA_INCOMPATIBLE);
}
