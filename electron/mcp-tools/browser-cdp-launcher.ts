// Agentlas Browser (CDP) 플러그인 런처 소스.
//
// 범용 브라우저 MCP 플러그인 — 특정 사이트/계정과 무관하다. 사용자가 직접 로그인한 Agentlas
// 전용 Chrome 프로필을 원격 디버깅 포트로 띄우고, @playwright/mcp 를 그 인스턴스에 CDP 로 붙여
// 표준 브라우저 도구(navigate/click/type/snapshot/evaluate…)를 제공한다.
//
// 왜: Playwright 기본(신선/빈 프로필)은 많은 사이트의 봇/네트워크 보안에 하드 차단된다.
// 전용 프로필의 실제 Chrome 로그인 세션을 CDP로 재사용하면 신선한 임시 프로필보다 안정적이다.
//
// 개인정보는 플러그인 패키지에 절대 들어가지 않는다. 평소 쓰는 Chrome 프로필을 복사하지 않으며,
// 사용자가 전용 창에서 직접 로그인한 세션만 ~/.agentlas/chrome-cdp-profile 안에 남는다.
//
// 이 파일은 문자열 소스를 ~/.agentlas/agentlas-browser-cdp.mjs 로 물질화(materialize)한다.
// catalog 엔트리가 `node ~/.agentlas/agentlas-browser-cdp.mjs` 로 실행한다(의존성 0, 순수 node).
import fs from "node:fs";
import http from "node:http";
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

/** Agentlas 전용 CDP Chrome 소유 표식. 임의의 기존 9222 프로세스에 붙지 않기 위한 로컬 증거. */
export function browserCdpOwnerPath(): string {
  return path.join(browserCdpProfilePath(), ".agentlas-cdp-owner.json");
}

export function writeBrowserCdpOwner(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const file = browserCdpOwnerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ pid, port: browserCdpPort(), profile: path.resolve(browserCdpProfilePath()) }),
    { encoding: "utf8", mode: 0o600 },
  );
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

export function clearBrowserCdpOwner(pid: number): void {
  const file = browserCdpOwnerPath();
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (owner.pid === pid) fs.rmSync(file, { force: true });
  } catch {
    // 없거나 손상된 표식은 소유 증거가 아니므로 제거한다.
    try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
  }
}

export function browserCdpOwnerIsLive(): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(browserCdpOwnerPath(), "utf8")) as {
      pid?: number;
      port?: number;
      profile?: string;
    };
    if (
      !Number.isInteger(owner.pid) ||
      Number(owner.pid) <= 0 ||
      owner.port !== browserCdpPort() ||
      path.resolve(owner.profile ?? "") !== path.resolve(browserCdpProfilePath())
    ) return false;
    process.kill(Number(owner.pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function browserCdpPortReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: browserCdpPort(), path: "/json/version", timeout: 1200 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
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

/**
 * Materialized launcher and regression tests share one classifier source so
 * approval behavior cannot drift between the shipped script and its tests.
 */
export const BROWSER_APPROVAL_CLASSIFIER_SOURCE = String.raw`
const PAY_RE = /(checkout|\bpay(ment)?\b|purchase|\bbuy\b|\border\b|donate|subscrib|billing|credit\s*card|debit\s*card|card\s*number|cvv|cvc|결제|구매|주문|결재|카드)/i;
const SEND_RE = /(publish|\bpost\b|\bsend\b|submit|tweet|retweet|\bshare\b|reply|\bcomment\b|confirm|전송|게시|제출|답글|댓글|공유|보내|확인)/i;
const PUBLISH_RE = /(publish|\bpost\b|tweet|retweet|게시|공개)/i;
const DELETE_RE = /(delete|remove|destroy|unsubscribe|삭제|제거|탈퇴)/i;
const SUBMIT_KEY_RE = /(?:^|[+\s])(enter|return|numpadenter)(?:$|[+\s])/i;

function actionFromIntent(text, fallback = null) {
  if (PAY_RE.test(text)) return 'payment';
  if (DELETE_RE.test(text)) return 'delete';
  if (PUBLISH_RE.test(text)) return 'publish';
  if (SEND_RE.test(text)) return 'send';
  return fallback;
}

function intentText(name, args, currentUrl = '') {
  const input = args && typeof args === 'object' ? args : {};
  const parts = [currentUrl, input.element, input.target, input.name, input.label, input.url];
  if (name === 'browser_fill_form' && Array.isArray(input.fields)) {
    for (const field of input.fields) parts.push(field && field.name, field && field.type);
  }
  return parts.filter((value) => typeof value === 'string').join(' ').toLowerCase();
}

function classifyAction(name, args, currentUrl = '') {
  const input = args && typeof args === 'object' ? args : {};
  const intent = intentText(name, input, currentUrl);
  let allText = '';
  try { allText = JSON.stringify(input).toLowerCase(); } catch (e) { allText = ''; }

  if (name === 'browser_run_code' || name === 'browser_run_code_unsafe') return 'unsafe-code';

  const submitByType = name === 'browser_type' && input.submit === true;
  const submitByKey = name === 'browser_press_key' && SUBMIT_KEY_RE.test(String(input.key || ''));
  if (submitByType || submitByKey) return actionFromIntent(intent, 'send');

  if (name === 'browser_handle_dialog' && input.accept === true) {
    return actionFromIntent(intent, 'send');
  }

  // Filling payment credentials is gated before secrets are exposed to the page.
  // Ordinary text/form filling remains approval-free until an actual submit action.
  if (name === 'browser_type' || name === 'browser_fill' || name === 'browser_fill_form') {
    return PAY_RE.test(intent) ? 'payment' : null;
  }

  if (name === 'browser_navigate' || name === 'browser_navigate_back') {
    return PAY_RE.test(allText) ? 'payment' : null;
  }
  if (name === 'browser_click' || name === 'browser_file_upload') {
    return actionFromIntent(intent + ' ' + allText);
  }
  return null;
}
`;

/** CDP 현재 페이지와 명시적 navigate 목적지 중 승인 사이트로 쓸 권위 URL을 고르는 순수 헬퍼. */
export const BROWSER_APPROVAL_CONTEXT_SOURCE = String.raw`
function extractCdpPageUrl(pages) {
  if (!Array.isArray(pages)) return '';
  const candidates = pages.filter((page) => page && page.type === 'page' && typeof page.url === 'string');
  const active = candidates.find((page) => !/^(?:about:blank|chrome:\/\/newtab\/?|devtools:)/i.test(page.url));
  return String((active || candidates[0] || {}).url || '');
}

function approvalContextUrl(name, args, observedUrl) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'browser_navigate' && typeof input.url === 'string' && input.url.trim()) return input.url.trim();
  return typeof observedUrl === 'string' ? observedUrl.trim() : '';
}
`;

const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// Agentlas Browser (CDP) — 범용 엔진. Agentlas 전용 Chrome 프로필을 원격 디버깅 포트로 띄우고
// @playwright/mcp 를 CDP 로 붙여 MCP 브라우저 도구를 제공한다. 이 프로세스가 client ↔ @playwright/mcp
// 사이를 stdio 로 프록시하며 (1) 되돌릴 수 없는 행동 승인 게이트, (2) learn-and-replay 스킬 레이어를 얹는다.
// 의존성 0(순수 node). 개인 데이터는 로컬에서만 사용, 어디로도 전송하지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.env.AGENTLAS_CDP_PORT || 9222);
const CDP_PROFILE = process.env.AGENTLAS_CDP_PROFILE || path.join(os.homedir(), '.agentlas', 'chrome-cdp-profile');
const OWNER_FILE = path.join(CDP_PROFILE, '.agentlas-cdp-owner.json');
const HEADLESS = String(process.env.AGENTLAS_CDP_HEADLESS || '').toLowerCase() === '1';
const SKILLS_DIR = process.env.AGENTLAS_BROWSER_SKILLS_DIR || path.join(os.homedir(), '.agentlas', 'browser-skills');
const log = (...a) => console.error('[agentlas-browser]', ...a);

function chromeInfo() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const exes = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ];
    return { exe: exes.find(fs.existsSync) || exes[0] };
  }
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const exes = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return { exe: exes.find(fs.existsSync) || exes[0] };
  }
  const exes = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return { exe: exes.find(fs.existsSync) || exes[0] };
}

function portReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1200 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function writeOwner(pid) {
  fs.mkdirSync(path.dirname(OWNER_FILE), { recursive: true });
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid, port: PORT, profile: path.resolve(CDP_PROFILE) }), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(OWNER_FILE, 0o600); } catch (e) {}
}
function clearOwner(pid) {
  try { const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')); if (owner.pid === pid) fs.rmSync(OWNER_FILE, { force: true }); }
  catch (e) { try { fs.rmSync(OWNER_FILE, { force: true }); } catch (ignore) {} }
}
function ownedPortReady() {
  try {
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (owner.port !== PORT || path.resolve(owner.profile || '') !== path.resolve(CDP_PROFILE) || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    process.kill(owner.pid, 0);
    return true;
  } catch (e) { return false; }
}

async function ensureChrome() {
  if (await portReady(PORT)) {
    if (ownedPortReady()) { log('owned CDP already up on', PORT); return; }
    throw new Error('CDP port ' + PORT + ' is occupied by a browser not owned by the Agentlas dedicated profile. Close it or choose AGENTLAS_CDP_PORT.');
  }
  const { exe } = chromeInfo();
  if (!fs.existsSync(exe)) throw new Error('Google Chrome executable could not be found: ' + exe);
  // Never copy a live everyday-Chrome profile: SQLite/WAL files can be inconsistent while Chrome
  // is running, and copying cookies/password stores would violate the dedicated-profile boundary.
  // Users sign in directly in the Agentlas window; that dedicated profile is then reused as-is.
  fs.mkdirSync(CDP_PROFILE, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CDP_PROFILE, 0o700); } catch (e) {}
  log('using persistent Agentlas dedicated profile (no personal-profile import)');
  const args = [
    '--user-data-dir=' + CDP_PROFILE, '--remote-debugging-port=' + PORT,
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false',
    '--disable-session-crashed-bubble', '--disable-features=Translate',
  ];
  if (HEADLESS) args.push('--headless=new');
  args.push('about:blank');
  log('launching Chrome on port', PORT, HEADLESS ? '(headless)' : '');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  writeOwner(child.pid);
  child.once('exit', () => clearOwner(child.pid));
  child.unref();
  for (let i = 0; i < 40; i++) { if (await portReady(PORT)) { log('CDP ready'); return; } await new Promise((r) => setTimeout(r, 500)); }
  clearOwner(child.pid);
  throw new Error('Chrome CDP port did not open: ' + PORT);
}

// ── 승인 게이트 ──────────────────────────────────────────────────
${BROWSER_APPROVAL_CLASSIFIER_SOURCE}
${BROWSER_APPROVAL_CONTEXT_SOURCE}
function readCdpPageUrl() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/list', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { if (body.length < 1024 * 1024) body += chunk; });
      res.on('end', () => { try { resolve(extractCdpPageUrl(JSON.parse(body))); } catch (e) { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}
function readApprovalInfo() {
  try { const p = path.join(os.homedir(), '.agentlas', 'browser-approval.json'); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function requestApproval(site, actionType, summary) {
  return new Promise((resolve) => {
    const autonomy = process.env.AGENTLAS_BROWSER_AUTONOMY || 'gated';
    // trust는 일반 반복 작업만 무인 복구한다. 결제와 임의 코드는 환경값만으로
    // 승인할 수 없는 secure checkpoint이며 승인 UI/서버가 없으면 fail-closed다.
    const trustFallback = autonomy === 'trust' && actionType !== 'payment' && actionType !== 'unsafe-code';
    const info = readApprovalInfo();
    if (!info || !info.port) { log('no approver (app not running); autonomy=' + autonomy + ' action=' + actionType); return resolve(trustFallback ? 'approved' : 'denied'); }
    const payload = JSON.stringify({ site, actionType, summary });
    const req = http.request({ host: '127.0.0.1', port: info.port, path: '/approve', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'authorization': 'Bearer ' + info.token }, timeout: 125000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b).decision === 'approved' ? 'approved' : 'denied'); } catch (e) { resolve('denied'); } });
    });
    req.on('error', () => resolve(trustFallback ? 'approved' : 'denied'));
    req.on('timeout', () => { req.destroy(); resolve('denied'); });
    req.write(payload); req.end();
  });
}

// ── learn-and-replay 스킬 레이어 ─────────────────────────────────
// 재생/기록 대상 액션 툴(읽기 전용 snapshot/screenshot 등은 제외).
const RECORDABLE = new Set(['browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type', 'browser_fill', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover', 'browser_file_upload', 'browser_drag']);
const SKILL_TOOLS = [
  { name: 'browser_skill_list', description: 'List saved Agentlas browser skills (learned action sequences).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_skill_save', description: 'Save the actions performed so far in this session as a reusable skill. Use after successfully completing a task (e.g. an Instagram upload) so it can be replayed deterministically next time.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Skill name, e.g. "instagram-upload"' }, description: { type: 'string' } }, required: ['name'] } },
  { name: 'browser_skill_replay', description: 'Replay a previously saved skill by name — re-runs its recorded action sequence deterministically (no reasoning needed).', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];
function skillPath(name) { return path.join(SKILLS_DIR, String(name).replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'); }
function listSkills() { try { return fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (e) { return []; } }
function saveSkill(name, steps, description) {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const doc = { name, description: description || '', steps, savedAt: new Date().toISOString() };
  fs.writeFileSync(skillPath(name), JSON.stringify(doc, null, 2));
  return doc;
}
function loadSkill(name) { const p = skillPath(name); if (!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  await ensureChrome();
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(npx, ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:' + PORT], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => { log('failed to start @playwright/mcp', String(e)); process.exit(1); });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));

  const recording = [];            // 이 세션에서 성공한 액션 시퀀스
  const pending = new Map();       // client 원본 tools/call: id -> {name, args}
  const waiters = new Map();       // 내부(replay) tools/call: id -> resolve
  let currentUrl = '';
  let internalSeq = 0;
  const writeClient = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) {} };
  const forwardRaw = (line) => { try { child.stdin.write(line + '\n'); } catch (e) {} };

  // 승인 게이트 통과 여부 판정(공유). 통과=null, 거부=사유문자열.
  const gate = async (name, args) => {
    const observedUrl = await readCdpPageUrl();
    const contextUrl = approvalContextUrl(name, args, observedUrl);
    const actionType = classifyAction(name, args, contextUrl);
    if (!actionType) return null;
    // 민감 행동에서 현재 페이지를 확인할 수 없으면 stale currentUrl/권한 캐시로 진행하지 않는다.
    if (!contextUrl) { log('blocked sensitive action: CDP current page unavailable', name); return 'unverified-site'; }
    currentUrl = contextUrl;
    let site = ''; try { site = new URL(contextUrl).host; } catch (e) { site = ''; }
    if (!site) { log('blocked sensitive action: invalid approval URL', contextUrl); return 'unverified-site'; }
    const detail = actionType === 'unsafe-code'
      ? String(args.code || args.filename || name).slice(0, 240)
      : (args.element || args.url || args.key || name);
    const decision = await requestApproval(site, actionType, actionType + ': ' + detail);
    return decision === 'approved' ? null : actionType;
  };

  // 내부에서 child 에 tools/call 을 보내고 응답을 받는다(replay 용).
  const callChild = (name, args) => new Promise((resolve) => {
    const id = 'agx-' + (++internalSeq);
    waiters.set(id, resolve);
    forwardRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
  });

  const doReplay = async (name, replyId) => {
    const skill = loadSkill(name);
    if (!skill) { writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Skill not found: ' + name }], isError: true } }); return; }
    const results = [];
    for (const step of (skill.steps || [])) {
      const denied = await gate(step.name, step.arguments || {});
      if (denied) { results.push(step.name + ': BLOCKED(' + denied + ')'); writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replay stopped — ' + denied + ' action needs approval. Trust mode may continue ordinary actions, but payment and arbitrary code always require explicit approval.' }], isError: true } }); return; }
      if (step.name === 'browser_navigate' && step.arguments && step.arguments.url) currentUrl = String(step.arguments.url);
      const resp = await callChild(step.name, step.arguments || {});
      const isErr = resp && resp.result && resp.result.isError;
      results.push(step.name + (isErr ? ': error' : ': ok'));
      if (isErr) { writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replay failed at ' + step.name + '. The page may have changed — re-explore and re-save the skill.\n' + results.join('\n') }], isError: true } }); return; }
    }
    writeClient({ jsonrpc: '2.0', id: replyId, result: { content: [{ type: 'text', text: 'Replayed skill "' + name + '" (' + (skill.steps || []).length + ' steps):\n' + results.join('\n') }] } });
  };

  // client → child 방향
  const handleClientLine = (line) => {
    if (!line.trim()) { forwardRaw(line); return; }
    let msg; try { msg = JSON.parse(line); } catch (e) { forwardRaw(line); return; }
    if (msg && msg.method === 'tools/call' && msg.params) {
      const name = msg.params.name || '';
      const args = msg.params.arguments || {};
      // 스킬 툴은 로컬 처리(child 로 안 보냄).
      if (name === 'browser_skill_list') { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(listSkills()) }] } }); return; }
      if (name === 'browser_skill_save') {
        try { const doc = saveSkill(args.name, recording.slice(), args.description); writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Saved skill "' + doc.name + '" with ' + doc.steps.length + ' steps → ' + skillPath(doc.name) }] } }); }
        catch (e) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Save failed: ' + String(e) }], isError: true } }); }
        return;
      }
      if (name === 'browser_skill_replay') { doReplay(args.name, msg.id); return; }
      // 일반 액션: CDP의 실제 현재 페이지를 다시 읽은 뒤 승인 게이트 + 기록.
      const gateable = RECORDABLE.has(name) || name === 'browser_handle_dialog' || name === 'browser_run_code' || name === 'browser_run_code_unsafe';
      if (gateable) {
        gate(name, args).then((denied) => {
          if (denied) { writeClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'BLOCKED: The user did not approve this ' + denied + ' browser action.' }], isError: true } }); return; }
          if (name === 'browser_navigate' && args.url) currentUrl = String(args.url);
          if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
          forwardRaw(line);
        });
        return;
      }
      if (RECORDABLE.has(name)) pending.set(msg.id, { name, arguments: args });
    }
    forwardRaw(line);
  };

  // child → client 방향 (응답 가로채기: replay waiter / 기록 / tools/list 주입)
  const handleChildLine = (line) => {
    if (!line.trim()) { process.stdout.write(line + '\n'); return; }
    let msg; try { msg = JSON.parse(line); } catch (e) { process.stdout.write(line + '\n'); return; }
    // 내부 replay 응답 → waiter 로, client 로는 안 보냄.
    if (msg && typeof msg.id === 'string' && waiters.has(msg.id)) { const r = waiters.get(msg.id); waiters.delete(msg.id); r(msg); return; }
    // client 원본 액션 응답 → 성공 시 기록.
    if (msg && msg.id != null && pending.has(msg.id)) {
      const call = pending.get(msg.id); pending.delete(msg.id);
      const isErr = msg.result && msg.result.isError;
      if (!isErr && !msg.error) recording.push(call);
    }
    // tools/list 응답 → 스킬 툴 주입.
    if (msg && msg.result && Array.isArray(msg.result.tools)) {
      const have = new Set(msg.result.tools.map((t) => t.name));
      for (const st of SKILL_TOOLS) if (!have.has(st.name)) msg.result.tools.push(st);
      process.stdout.write(JSON.stringify(msg) + '\n'); return;
    }
    process.stdout.write(line + '\n');
  };

  let cbuf = '';
  child.stdout.on('data', (chunk) => {
    cbuf += chunk.toString('utf8'); let i;
    while ((i = cbuf.indexOf('\n')) >= 0) { const line = cbuf.slice(0, i); cbuf = cbuf.slice(i + 1); handleChildLine(line); }
  });
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString('utf8'); let idx;
    while ((idx = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, idx); buf = buf.slice(idx + 1); handleClientLine(line); }
  });
  process.stdin.on('end', () => { try { child.stdin.end(); } catch (e) {} });
}
main().catch((e) => { console.error('[agentlas-browser] fatal', e && e.stack || e); process.exit(1); });
`;

/** Regression-only source view; does not materialize or launch Chrome. */
export function browserCdpLauncherSourceForTest(): string {
  return LAUNCHER_SOURCE;
}

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
