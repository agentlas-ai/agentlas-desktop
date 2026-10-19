/**














 */

export type OwnerActivityLocale = "ko" | "en";

export interface OwnerActivityContext {
  locale: OwnerActivityLocale;
  /** 이 이벤트가 주장하는 에이전트의 표시 이름(typed agentName). */
  agentName?: string;
  /** 에이전트 id·슬러그 → 표시 이름. 키는 `agentKey()` 로 정규화해 비교한다. */
  names?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** 마지막 실패의 실제 이유. 있으면 "다시 시도 중" 대신 이것을 쓴다. */
  finalReason?: string;
  /** TF 미완료일 때 남은 일의 이름들. */
  remaining?: readonly string[];
}

/** Emitters write the run's own locale; surfaces without a locale (stored steps, phone) read it off the text. */
export function inferOwnerLocale(text: string | null | undefined, fallback: OwnerActivityLocale = "en"): OwnerActivityLocale {
  return /[가-힣]/.test(String(text ?? "")) ? "ko" : fallback;
}

const MACHINE_PREFIX = /^(?:(?:borrow|installed|firm|cloud|hub|local|builtin|team-mem[\w-]*|team)\s*:)/i;
const MACHINE_TOKEN = /(?:borrow:)?(?:installed|firm|cloud|hub|local|team-mem[\w-]*)(?::[\w.\-]+)+/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** 슬러그·uuid·긴 hex 처럼 사람이 쓴 이름이 아닌 값. */
export function isMachineAgentLabel(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (MACHINE_PREFIX.test(text)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text) || /^[0-9a-f]{16,}$/i.test(text)) return true;
  return !/\s/.test(text) && /^[a-z0-9]+(?:[-_.:][a-z0-9]+)+$/.test(text);
}

/** `borrow:installed:x` · `borrow:firm:y:team:uuid` · `installed:x` → 같은 키. */
export function agentKey(id: string): string {
  return id.trim().toLowerCase().replace(/^borrow:/, "").replace(/:team(?::[\w-]+)?$/, "");
}

function lookup(names: OwnerActivityContext["names"], id: string): string | undefined {
  if (!names || !id) return undefined;
  const key = agentKey(id);
  const read = (k: string): string | undefined => {
    const value = names instanceof Map ? names.get(k) : (names as Record<string, string>)[k];
    return typeof value === "string" && value.trim() && !isMachineAgentLabel(value) ? value.trim() : undefined;
  };
  return read(key) ?? read(id) ?? read(key.split(":").slice(1).join(":"));
}

function generic(locale: OwnerActivityLocale): string {
  return locale === "ko" ? "에이전트" : "agent";
}

/** 표시용 에이전트 이름. 사람이 쓴 이름이면 그대로, 기계 값이면 명단에서, 못 풀면 일반어. */
export function ownerAgentLabel(raw: string | null | undefined, ctx: OwnerActivityContext): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return generic(ctx.locale);
  if (!isMachineAgentLabel(text)) return text;
  return lookup(ctx.names, text) ?? (ctx.agentName && !isMachineAgentLabel(ctx.agentName) ? ctx.agentName : generic(ctx.locale));
}

/** 기계 값이면 null(숨김), 사람이 쓴 이름이면 그대로 — 역할 줄처럼 "없어도 되는" 자리용. */
export function ownerAgentLabelOrNull(raw: string | null | undefined, ctx: OwnerActivityContext): string | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (!isMachineAgentLabel(text)) return text;
  return lookup(ctx.names, text) ?? null;
}

/** 문장 속 내부 id 를 표시 이름으로 바꾼다. 못 푼 것은 지운다. */
function cleanSlugs(text: string, ctx: OwnerActivityContext): string {
  const replaced = text
    .replace(MACHINE_TOKEN, (token) => lookup(ctx.names, token) ?? "")
    .replace(UUID, "")
    .replace(/\(\s*\)|\[\s*\]/g, "");
  return replaced.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/(?:,\s*)+$/g, "").trim();
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const NAME = "([^→]+?)";

// 배관 — 화면에서 뺀다.
const DROP_PATTERNS: readonly RegExp[] = [
  /^\[[A-Za-z][\w.-]*\]/, // [codex-personal] · [cache] · [runtime-session] · [runtime-protocol] · [codex-surface]
  /^(?:codex|claude(?: code)?|gemini|grok|kimi|agy|antigravity|cursor|copilot|ollama|lmstudio|mlx)\s*:\s/i, // CLI stderr
  /^(?:reconnecting|falling back from websockets)\b/i,
  /\bunexpected status \d{3}\b|\bwss?:\/\/\S+|\bcf-ray:/i,
  /^CLI\s*(?:프로세스|process)/i,
  /^session (?:alive|resumed|started)\b/i,
  /^.{1,40}\s호출 중\.{0,3}$/, // "{backend} 호출 중..."
  /^calling\s.{1,40}?\.{0,3}$/i,
  /^(?:AI 연결을 다시 확인하는 중|Checking the AI connection)/i,
  /^(?:전송 중|sending)\.{0,3}$/i,
  /출력 형식(?:은|을).{0,40}(?:지시문|강제)|output (?:format|schema)\b.{0,60}\b(?:instruction|prompt|enforce)/i,
  /이번 실행에 고른 AI|^This run uses .{1,80}; checking that the call goes through/i,
  /^(?:연결된 도구로 작업을 계속합니다|Continuing with the configured tools)/i,
];

/**
 * 오너에게 보일 한 줄. null 이면 줄이 아니다(배관).
 * 모르는 문구는 슬러그만 정리해 그대로 둔다 — 못 알아본다고 지우지 않는다.
 */
export function ownerActivityText(raw: string | null | undefined, ctx: OwnerActivityContext): string | null {
  const ko = ctx.locale === "ko";
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (DROP_PATTERNS.some((pattern) => pattern.test(text))) return null;
  const label = (value: string) => ownerAgentLabel(value.trim(), ctx);
  let match: RegExpMatchArray | null;

  // 팀 단계
  if ((match = text.match(new RegExp(`^${NAME} → ${NAME} (?:메시지 전송|message sent)$`, "i")))) {
    return ko ? `${label(match[2])}에게 맡김` : `Handed to ${label(match[2])}`;
  }
  if ((match = text.match(new RegExp(`^${NAME} → ${NAME} (?:답장|replied)$`, "i")))) {
    return ko ? `${label(match[2])}에게 답함` : `Replied to ${label(match[2])}`;
  }
  if ((match = text.match(new RegExp(`^${NAME} → ${NAME} (?:결과 전달|result sent)$`, "i")))) {
    return ko ? `${label(match[1])} 결과 받음` : `Got result from ${label(match[1])}`;
  }
  if ((match = text.match(/^(.+?) (?:단계 보류 — 선행 단계 미완료|step withheld — dependency incomplete)$/i))) {
    return ko ? `${label(match[1])}: 앞 단계 기다리는 중` : `${label(match[1])}: waiting for an earlier step`;
  }
  if ((match = text.match(/^(.+?) (?:팀 )?(?:일부 )?실패$/) ?? text.match(/^(.+?) (?:team )?failed$/i)
    ?? text.match(/^(.+?) team completed with worker failures$/i))) {
    const who = label(match[1]);
    const reason = ctx.finalReason?.replace(/\s+/g, " ").trim();
    return reason ? `${who}: ${reason}` : ko ? `${who}: 다시 시도 중` : `${who}: retrying`;
  }
  if ((match = text.match(/^(?:한 단계가 막혀 다시 진행하는 중…?|Retrying a blocked step…?)(?:\s*\((.*)\))?$/i))) {
    const who = match[1] ? lookup(ctx.names, match[1]) ?? (isMachineAgentLabel(match[1]) ? "" : match[1]) : "";
    return who ? (ko ? `${who}: 다시 시도 중` : `${who}: retrying`) : (ko ? "한 단계 다시 시도 중" : "Retrying a step");
  }
  if ((match = text.match(/^(?:Hub TF 에이전트 준비 중|Preparing Hub task-force agents)\s*:\s*(.*)$/i))) {
    const names = uniqueNames(match[1].split(",").map((part) => part.trim()).filter(Boolean)
      .map((part) => lookup(ctx.names, part) ?? (isMachineAgentLabel(part) ? "" : part)));
    return names.length ? (ko ? `에이전트 준비 중: ${names.join(", ")}` : `Preparing agents: ${names.join(", ")}`)
      : (ko ? "에이전트 준비 중" : "Preparing agents");
  }
  if (/^(?:TF 미완료|Task force incomplete)/i.test(text)) {
    const left = uniqueNames((ctx.remaining ?? []).map((name) => ownerAgentLabel(name, ctx)));
    return left.length ? (ko ? `남은 작업: ${left.join(", ")}` : `Left to do: ${left.join(", ")}`)
      : (ko ? "남은 작업 있음" : "Work remains");
  }
  if (/^(?:계획 검증 실패|Plan validation failed)/i.test(text)) return ko ? "계획 다듬는 중" : "Refining the plan";
  if (/^(?:CEO가 작업을 분배하는 중|CEO is planning the work)/i.test(text)) return ko ? "작업 나누는 중" : "Splitting the work";
  if (/^(?:TF 오케스트레이터가 에이전트별 입력 패킷을 설계 중|Task-force orchestrator is designing)/i.test(text)) {
    return ko ? "작업 나누는 중" : "Splitting the work";
  }
  if (/^(?:TF 결과를 종합하는 중|Synthesizing task-force results)/i.test(text)) return ko ? "결과 정리하는 중" : "Pulling results together";
  if ((match = text.match(/^(.+?) · (?:입력 패킷 실행 중|running input packet)$/i))) {
    return ko ? `${label(match[1])} 작업 중` : `${label(match[1])} working`;
  }
  if ((match = text.match(/^(.+?) · (?:위임 계획 중|planning)$/i))) {
    return ko ? `${label(match[1])} 계획 중` : `${label(match[1])} planning`;
  }

  const cleaned = cleanSlugs(text, ctx);
  return cleaned || null;
}

/** 같은 줄이 이어서 반복되면 하나로 합친다(앞뒤 비교). */
export function collapseOwnerActivityLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) if (out.at(-1) !== line) out.push(line);
  return out;
}












export interface OwnerFailureInput {
  code?: string | null;
  reason?: string | null;
  nextAction?: string | null;
}

interface FailureSentence { ko: string; en: string }
interface KnownFailure { match: RegExp; reason: FailureSentence; action: FailureSentence }

const FAILURE_RETRY: FailureSentence = {
  ko: "[이 노드부터 재실행]을 눌러 다시 시도해 보세요.",
  en: "Try [Rerun from this node] again.",
};
const FAILURE_GENERIC_REASON: FailureSentence = {
  ko: "이 단계가 끝까지 진행되지 못했어요.",
  en: "This step could not finish.",
};

/** 위에서부터 먼저 맞는 항목을 쓴다. 코드는 문장 어디에 박혀 있어도(`NODE_FAILED: 코드`) 찾는다. */
const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    match: /invocation_chat_owned_by_other_run|invocation_chat_busy_other_host|invocation_chat_busy/i,
    reason: {
      ko: "이 대화를 다른 작업이 쓰고 있어서 이 단계를 시작하지 못했어요.",
      en: "Another task is using this chat, so this step could not start.",
    },
    action: {
      ko: "다른 작업이 끝난 뒤 [이 노드부터 재실행]을 눌러 주세요.",
      en: "Once the other task finishes, choose [Rerun from this node].",
    },
  },
  {
    match: /agent_context_original_invocation_owner_required|owner_required|liveness_unknown/i,
    reason: {
      ko: "이 단계를 처음 시작한 실행이 더는 확인되지 않아 이어가지 못했어요.",
      en: "The run that started this step can no longer be confirmed, so it could not continue.",
    },
    action: FAILURE_RETRY,
  },
  {
    

    match: /native_gui_activation_prerequisites_missing|native_gui_daemon_discovery_unavailable|supervisor_native_channel_unavailable/i,
    reason: {
      ko: "백그라운드 서비스와 다시 연결하는 중이었어요.",
      en: "The background service was reconnecting.",
    },
    action: {
      ko: "잠시 뒤 다시 시도해 주세요.",
      en: "Try again in a moment.",
    },
  },
  {
    match: /one_preflight_chat_pending/i,
    reason: {
      ko: "이 대화에서 앞 메시지가 아직 시작되는 중이었어요.",
      en: "An earlier message in this chat was still starting.",
    },
    action: {
      ko: "앞 메시지가 시작된 뒤 다시 시도해 주세요.",
      en: "Try again once the earlier message has started.",
    },
  },
  {
    match: /\bstore_busy\b|database is locked/i,
    reason: {
      ko: "앱 저장소가 잠시 바빴어요.",
      en: "The app's storage was briefly busy.",
    },
    action: {
      ko: "잠시 뒤 다시 시도해 주세요.",
      en: "Try again in a moment.",
    },
  },
  {
    match: /parent execution permission|permission_ceiling|read_only_ceiling/i,
    reason: {
      ko: "이 실행은 읽기만 허용돼 있어서, 무언가를 바꾸는 이 단계는 실행하지 않았어요.",
      en: "This run is read-only, so this step, which changes something, was not run.",
    },
    action: {
      ko: "쓰기가 허용된 실행에서 다시 시도해 주세요.",
      en: "Run it again from a run that is allowed to make changes.",
    },
  },
];

const HANGUL = /[가-힣]/;
/** snake_case 와 UPPER_SNAKE 기계 토큰(밑줄로 이어진 2토막 이상). 파일명 같은 점 표기는 건드리지 않는다. */
const MACHINE_TOKEN_RE = /(?<![\w가-힣])(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w가-힣])/g;

function known(text: string): KnownFailure | undefined {
  return KNOWN_FAILURES.find((entry) => entry.match.test(text));
}

/** 사용자 언어로 쓴 평문인가: 공백이 있고, `CODE: …` 꼴이 아니며, 한국어 UI면 한글이 있고 영어 UI면 한글이 없다. */
function isOwnerSentence(text: string, locale: OwnerActivityLocale): boolean {
  if (!/\s/.test(text)) return false;
  // 옛 실행기가 저장한 영어 개발자 문구("…in the background while independent branches continue.")는 사람 문장이 아니다.
  if (/\bin the background\b|\bindependent (?:branches|nodes?|node targets)\b/i.test(text)) return false;
  if (/^[A-Za-z0-9_.-]+\s*:/.test(text) && /[_.]/.test(text.split(":")[0])) return false;
  return locale === "ko" ? HANGUL.test(text) : !HANGUL.test(text);
}

function tidySentence(text: string): string {
  return text
    .replace(/\s*(?:원문|Original)\s*:.*$/is, "")
    .replace(MACHINE_TOKEN_RE, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function localized(sentence: FailureSentence, locale: OwnerActivityLocale): string {
  return locale === "ko" ? sentence.ko : sentence.en;
}

/** 알아볼 수 있는 사유만: 아는 코드의 문장 또는 사용자 언어의 평문. 못 알아보면 null(호출자가 자기 문구를 고른다). */
export function ownerFailureReasonOrNull(raw: string | null | undefined, locale: OwnerActivityLocale, code?: string | null): string | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  // "원문: …" 꼬리는 진단용이라 코드 판정에서 뺀다 — 안 그러면 "반영 여부 미확인" 같은 본문이 꼬리 코드에 덮인다.
  const head = text.replace(/\s*(?:원문|Original)\s*:.*$/is, "");
  const entry = known(head) ?? (head ? undefined : known(String(code ?? "")));
  if (entry) return localized(entry.reason, locale);
  // `MUTATION_UNVERIFIED: 문장` 처럼 코드가 앞에 붙은 줄은 코드를 떼고 문장만 본다.
  const body = text.replace(/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\s*:\s*/, "");
  if (body && isOwnerSentence(body, locale)) return tidySentence(body) || null;
  return null;
}

/** 실패 사유 한 줄을 오너 언어의 평문으로. 기계 코드·다른 언어 문장은 새지 않는다. */
export function ownerFailureReason(raw: string | null | undefined, locale: OwnerActivityLocale, code?: string | null): string {
  return ownerFailureReasonOrNull(raw, locale, code) ?? localized(FAILURE_GENERIC_REASON, locale);
}

/** 지금 할 수 있는 행동 한 줄. 다른 언어로 쓰였거나 코드뿐이면 아는 코드의 행동, 없으면 다시 실행 안내. */
export function ownerFailureNextAction(
  nextAction: string | null | undefined,
  locale: OwnerActivityLocale,
  context?: { reason?: string | null; code?: string | null },
): string {
  const entry = known(`${context?.reason ?? ""} ${context?.code ?? ""}`);
  const text = String(nextAction ?? "").replace(/\s+/g, " ").trim();
  // 아는 코드면 우리 행동 문장이 정본이다 — 실행기가 붙인 일반 안내("사유를 확인하고…")보다 구체적이다.
  if (entry) return localized(entry.action, locale);
  if (text && isOwnerSentence(text, locale)) {
    const tidy = tidySentence(text);
    if (tidy) return tidy;
  }
  return localized(FAILURE_RETRY, locale);
}

/** 노드 실패 `{code, reason, nextAction}` → 오너 문구. 기계 코드는 반환하지 않는다. */
export function ownerFailureText(
  failure: OwnerFailureInput,
  locale: OwnerActivityLocale,
): { reason: string; nextAction: string } {
  return {
    reason: ownerFailureReason(failure.reason || failure.code, locale, failure.code),
    nextAction: ownerFailureNextAction(failure.nextAction, locale, { reason: failure.reason, code: failure.code }),
  };
}
