// Agentlas Browser (CDP) 플러그인 런처 소스.
//
// 범용 브라우저 MCP 플러그인 — 특정 사이트/계정과 무관하다. 사용자의 "실제 로그인된 Chrome"
// 프로필을 별도 사본으로 복사해 원격 디버깅 포트로 띄우고, @playwright/mcp 를 그 인스턴스에
// CDP 로 붙여 표준 브라우저 도구(navigate/click/type/snapshot/evaluate…)를 제공한다.
//
// 왜: Playwright 기본(신선/빈 프로필)은 많은 사이트의 봇/네트워크 보안에 하드 차단된다.
// 실제 로그인 프로필로 CDP attach 하면 사람이 쓰던 세션 그대로라 차단되지 않는다.
//
// 개인정보는 플러그인 패키지에 절대 들어가지 않는다 — 쿠키/프로필 복사는 100% 사용자 머신
// 로컬에서 런타임에만 일어나고, 사본은 ~/.agentlas/chrome-cdp-profile 안에만 존재한다.
//
// 이 파일은 문자열 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 물질화(materialize)한다.
// catalog 엔트리가 `node ~/.agentlas/agentlas-browser-cdp.mjs` 로 실행한다(의존성 0, 순수 node).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BROWSER_CDP_LAUNCHER_BASENAME = "agentlas-browser-cdp.mjs";

/** ~/.agentlas/agentlas-browser-cdp.mjs 절대 경로. */
export function browserCdpLauncherPath(): string {
  return path.join(os.homedir(), ".agentlas", BROWSER_CDP_LAUNCHER_BASENAME);
}

/** 전용 CDP 크롬 프로필 경로(MCP 런처와 로그인 창이 공유). */
export function browserCdpProfilePath(): string {
  return process.env.AGENTLAS_CDP_PROFILE || path.join(os.homedir(), ".agentlas", "chrome-cdp-profile");
}

/** 기본 CDP 포트(MCP 런처와 동일 기본값). */
export function browserCdpPort(): number {
  return Number(process.env.AGENTLAS_CDP_PORT || 9222);
}

/** 플랫폼별 Chrome 실행 파일 경로 해석(없으면 null). Edge 폴백 포함. */
export function resolveChromeExe(): string | null {
  const home = os.homedir();
  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  } else if (process.platform === "win32") {
    const lad = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pfx = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    candidates = [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pfx, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  } else {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    ];
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// Agentlas Browser (CDP) — 범용. 실제 로그인 Chrome 프로필 사본을 원격 디버깅 포트로 띄우고
// @playwright/mcp 를 CDP 로 붙여 MCP 브라우저 도구를 제공한다. 특정 사이트/계정 하드코딩 없음.
// 의존성 0 (순수 node). 개인 데이터는 로컬에서만 사용, 어디로도 전송하지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.env.AGENTLAS_CDP_PORT || 9222);
const CDP_PROFILE = process.env.AGENTLAS_CDP_PROFILE || path.join(os.homedir(), '.agentlas', 'chrome-cdp-profile');
const log = (...a) => console.error('[agentlas-browser]', ...a);

function chromeInfo() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const exes = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
    return { userData: path.join(home, 'Library/Application Support/Google/Chrome'), exe: exes.find(fs.existsSync) || exes[0] };
  }
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exes = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return { userData: path.join(lad, 'Google', 'Chrome', 'User Data'), exe: exes.find(fs.existsSync) || exes[0] };
  }
  const exes = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return { userData: path.join(home, '.config', 'google-chrome'), exe: exes.find(fs.existsSync) || exes[0] };
}

// 실제 로그인 프로필의 세션 파일만 사본으로 복사(범용 — 어떤 사이트든 로그인 유지). best-effort.
// 쿠키는 OS 자격저장소(mac Keychain / win DPAPI / linux keyring) 키로 복호화되며, 그 키는
// 같은 OS 사용자에게 프로필-무관하게 공유되므로 사본에서도 복호화된다. (win Chrome v127+
// app-bound 암호화면 일부 쿠키 복호화가 안 될 수 있음 — 그 경우 사용자가 사본 프로필에 1회 로그인.)
function seedProfile(srcUserData, dst) {
  try {
    fs.mkdirSync(path.join(dst, 'Default'), { recursive: true });
    const rels = [
      'Local State',
      'Default/Cookies', 'Default/Network/Cookies',
      'Default/Login Data', 'Default/Web Data', 'Default/Preferences',
    ];
    for (const rel of rels) {
      const s = path.join(srcUserData, ...rel.split('/'));
      const d = path.join(dst, ...rel.split('/'));
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        try { fs.copyFileSync(s, d); } catch (e) { log('copy skip', rel, String(e)); }
      }
    }
  } catch (e) { log('seedProfile failed', String(e)); }
}

function portReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 전용 프로필이 이미 초기화됐는지(사용자가 여기 직접 로그인했을 수 있음).
function profileSeeded(dst) {
  return fs.existsSync(path.join(dst, 'Default', 'Cookies'))
    || fs.existsSync(path.join(dst, 'Default', 'Network', 'Cookies'));
}

async function ensureChrome() {
  if (await portReady(PORT)) { log('CDP already up on', PORT); return; }
  const { userData, exe } = chromeInfo();
  if (!fs.existsSync(exe)) throw new Error('Google Chrome executable could not be found: ' + exe);
  // 전용 프로필은 영속이다. 매 실행마다 실프로필을 덮으면 사용자가 Browser 메뉴에서 직접
  // 로그인한 세션이 날아가므로, 시드는 (a) 전용 프로필이 비어있는 최초 1회이거나
  // (b) AGENTLAS_CDP_SEED=1 로 명시적으로 "내 크롬 로그인 가져오기"를 요청했을 때만 한다.
  const force = process.env.AGENTLAS_CDP_SEED === '1';
  if (force || !profileSeeded(CDP_PROFILE)) {
    log(force ? 'seeding profile (forced import)' : 'seeding profile (first run)');
    seedProfile(userData, CDP_PROFILE);
  } else {
    log('reusing persistent dedicated profile (no reseed)');
  }
  log('launching Chrome on port', PORT);
  const child = spawn(exe, [
    '--user-data-dir=' + CDP_PROFILE,
    '--remote-debugging-port=' + PORT,
    '--no-first-run', '--no-default-browser-check',
    '--restore-last-session=false', '--disable-session-crashed-bubble',
    '--disable-features=Translate',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await portReady(PORT)) { log('CDP ready'); return; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('Chrome CDP port did not open: ' + PORT);
}

// ── 승인 게이트 (되돌릴 수 없는 행동 인터셉트) ────────────────────
// @playwright/mcp 는 이 프로세스가 stdio 로 프록시한다. client(런타임)→child 방향의 JSON-RPC
// 'tools/call' 중 전송/게시/결제/삭제로 보이는 것을 앱의 승인 서버로 게이트한다.
const PAY_RE = /(checkout|\bpay(ment)?\b|purchase|\bbuy\b|\border\b|donate|subscrib|billing|결제|구매|주문|결재)/;
const SEND_RE = /(publish|\bpost\b|\bsend\b|submit|tweet|retweet|\bshare\b|reply|\bcomment\b|delete|remove|confirm|전송|게시|삭제|제출|답글|댓글|공유|보내)/;

function classifyAction(name, args) {
  let text = '';
  try { text = JSON.stringify(args || {}).toLowerCase(); } catch (e) { text = ''; }
  if (name === 'browser_navigate' || name === 'browser_navigate_back') {
    return PAY_RE.test(text) ? 'payment' : null;
  }
  if (name === 'browser_click' || name === 'browser_file_upload' || name === 'browser_press_key') {
    if (PAY_RE.test(text)) return 'payment';
    if (SEND_RE.test(text)) {
      if (/publish|\bpost\b|게시/.test(text)) return 'publish';
      if (/delete|remove|삭제/.test(text)) return 'delete';
      return 'send';
    }
  }
  return null;
}

function readApprovalInfo() {
  try {
    const p = path.join(os.homedir(), '.agentlas', 'browser-approval.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

// 승인 서버(앱)에 물어본다. 앱 미실행이면 autonomy 정책: 기본 'gated'(거부), 'trust'면 허용.
function requestApproval(site, actionType, summary) {
  return new Promise((resolve) => {
    const autonomy = process.env.AGENTLAS_BROWSER_AUTONOMY || 'gated';
    const info = readApprovalInfo();
    if (!info || !info.port) {
      log('no approver (app not running); autonomy=' + autonomy + ' action=' + actionType);
      return resolve(autonomy === 'trust' ? 'approved' : 'denied');
    }
    const payload = JSON.stringify({ site: site, actionType: actionType, summary: summary });
    const req = http.request({
      host: '127.0.0.1', port: info.port, path: '/approve', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'authorization': 'Bearer ' + info.token },
      timeout: 125000,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b).decision === 'approved' ? 'approved' : 'denied'); }
        catch (e) { resolve('denied'); }
      });
    });
    req.on('error', () => resolve(autonomy === 'trust' ? 'approved' : 'denied'));
    req.on('timeout', () => { req.destroy(); resolve('denied'); });
    req.write(payload); req.end();
  });
}

async function main() {
  await ensureChrome();
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  // child stdio: client(우리) ↔ child 를 우리가 중계. stderr 는 그대로 흘려보낸다.
  const child = spawn(npx, ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:' + PORT], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => { log('failed to start @playwright/mcp', String(e)); process.exit(1); });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  // server→client(응답)은 그대로 통과.
  child.stdout.pipe(process.stdout);

  let currentUrl = '';
  let buf = '';
  const forward = (line) => { try { child.stdin.write(line + '\n'); } catch (e) {} };
  const denyResponse = (id, actionType) => {
    // 승인 거부를 JSON-RPC tool 결과(isError)로 client 에 돌려준다 — 행동은 실행하지 않는다.
    const msg = { jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: 'BLOCKED: The user did not approve this ' + actionType + ' browser action. Do not perform this action; move to a safe next step.' }], isError: true } };
    try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) {}
  };

  const handleLine = (line) => {
    if (!line.trim()) { forward(line); return; }
    let msg;
    try { msg = JSON.parse(line); } catch (e) { forward(line); return; }
    if (msg && msg.method === 'tools/call' && msg.params) {
      const name = msg.params.name || '';
      const args = msg.params.arguments || {};
      if (name === 'browser_navigate' && args.url) currentUrl = String(args.url);
      const actionType = classifyAction(name, args);
      if (actionType) {
        let site = '';
        try { site = new URL(currentUrl).host; } catch (e) { site = currentUrl; }
        const summary = actionType + ': ' + (args.element || args.url || name);
        log('gating ' + actionType + ' on ' + (site || '(unknown)'));
        requestApproval(site, actionType, summary).then((decision) => {
          if (decision === 'approved') forward(line);
          else denyResponse(msg.id, actionType);
        });
        return;
      }
    }
    forward(line);
  };

  process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  process.stdin.on('end', () => { try { child.stdin.end(); } catch (e) {} });
}
main().catch((e) => { console.error('[agentlas-browser] fatal', e && e.stack || e); process.exit(1); });
`;

/**
 * 런처 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 쓴다(멱등, 내용 바뀌면 갱신).
 * ensureDefaultMcpPluginsInstalled 에서 부팅 시 호출.
 */
export function materializeBrowserCdpLauncher(): string {
  const dest = browserCdpLauncherPath();
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (existing !== LAUNCHER_SOURCE) fs.writeFileSync(dest, LAUNCHER_SOURCE, "utf8");
  } catch (err) {
    console.error("[agentlas-browser] materialize failed:", err);
  }
  return dest;
}
