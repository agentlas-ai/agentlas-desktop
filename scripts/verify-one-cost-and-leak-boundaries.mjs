// 돈과 자원이 조용히 새지 않는가 — PRD §4.6 §4.26 §4.28 §4.30 §4.31 §4.32 §5.23 §5.24 §5.30 재발 방지.
//
// 이 게이트가 지키는 계약(구현 문장이 아니라 성질):
//   ① 유료 재시도에는 상한이 있고, 상한에 닿으면 사용자에게 보인다.
//   ② 이미 시작한(=이미 지불한) 실행은 "복구"가 아니라 "이어보기"다.
//   ③ 복구 이력은 프로세스가 아니라 원장이 안다(재시작해도 다시 나가지 않는다).
//   ④ 살아 있는 예약은 축출되지 않는다.
//   ⑤ 만료된 첨부가 그 제안을 영구히 막지 않는다.
//   ⑥ 비동기 시작에는 자물쇠가 있어 서버·타이머·감시가 참조를 잃지 않는다.
//   ⑦ 누적 기록에는 상한이 있고, 무변경이면 쓰지 않으며, 잠금은 나이로 풀린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ① 복구기 — 무한 유료 재시도 금지 + 조용한 실패 금지 + 실패한 방에서 이어가기
const recovery = read("renderer/components/OneRecoveryPlane.tsx");
assert.match(recovery, /RECOVERY_MAX_ATTEMPTS\s*=\s*\d+/, "recovery must cap paid retries");
assert.match(recovery, /queued\.attempts >= RECOVERY_MAX_ATTEMPTS/, "the cap must actually gate the retry path");
assert.match(recovery, /queueRef\.current\.shift\(\)[\s\S]{0,400}setNotice\(/, "an exhausted item must free the queue head and tell the user");
assert.doesNotMatch(recovery, /^\s*return null;\s*$/m, "recovery must be able to render a visible line, not only null");
assert.match(recovery, /RECOVERY_QUEUE_MAX/, "the recovery queue must be bounded");
assert.match(recovery, /queued\.detail\.chatId/, "recovery must continue in the conversation that failed");
assert.match(read("renderer/lib/one-operational-recovery.ts"), /chatId\?: string/, "the recovery detail must be able to carry its conversation");

// ② 이미 시작한 실행은 이어보기
const preflight = read("electron/one/team-preflight.ts");
assert.match(preflight, /alreadyStarted[\s\S]{0,300}team_started/, "a run proven started must become a started proposal, not a recovery request");
assert.doesNotMatch(
  preflight,
  /void \(deps\.hasRunReceipt \?\? hasInvocationRunReceipt\)\(record\.reservation\.runId\);/,
  "the start probe result must be used, not discarded",
);

// ③ 모바일 자동 복구 — 지속 이력 + 상한
const mobileRecovery = read("electron/one/mobile-auto-recovery.ts");
assert.match(mobileRecovery, /RECOVERY_ATTEMPT_HARD_MAX/, "mobile auto-recovery must have a hard attempt cap");
assert.match(mobileRecovery, /persistedAttempts\(envelope\.runId\)/, "the cap must survive a Desktop restart");
assert.match(mobileRecovery, /recordRecoveryAttempt\(/, "each paid attempt must be written to the durable ledger");

// ④ 살아 있는 예약은 밀려나지 않는다
assert.match(preflight, /const settled = appended\.filter\(\(item\) => !live\(item\)\)/, "proposal pruning must drop settled rows first");
assert.match(preflight, /const live = \(item: InternalOneTeamPreflight\): boolean =>[\s\S]{0,200}Boolean\(item\.reservation\)/, "a live reservation must be recognised before pruning");
assert.doesNotMatch(preflight, /state\.proposals = \[\.\.\.state\.proposals, record\]\.slice\(-MAX_PROPOSALS\);/, "insertion-order truncation must not come back");

// ⑤ 만료 첨부가 영구히 막지 않는다
const attachments = read("electron/one/attachments.ts");
assert.match(attachments, /teamProposalRequiresOneAttachments[\s\S]{0,400}candidate\.status !== "failed"/, "an expired attachment must not keep demanding itself");
assert.match(attachments, /teamProposalHasExpiredOneAttachments/, "the product must be able to say 'attach it again'");

// ⑥ 미리보기 시작 자물쇠
const livePreview = read("electron/app-factory/live-preview.ts");
assert.match(livePreview, /startingPreviews/, "concurrent preview starts must be de-duplicated");
assert.match(livePreview, /current\.status === "archived"[\s\S]{0,200}server\.close\(\)/, "a preview started for an archived app must close its server");

// ⑦ 누적 기록 상한 · 무변경 쓰기 금지 · 잠금 나이
assert.match(read("electron/one/value-closure.ts"), /\.slice\(-4_096\)/, "value closure evidence must be bounded");
assert.match(read("electron/one/improvement-proof.ts"), /\.slice\(-4_096\)/, "improvement proof evidence must be bounded");
const briefing = read("electron/one/briefing.ts");
assert.match(briefing, /BRIEFING_LOCK_STALE_MS/, "a crashed process must not lock briefing state forever");
assert.match(briefing, /if \(JSON\.stringify\(state\) === before\) return state;/, "an unchanged briefing state must not be rewritten");

// 정렬 번호는 트랜잭션 안에서
const org = read("electron/one/org.ts");
assert.match(org, /db\.transaction\(\(\) => \{\s*\n\s*sortOrder = activeRows\(\)/, "sort order must be computed inside the transaction");

// ⑧ 팀 제안은 막다른 길을 만들지 않는다(PRD §4.14).
const shell = read("renderer/components/one/OneShell.tsx");
assert.match(shell, /teamPreflightExpired/, "expiry must be judged in the view, not only when the store is read");
assert.match(shell, /teamPreflight\.status === "cancelled"[\s\S]{0,400}팀 제안이 만료됐습니다/, "every terminal proposal state needs a card and a next action");
assert.match(shell, /위 제안에 먼저 답해 주세요|The earlier team proposal expired/, "a plain message typed while a proposal is open must not be silently dropped");

// ⑨ 산출물 바인딩 표는 마이그레이션 사다리 안에서 만들어지고 보존 규칙이 있다(PRD §5.25).
const db = read("electron/store/db.ts");
assert.match(db, /CREATE TABLE IF NOT EXISTS one_artifact_bindings/, "the binding table must be created by the migration ladder so the schema gate can see it");
assert.match(db, /DELETE FROM one_artifact_bindings[\s\S]{0,200}-90 days/, "the binding table must have a retention rule");

console.log("one cost/leak boundaries PASS: retry caps, resume-not-rerun, durable recovery ledger, live reservations, expiry exit, preview lock, bounded ledgers");
