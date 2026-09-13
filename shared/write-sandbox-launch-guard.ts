/**
 * 쓰기 샌드박스 탈출 판별 — 순수 함수(훅과 게이트가 같은 판단을 쓴다).
 *
 * 실측(페르소나 루프 라운드 2 재시험, 2026-09-14): 쓰기 모드(작업 폴더 seatbelt) 실행 중 모델이 프로젝트에
 * `tools/launch_emulator.command` 를 만들고 `open` 으로 열었다. LaunchServices 가 터미널 앱을 샌드박스 밖에서 띄워
 * 그 안에서 에뮬레이터가 돌았다 — 사용자는 "파일 편집"만 허용했고 승격은 0건이었다. seatbelt 는 mach 서비스로
 * 바깥에 프로세스를 만드는 것을 막지 못하므로, 그런 경로로 가는 명령을 실행 전에 거부하고 승격 요청으로 돌린다.
 *
 * 무엇을 막나 — 샌드박스 밖 프로세스를 만드는 OS 런처·에이전트 계열:
 *   macOS: open, osascript(Terminal do script 등), launchctl, automator
 *   Linux: xdg-open, gio open, gnome-open, kde-open, exo-open, systemd-run
 *   Windows: start, explorer, rundll32, Start-Process, cmd /c start
 *   공통: crontab, at(예약), tmux·screen(바깥 서버에서 실행), .command/.scpt/.workflow 파일을 여는 것
 * 첫 낱말만 보면 `cd x && open a.command`, `nohup open …`, `bash -c "open …"` 을 놓치므로 셸 구분자로 쪼개고
 * 인터프리터 -c/-e 문자열은 안쪽까지 본다. 모델은 적대자가 아니다 — 목적은 우연한 탈출을 승격 질문으로 바꾸는 것.
 */
export interface LaunchEscape {
  /** 어떤 런처인가 — 사람에게 보여 주는 이름. */
  launcher: string;
  /** 걸린 조각(짧게). */
  segment: string;
}

const LAUNCHERS = new Set([
  "open", "osascript", "launchctl", "automator",
  "xdg-open", "gnome-open", "kde-open", "exo-open", "systemd-run",
  "start", "explorer", "explorer.exe", "rundll32", "rundll32.exe", "start-process",
  "crontab", "at", "tmux", "screen",
]);
const WRAPPERS = new Set(["sudo", "nohup", "exec", "command", "env", "time", "caffeinate", "setsid", "nice", "ionice", "builtin", "xargs"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "node", "perl", "ruby", "pwsh", "powershell", "powershell.exe", "cmd", "cmd.exe"]);
const SEGMENT_SPLIT = /\n|;|&&|\|\||\||\$\(|`|\(|\)|\{|\}/;
const LAUNCHER_FILE_RE = /\.(?:command|scpt|applescript|workflow|terminal)(?=$|[\s"'`;&|)])/i;

function baseName(token: string): string {
  const unquoted = token.replace(/^["']+|["']+$/g, "");
  const last = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return last.toLowerCase();
}

function scanSegment(segment: string, depth: number): LaunchEscape | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(baseName(tokens[i])) || /^-/.test(tokens[i]) && i > 0 && WRAPPERS.has(baseName(tokens[i - 1])))) i++;
  // 따옴표로 시작하는 조각은 문자열 인자다(`print('open')` 의 'open') — 명령이 아니다.
  if (!tokens[i] || /^["']/.test(tokens[i])) return null;
  const head = baseName(tokens[i]);
  if (LAUNCHERS.has(head)) {
    // `at` 와 `start` 는 흔한 낱말이라 인자가 있을 때만(예약·실행 형태) 막는다.
    if ((head === "at" || head === "start") && tokens.length <= i + 1) return null;
    return { launcher: head, segment: tokens.slice(i, i + 4).join(" ").slice(0, 80) };
  }
  if (head === "gio" && tokens[i + 1] === "open") return { launcher: "gio open", segment: tokens.slice(i, i + 4).join(" ").slice(0, 80) };
  if (INTERPRETERS.has(head) && depth < 2) {
    // 인터프리터에 문자열로 넘긴 명령(-c/-e/-Command)은 안쪽까지 본다.
    const rest = tokens.slice(i + 1).join(" ");
    const inner = rest.match(/(?:-c|-e|-Command|\/c|\/k)\s+(["']?)([\s\S]+)\1\s*$/i)?.[2] ?? "";
    if (inner) return classifyLaunchEscape(inner.replace(/\\(["'])/g, "$1"), depth + 1);
  }
  return null;
}

export function classifyLaunchEscape(command: string, depth = 0): LaunchEscape | null {
  const text = String(command ?? "");
  if (!text.trim()) return null;
  for (const segment of text.split(SEGMENT_SPLIT)) {
    const hit = scanSegment(segment, depth);
    if (hit) return hit;
  }
  // 런처 파일을 직접 실행하는 형태(`./x.command`, `sh x.command`)도 바깥으로 간다.
  const file = text.match(LAUNCHER_FILE_RE);
  if (file && /(^|[\s;&|(`])(?:\.\/|\/|~\/|sh\s|bash\s|zsh\s|source\s|\.\s)[^\s;&|]*\.(?:command|scpt|applescript|workflow|terminal)\b/i.test(text)) {
    return { launcher: `*${file[0]}`, segment: text.slice(Math.max(0, (file.index ?? 0) - 30), (file.index ?? 0) + file[0].length).trim().slice(0, 80) };
  }
  return null;
}

export const WRITE_SANDBOX_LAUNCH_DENIAL_CODE = "WRITE_SANDBOX_LAUNCH_OUTSIDE";

/** 훅이 CLI에 돌려주는 거절 사유 — 모델이 읽고 승격 표식을 내도록 다음 행동까지 적는다. */
export function launchEscapeDenialReason(escape: LaunchEscape, marker: string): string {
  return `${WRITE_SANDBOX_LAUNCH_DENIAL_CODE}: '${escape.launcher}' would start a process outside this run's write sandbox (${escape.segment}). `
    + `That is a permission boundary, not a bug: do not work around it with another launcher. `
    + `Say in one sentence what needs to run and why, then put exactly ${marker} on its own final line so the app can ask the user for full access.`;
}
