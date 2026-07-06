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

async function ensureChrome() {
  if (await portReady(PORT)) { log('CDP already up on', PORT); return; }
  const { userData, exe } = chromeInfo();
  if (!fs.existsSync(exe)) throw new Error('Google Chrome 실행 파일을 찾을 수 없습니다: ' + exe);
  // 신선 사본이 없거나 오래됐으면 실제 프로필 세션을 다시 심는다(로그인 최신 유지).
  seedProfile(userData, CDP_PROFILE);
  log('launching Chrome (copied profile) on port', PORT);
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
  throw new Error('Chrome CDP 포트가 열리지 않았습니다: ' + PORT);
}

async function main() {
  await ensureChrome();
  // @playwright/mcp 를 CDP 로 붙여 이 프로세스의 stdio 를 그대로 MCP 서버로 인계.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const mcp = spawn(npx, ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:' + PORT], { stdio: 'inherit' });
  mcp.on('error', (e) => { log('failed to start @playwright/mcp', String(e)); process.exit(1); });
  mcp.on('exit', (code) => process.exit(code == null ? 0 : code));
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
