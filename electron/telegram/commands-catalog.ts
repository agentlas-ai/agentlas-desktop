import type { TelegramConnectTargetKind } from "../../shared/types";

/**
 * 텔레그램 명령의 단일 진실.
 *
 * 이 한 파일이 세 소비자를 동시에 먹인다: setMyCommands 등록 목록, 디스패치 스위치,
 * /help 출력. 터미널 쪽이 손으로 관리하던 목록 4개가 서로 표류했던 사고를 되풀이하지
 * 않으려고 처음부터 한 곳으로 모았다(engine/ui/commands-catalog.cjs 머리말 참고).
 *
 * 불변식(게이트 test:telegram-command-surface 가 잠근다):
 *  - name 은 텔레그램 BotCommand 규칙 `[a-z0-9_]{1,32}` — **하이픈 불가**.
 *    그래서 `/hep-network` 는 등록할 수 없고 `hep_network` 로 등록한 뒤
 *    하이픈 표기는 aliases 로만 받는다.
 *  - aliases 는 절대 setMyCommands 로 나가지 않는다(등록 시 텔레그램이 거절한다).
 *  - handler 는 디스패치 case 와 1:1. 고아 case 도, 고아 handler 도 없어야 한다.
 *  - args 는 ASCII 정본, 한국어 힌트는 argsKo 에만. 한 칸에 두 언어를 섞지 않는다.
 *  - ko/en 설명은 3–256자(BotCommand.description 한도).
 */
export type TelegramCommandHandler =
  | "pairing"
  | "help"
  | "status"
  | "newChat"
  | "stopRun"
  | "writeTurn"
  | "projects"
  | "projectSet"
  | "projectSearch"
  | "graphs"
  | "graphSet"
  | "graphSearch"
  | "graphRunRequest"
  | "hepSearch"
  | "hepNetwork"
  | "hepStatus"
  | "reportsOn"
  | "reportsOff";

export type TelegramCommandGroup = "start" | "work" | "designate" | "network" | "settings";

export interface TelegramCommandEntry {
  /** BotCommand.command. `[a-z0-9_]{1,32}` 만 허용된다. */
  readonly name: string;
  /** 타이핑으로만 받는 별칭. 하이픈 허용, 등록 목록에는 절대 넣지 않는다. */
  readonly aliases?: readonly string[];
  readonly group: TelegramCommandGroup;
  /** false = 처리는 하되 텔레그램 메뉴에 노출하지 않는다(현재 `start` 하나). */
  readonly registered: boolean;
  /** 이 명령을 받는 바인딩 종류. 지정·hep 계열은 One 개념이라 레거시 포트엔 없다. */
  readonly targets: readonly TelegramConnectTargetKind[];
  readonly args: string;
  readonly argsKo?: string;
  readonly ko: string;
  readonly en: string;
  readonly handler: TelegramCommandHandler;
}

const ALL_TARGETS: readonly TelegramConnectTargetKind[] = ["agent", "firm", "one"];
const ONE_ONLY: readonly TelegramConnectTargetKind[] = ["one"];

export const TELEGRAM_COMMANDS: readonly TelegramCommandEntry[] = [
  {
    name: "start",
    group: "start",
    registered: false,
    targets: ALL_TARGETS,
    args: "<pairing token>",
    argsKo: "<페어링 토큰>",
    ko: "페어링 핸드셰이크 — 앱이 보냅니다. 직접 입력할 일은 없습니다.",
    en: "Pairing handshake sent by the app. You never need to type this.",
    handler: "pairing",
  },
  {
    name: "help",
    aliases: ["commands", "menu"],
    group: "start",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "쓸 수 있는 명령 전체 보기",
    en: "Show every command you can use here",
    handler: "help",
  },
  {
    name: "status",
    group: "start",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "연결 · 지정 프로젝트 · 지정 자동화 · 보고 설정 · 진행 중 작업",
    en: "Connection, designated project and automation, reports, and any run in progress",
    handler: "status",
  },
  {
    name: "new",
    aliases: ["reset"],
    group: "work",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "새 대화로 시작합니다. 지정한 프로젝트는 그대로 유지됩니다.",
    en: "Start a fresh conversation. Your designated project stays.",
    handler: "newChat",
  },
  {
    name: "stop",
    aliases: ["cancel"],
    group: "work",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "지금 진행 중인 작업을 중단합니다.",
    en: "Stop the run that is in progress.",
    handler: "stopRun",
  },
  {
    name: "write",
    group: "work",
    registered: true,
    targets: ONE_ONLY,
    args: "<request>",
    argsKo: "<요청>",
    ko: "이번 요청만 쓰기 권한으로 실행합니다(파일 생성·수정 허용).",
    en: "Run just this one request with write permission.",
    handler: "writeTurn",
  },
  {
    name: "projects",
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "",
    ko: "프로젝트 목록에서 골라 지정합니다.",
    en: "Pick a project from the list and designate it.",
    handler: "projects",
  },
  {
    name: "project",
    aliases: ["use_project"],
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "[<name>|off]",
    argsKo: "[<이름>|off]",
    ko: "프로젝트를 지정합니다. off 를 주면 지정을 해제합니다.",
    en: "Designate a project by name. Pass off to clear it.",
    handler: "projectSet",
  },
  {
    name: "project_search",
    aliases: ["project-search"],
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "<query>",
    argsKo: "<검색어>",
    ko: "이름 일부로 프로젝트를 찾아 지정합니다.",
    en: "Find a project by partial name and designate it.",
    handler: "projectSearch",
  },
  {
    name: "graphs",
    aliases: ["automations"],
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "",
    ko: "저장된 자동화 목록을 봅니다. 꺼진 자동화도 함께 보여줍니다.",
    en: "List saved automations, including the ones that are turned off.",
    handler: "graphs",
  },
  {
    name: "graph",
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "<name|id|off>",
    argsKo: "<이름|id|off>",
    ko: "자동화를 지정합니다. off 를 주면 지정을 해제합니다.",
    en: "Designate an automation. Pass off to clear it.",
    handler: "graphSet",
  },
  {
    name: "graph_search",
    aliases: ["graph-search"],
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "<query>",
    argsKo: "<검색어>",
    ko: "이름 일부로 자동화를 찾아 지정합니다.",
    en: "Find an automation by partial name and designate it.",
    handler: "graphSearch",
  },
  {
    name: "graph_run",
    aliases: ["graph-run"],
    group: "designate",
    registered: true,
    targets: ONE_ONLY,
    args: "[<name|id>]",
    argsKo: "[<이름|id>]",
    ko: "자동화 실행을 요청합니다. 요청은 대기열에 접수되고 Agentlas 가 실행합니다.",
    en: "Request an automation run. The request is queued and Agentlas runs it.",
    handler: "graphRunRequest",
  },
  {
    name: "hep_search",
    aliases: ["hep-search"],
    group: "network",
    registered: true,
    targets: ONE_ONLY,
    args: "<what you need>",
    argsKo: "<필요한 일>",
    ko: "Cloud · Hub 에이전트 후보를 검색만 합니다. 실행하지 않습니다.",
    en: "Search Cloud and Hub agent candidates only. Nothing runs.",
    handler: "hepSearch",
  },
  {
    name: "hep_network",
    aliases: ["hep-network"],
    group: "network",
    registered: true,
    targets: ONE_ONLY,
    args: "<request>",
    argsKo: "<요청>",
    ko: "Local · Cloud · Hub 를 아울러 임시 태스크포스를 편성합니다.",
    en: "Staff a task force across Local, Cloud and Hub inventory.",
    handler: "hepNetwork",
  },
  {
    name: "hep_status",
    aliases: ["hep-status"],
    group: "network",
    registered: true,
    targets: ONE_ONLY,
    args: "",
    ko: "이 컴퓨터의 에이전트 네트워크 상태를 봅니다.",
    en: "Show this machine's agent network status.",
    handler: "hepStatus",
  },
  {
    name: "reports_on",
    aliases: ["automation_on"],
    group: "settings",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "자동화가 끝나면 이 방으로 보고를 보냅니다.",
    en: "Send automation completion reports to this chat.",
    handler: "reportsOn",
  },
  {
    name: "reports_off",
    aliases: ["automation_off"],
    group: "settings",
    registered: true,
    targets: ALL_TARGETS,
    args: "",
    ko: "자동화 완료 보고를 이 방으로 보내지 않습니다.",
    en: "Stop sending automation completion reports to this chat.",
    handler: "reportsOff",
  },
];

export const TELEGRAM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/;

const BY_TOKEN = new Map<string, TelegramCommandEntry>();
for (const entry of TELEGRAM_COMMANDS) {
  BY_TOKEN.set(entry.name, entry);
  for (const alias of entry.aliases ?? []) BY_TOKEN.set(alias, entry);
}

/** 이름 또는 별칭으로 찾는다. 대소문자 무시, 앞의 `/` 는 호출부가 이미 떼고 넘긴다. */
export function findTelegramCommand(token: string): TelegramCommandEntry | null {
  return BY_TOKEN.get(token.trim().toLowerCase()) ?? null;
}

/** setMyCommands 로 나갈 목록. 이 바인딩 종류가 실제로 받는 명령만 광고한다. */
export function registrableTelegramCommands(
  targetKind: TelegramConnectTargetKind,
): TelegramCommandEntry[] {
  return TELEGRAM_COMMANDS.filter(
    (entry) => entry.registered && entry.targets.includes(targetKind),
  );
}

/** 이 명령이 이 바인딩에서 유효한가. 유효하지 않으면 호출부가 이유를 말해 준다. */
export function commandAppliesTo(
  entry: TelegramCommandEntry,
  targetKind: TelegramConnectTargetKind,
): boolean {
  return entry.targets.includes(targetKind);
}
