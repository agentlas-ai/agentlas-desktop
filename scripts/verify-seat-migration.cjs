// v102 좌석 마이그레이션을 **실제 데이터로** 태워 본다.
//
// 왜 이 검사가 필요한가:
//   이 단계는 chats 를 재작성한다. SQLite 는 컬럼 제약을 제자리에서 못 바꾸므로 새 테이블을
//   만들고 옮기고 지운다. **되돌릴 수 없다.** 그리고 이 저장소의 chats 는 사다리를 지나며
//   열이 12개 더 붙었다 — 처음 쓴 마이그레이션은 기본 6개만 옮겨서 작업 폴더·하위 세션
//   사슬·고용 목록을 통째로 버렸다. 실제 사용자 DB 였으면 그대로 사라졌다.
//
//   그 사고를 잡은 것이 이 검사다. 소스를 읽는 대신 **컴파일된 코드를 그대로 태운다** —
//   시험용으로 고쳐 쓰면 시험한 것과 도는 것이 달라진다.
//
// 전제: npm run build:electron 이 끝나 dist/ 가 최신일 것.
// 실행: node scripts/verify-seat-migration.cjs

const { DatabaseSync } = require("node:sqlite");
// better-sqlite3 모양으로 감싸는 얇은 층 — 마이그레이션 코드를 **그대로** 태우기 위해서다.
// 코드를 시험용으로 고쳐 쓰면 시험한 것과 도는 것이 달라진다.
function Database(file) {
  const raw = new DatabaseSync(file);
  return {
    name: file,
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    prepare: (sql) => {
      const st = raw.prepare(sql);
      return {
        all: (...a) => st.all(...a),
        get: (...a) => st.get(...a),
        run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes ?? 0) }; },
      };
    },
    pragma: (text) => {
      const t = String(text).trim();
      // 설정형: name = value
      const set = /^([a-z_]+)\s*=\s*(.+)$/i.exec(t);
      if (set) { raw.exec(`PRAGMA ${set[1]} = ${set[2]}`); return []; }
      // 조회형: name 또는 name(arg) — 인자 있는 형태(table_info(chats))를 반드시 지원해야 한다.
      // 이걸 빠뜨리면 열 목록이 빈 채로 돌아 "열이 하나도 없는" SQL 이 만들어진다(실제로 당했다).
      return raw.prepare(`PRAGMA ${t}`).all();
    },
    transaction: (fn) => (...a) => { raw.exec("BEGIN"); try { const r = fn(...a); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
  };
}
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-mig-"));
const dbPath = path.join(dir, "test.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE installed_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE chats (
    id TEXT PRIMARY KEY, project_id TEXT, agent_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, working_folder TEXT,
    kind TEXT NOT NULL DEFAULT 'user', parent_chat_id TEXT,
    used_at TEXT, continuous_mode INTEGER NOT NULL DEFAULT 0,
    swarm_mode INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT,
    hired_agents TEXT, runtime_selection_json TEXT, origin_surface TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE);
  CREATE INDEX idx_chats_updated ON chats(updated_at DESC);
  CREATE INDEX idx_chats_project_updated ON chats(project_id, updated_at DESC);
  CREATE TABLE chat_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE);
  CREATE TABLE telegram_bindings (id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, telegram_chat_id TEXT,
    chat_session_id TEXT REFERENCES chats(id) ON DELETE SET NULL);
  PRAGMA user_version = 101;
  INSERT INTO projects VALUES ('p1','내 프로젝트');
  INSERT INTO installed_agents VALUES ('a1','연구원'), ('a2','작가');
  INSERT INTO chats (id,project_id,agent_id,title,created_at,updated_at,working_folder,kind,parent_chat_id,hired_agents) VALUES
    ('c1','p1','a1','리서치','2026-08-01T00:00:00Z','2026-08-10T00:00:00Z','/work/research','user',NULL,'["a2"]'),
    ('c2',NULL,'a1','추가 조사','2026-08-02T00:00:00Z','2026-08-11T00:00:00Z',NULL,'user',NULL,NULL),
    ('c3',NULL,'a1','하위 실행','2026-08-03T00:00:00Z','2026-08-03T00:00:00Z',NULL,'division','c1',NULL),
    ('c4',NULL,'a1','더 깊은 하위','2026-08-04T00:00:00Z','2026-08-04T00:00:00Z',NULL,'division','c3',NULL),
    ('c5',NULL,'a2','초안','2026-08-05T00:00:00Z','2026-08-12T00:00:00Z',NULL,'user',NULL,NULL);
  INSERT INTO chat_messages VALUES ('m1','c1','user','안녕'), ('m2','c5','user','초안 써줘');
  INSERT INTO telegram_bindings VALUES ('t1','one','room-1','c1');
`);

// ── 실제로 도는 코드(컴파일본)를 그대로 태운다 ──
// TS 소스를 손으로 고쳐 쓰면 시험한 것과 도는 것이 달라진다. dist 를 쓴다.
const src = fs.readFileSync("dist/electron/store/db.js", "utf8");
const start = src.indexOf("if (userVersion < 102) {");
if (start < 0) throw new Error("v102 블록을 컴파일본에서 찾지 못했습니다 — 먼저 npm run build:electron");
// 블록 끝은 괄호를 세어 찾는다. 문자열로 짚으면 같은 문구가 안에 또 나올 때 어긋난다.
let depth = 0, end = -1;
for (let k = src.indexOf("{", start); k < src.length; k += 1) {
  if (src[k] === "{") depth += 1;
  else if (src[k] === "}") { depth -= 1; if (depth === 0) { end = k + 1; break; } }
}
if (end < 0) throw new Error("v102 블록의 끝을 찾지 못했습니다");
let body = src.slice(start, end).replace(/_db!?\./g, "db.").replace(/\b_db\b/g, "db");
let backupPath = null;
// 실제로 나가는 SQL 을 보려고 exec 를 한 겹 감싼다.
const origExec = db.exec.bind(db);
db.exec = (sql) => { if (/CREATE TABLE chats_v102/.test(sql)) { console.log("--- 생성 SQL ---"); console.log(sql.split("\n").slice(0,26).join("\n")); console.log("--- 끝 ---"); } return origExec(sql); };
const run = new Function("db", "backupDatabaseFile", "userVersion", body);
// 마이그레이션이 던지면 **그것부터 실패**로 기록한다. 예외로 스크립트가 죽으면 아래 검사가
// 하나도 안 돌고, 그러면 "실패 0" 이 되어 통과처럼 보인다(2026-08-23 실측: 역검증이
// 그렇게 통과했다 — 검사가 잡은 게 아니라 스크립트가 죽은 것이었다).
let migrationError = null;
try {
  run(db, (d, tag) => { backupPath = path.join(dir, `backup-${tag}`); fs.copyFileSync(dbPath, backupPath); return backupPath; }, 101);
  db.pragma("user_version = 102");
} catch (error) {
  migrationError = error;
}

// ── 결과 검사 ──
const q = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get();
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail && !ok ? ` — ${detail}` : ""}`); if (!ok) fail += 1; };

check("★ 마이그레이션이 예외 없이 끝났다", migrationError === null, migrationError ? String(migrationError.message).slice(0, 120) : "");
if (migrationError) {
  // 여기서 멈춘다. 마이그레이션이 안 돌았으면 아래 검사는 전부 의미가 없고,
  // 그것들이 "통과" 로 찍히면 더 나쁘다.
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log("\n좌석 마이그레이션 FAILED (1) — 마이그레이션 자체가 실패했습니다");
  process.exit(1);
}
check("좌석이 봇 수만큼 생겼다", one("SELECT COUNT(*) n FROM one_seats").n === 2, `${one("SELECT COUNT(*) n FROM one_seats").n}개`);
check("점유자가 현재 점유로 들어갔다", one("SELECT COUNT(*) n FROM one_seat_occupants WHERE until IS NULL").n === 2);
check("표시 이름이 스냅샷으로 남았다", q("SELECT display_name FROM one_seat_occupants ORDER BY seat_id").map(r=>r.display_name).join(",") === "연구원,작가");
check("★ 대화가 하나도 안 사라졌다", one("SELECT COUNT(*) n FROM chats").n === 5, `${one("SELECT COUNT(*) n FROM chats").n}개`);
check("모든 user 대화에 좌석이 붙었다", one("SELECT COUNT(*) n FROM chats WHERE kind='user' AND seat_id IS NULL").n === 0);
check("★ 하위 세션이 뿌리 좌석을 물려받았다(2단계 사슬)", one("SELECT seat_id FROM chats WHERE id='c4'").seat_id === "seat_a1", String(one("SELECT seat_id FROM chats WHERE id='c4'").seat_id));
check("텔레그램 연결이 안 끊겼다", one("SELECT chat_session_id FROM telegram_bindings WHERE id='t1'").chat_session_id === "c1");
check("메시지가 안 사라졌다", one("SELECT COUNT(*) n FROM chat_messages").n === 2);
check("★ 뒤에 붙은 열이 살아남았다 (작업 폴더)", one("SELECT working_folder w FROM chats WHERE id='c1'").w === "/work/research", String(one("SELECT working_folder w FROM chats WHERE id='c1'").w));
check("★ 뒤에 붙은 열이 살아남았다 (고용 목록)", one("SELECT hired_agents h FROM chats WHERE id='c1'").h === '["a2"]');
check("열 개수가 유지됐다 (+seat_id)", q("PRAGMA table_info('chats')").length === 18, `${q("PRAGMA table_info('chats')").length}개`);
check("인덱스가 다시 만들어졌다", q("PRAGMA index_list('chats')").length >= 3, `${q("PRAGMA index_list('chats')").length}개`);
check("백업 파일이 생겼다", backupPath && fs.existsSync(backupPath));

// ★ 핵심: 봇을 지워도 대화가 남는가
db.pragma("foreign_keys = ON");
db.prepare("DELETE FROM installed_agents WHERE id='a1'").run();
check("★★ 봇을 지워도 대화가 남는다", one("SELECT COUNT(*) n FROM chats").n === 5, `${one("SELECT COUNT(*) n FROM chats").n}개 남음`);
check("★★ 좌석도 남는다", one("SELECT COUNT(*) n FROM one_seats").n === 2);
check("지워진 봇의 대화는 담당자가 비었다", one("SELECT agent_id FROM chats WHERE id='c1'").agent_id === null);
check("점유 이력의 이름은 남아 있다", one("SELECT display_name FROM one_seat_occupants WHERE seat_id='seat_a1'").display_name === "연구원");

// 유일 제약이 실제로 강제되는가
let blocked = false;
try {
  db.prepare("INSERT INTO one_seat_occupants (seat_id,slot,agent_id,display_name,since,until) VALUES ('seat_a2',0,'a1','또다른',datetime('now'),NULL)").run();
} catch { blocked = true; }
check("★ 한 자리에 두 점유자가 못 앉는다", blocked);

db.close(); fs.rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\n좌석 마이그레이션 PASS" : `\n좌석 마이그레이션 FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
