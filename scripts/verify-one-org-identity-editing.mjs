// One Team 정체성(이름·캐릭터) 편집 계약 게이트.
//
// 오너 지적 2026-08-23:
//   ① 에이전트를 앉히면 캐릭터를 고를 수 없어 아이콘이 제멋대로 나온다.
//   ② 편집은 만들기와 다른 창이라 캐릭터를 바꿀 길이 아예 없다.
//   ③ 팀 패키지의 내부 역할이 낱개 에이전트로 목록에 풀려 나온다.
//
// 지키는 계약:
//   A. 만들기·좌석 배치·편집 세 입구가 **같은 아바타 해석 규칙**을 쓴다(한 곳에만 있으면 나머지가 어긋난다).
//   B. 편집은 만들기와 같은 창을 쓴다.
//   C. 좌석 후보에서 팀 구성원(parentTeamId)은 제외된다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── A. 아바타 규칙은 한 곳에서만 정해진다 ──────────────────────────────────
const org = read("electron/one/org.ts");
assert.match(org, /function resolveOneTeamAvatar\(/, "avatar resolution must live in one shared helper");
const callers = [...org.matchAll(/resolveOneTeamAvatar\(/g)].length;
assert.ok(callers >= 4, `create/seat/edit must all go through the shared helper (found ${callers} references incl. the definition)`);
// 좌석 배치가 고른 캐릭터를 실제로 쓰는지 — 예전에는 tone 을 그대로 박고 있었다.
assert.match(org, /const chosen = input\.avatar \? resolveOneTeamAvatar\(input\.avatar, agent\.id\) : null;/, "seating must honour the chosen character");
assert.match(org, /const icon = chosen\?\.icon \?\? agent\.tone \?\? "one-puppy";/, "with no chosen character the package's own face is the honest fallback");
// 편집이 아이콘과 업로드 사진을 함께 반영하는지.
assert.match(org, /UPDATE one_org_members[\s\S]{0,200}icon = \?/, "editing must be able to change the icon");
assert.match(org, /UPDATE installed_agents SET tone = \? WHERE id = \?/, "the same face must show outside the org chart too");

const shared = read("shared/one-org.ts");
for (const iface of ["AddOneOrgMemberInput", "UpdateOneOrgMemberInput"]) {
  const block = shared.slice(shared.indexOf(`export interface ${iface}`), shared.indexOf("}", shared.indexOf(`export interface ${iface}`)));
  assert.match(block, /avatar\?: OneTeamAgentAvatarInput;/, `${iface} must accept a character`);
}

// ── B. 편집은 만들기와 같은 창 ─────────────────────────────────────────────
const dialog = read("renderer/components/one/OneCreateAgentDialog.tsx");
assert.match(dialog, /export interface OneEditMemberTarget/, "the create dialog must expose an edit target");
assert.match(dialog, /const updateMember = async \(\)/, "the create dialog must be able to save an edit");
assert.match(dialog, /api\.oneOrg\.update\(/, "editing must go through oneOrg.update");
assert.match(dialog, /avatar:\s*selectedStyle[\s\S]{0,120}kind: "image", dataUrl: previewSrc!/, "an edit must send preset or uploaded image, same as create");

const shell = read("renderer/components/one/OneShell.tsx");
assert.match(shell, /edit=\{editMemberTarget\}/, "the shell must pass the edit target into the create dialog");
assert.match(shell, /onEditIdentity=\{\(member\)/, "the org chart's edit entry must open that dialog");

// ── C. 팀 구성원은 앉힐 후보가 아니다 ──────────────────────────────────────
const chart = read("renderer/components/one/OneOrgChart.tsx");
assert.match(chart, /if \(agent\.parentTeamId\) return false;/, "team member sub-agents must not be seatable on their own");
assert.match(chart, /replacementCandidates = installedAgents\.filter\(\(agent\) => !usedIds\.has\(agent\.id\) && !agent\.parentTeamId\)/, "the same rule must apply to replacements");
// ── D. 앉힐 때는 이름·캐릭터를 다시 묻지 않는다 (오너 지적 2026-08-25) ────────
//
// 2026-08-23 에는 이 자리에 "좌석 시트도 캐릭터 목록을 제공해야 한다"가 있었다. 그때의
// 진짜 결함은 "앉히면 얼굴을 못 바꾼다"였고, 그건 같은 수리에서 만든 편집 경로(B절:
// 조직도 행 편집 → 만들기 창)로 이미 해결됐다. 좌석 시트에까지 남겨 두니 방금 만들기
// 창에서 정한 이름·캐릭터를 한 화면 뒤에서 또 묻고, 그 칸들이 후보 목록을 눌러
// "고르라면서 고를 수 없는" 목록이 됐다. 그래서 계약을 뒤집는다.
assert.doesNotMatch(chart, /ONE_CHARACTER_OPTIONS/, "the seat sheet must not ask for a character again — the source package's face is the default and the edit dialog is where it changes");
assert.doesNotMatch(chart, /addCopy\.displayName/, "the seat sheet must not ask for a display name again — it arrives with the name it already has");
// 원본 그대로 앉는다는 것이 실제 호출로도 참이어야 한다(문구만 바꾸고 값을 계속 보내면 소용없다).
assert.match(chart, /await onAdd\(installed\.id, undefined, leaseExpiresAt, undefined\);/, "seating must send no name and no character so the source package's own identity is used");
// 바꿀 길은 반드시 남아 있어야 한다 — 묻지 않는 것과 못 바꾸는 것은 다르다.
assert.match(chart, /onEditIdentity\(member\); return;/, "the org chart row's edit entry must still open the create dialog to change name and character");
// "담당 교체"는 통합 편집 창으로 되돌리면 안 된다 — 되돌리면 같은 창이 다시 열려
// 누른 사람 입장에서는 아무 일도 일어나지 않는 죽은 버튼이 된다(2026-08-25 실측).
assert.match(chart, /sheetRequest\.kind !== "replace"/, "an explicit replace request must reach the replace sheet, not bounce back into the edit dialog");

// ── 죽은 경로 사본 합치기(같은 에이전트가 43개로 불어난 사고) ─────────────
const dedupe = read("electron/store/agent-dedupe.ts");
assert.match(dedupe, /dead-content:/, "copies whose source folder is gone must merge by content, not by a path that no longer exists");
assert.match(dedupe, /MIN_CONTENT_IDENTITY_PROMPT/, "content identity must require a substantial prompt so boilerplate cannot merge unrelated packages");

console.log("one-org identity editing PASS: one avatar rule for create/seat/edit, edit reuses the create dialog, team members are not seatable, dead-path copies merge");
