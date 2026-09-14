"use strict";

/*
 * 과학 스킬 라이브러리 — **메뉴판을 프롬프트에 싣지 않는다.**
 *
 * 스킬 145개의 설명만 합쳐도 59,213자(영어 기준 약 15,000토큰)다. 그걸 매 턴 시스템 프롬프트에
 * 얹으면 연구 루프가 수십 턴 도는 동안 그 값이 계속 나간다. 오너 합격 조건 2번이 정확히 이것이다
 * — "툴서치는 토큰 낭비 없게 메뉴판을 적절하게 보내 준다".
 *
 * 그래서 데스크탑이 이미 쓰는 게으른 도구 메뉴(electron/runtime/tool-menu.ts: list → prepare →
 * call)와 같은 모양으로 간다. 노출하는 것은 도구 셋뿐이고, 본문(평균 13,700자)은 고른 하나만 읽는다.
 *
 *   find_scientific_skill  — 무엇을 하려는지 적으면 후보 몇 개만 (이름 + 한 줄)
 *   open_scientific_skill  — 고른 하나의 절차 전문
 *   list_scientific_skills — 이름만 훑기(페이지 단위). 전체를 봐야 할 때만.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const INDEX = require("../schemas/skill-index.json");
const PLUGIN_VERSION = require("../plugin.json").version;

class SkillError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** 검색어를 낱말로 쪼갠다. 식별자(CamelCase·snake_case)도 낱말로 본다. */
function terms(query) {
  return String(query || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9+.#-]+/)
    .filter((word) => word.length > 1);
}

/*
 * 흔한 낱말은 점수를 거의 못 준다.
 *
 * 처음엔 걸린 낱말 수만 셌더니 "compare two groups unequal variance" 에 networkx·matchms 가
 * 1·2등으로 나왔다(statistical-analysis 는 목록에 없었다). "compare"·"two"·"groups" 가 설명
 * 145개 중 수십 개에 들어 있어 **아무 스킬이나 점수를 받았기** 때문이다. 그래서 낱말마다
 * "몇 개 스킬에 나오는가"로 무게를 나눈다(희귀할수록 무겁다). 드문 낱말 하나가 흔한 낱말
 * 여럿을 이긴다 — 사람이 검색어에 담는 뜻도 대개 그 드문 낱말에 있다.
 */
const searchText = (skill) => `${skill.name} ${skill.description} ${(skill.keywords || []).join(" ")}`;

const documentFrequency = (() => {
  const counts = new Map();
  for (const skill of INDEX.skills) {
    const seen = new Set(terms(searchText(skill)));
    for (const word of seen) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return counts;
})();

function weight(word) {
  const seenIn = documentFrequency.get(word) || 0;
  if (seenIn === 0) return 0;
  // 절반 넘는 스킬에 나오는 낱말은 변별력이 없다.
  return Math.max(0, Math.log(INDEX.count / seenIn));
}

/*
 * 색인에는 설명뿐 아니라 **본문에서 뽑은 변별력 있는 낱말**(`keywords`)이 들어 있다.
 * 설명만 뒤졌을 때는 "compare two groups unequal variance" 에 statistical-analysis 가 아예
 * 안 나왔다 — Welch·t-test 같은 실제 방법 이름은 설명이 아니라 본문에 있기 때문이다.
 * 그 낱말들은 꾸릴 때 한 번 뽑아 색인 파일에 넣는다. 프롬프트에는 실리지 않는다.
 */
function score(skill, words) {
  const name = skill.name.toLowerCase();
  const nameWords = new Set(terms(skill.name));
  const description = skill.description.toLowerCase();
  const keywords = new Set(skill.keywords || []);
  let total = 0;
  for (const word of words) {
    const w = weight(word);
    if (w <= 0) continue;
    if (name === word) total += w * 10;
    else if (nameWords.has(word)) total += w * 6;
    else if (name.includes(word)) total += w * 3;
    if (keywords.has(word)) total += w * 2;
    if (description.includes(word)) total += w;
  }
  return total;
}

/** 한 줄 요약 — 설명 첫 문장만. 후보 목록이 다시 메뉴판이 되지 않게. */
function oneLine(description) {
  const first = String(description).split(/(?<=[.!?])\s/)[0] || description;
  return first.length > 180 ? `${first.slice(0, 177)}…` : first;
}

/*
 * 지금 있는 자리에 해당하는 절차만 돌려준다.
 *
 * 스킬 145개의 설명을 다 실으면 14,803토큰이고, 그걸 매 턴 프롬프트에 얹으면 연구 루프가
 * 수십 턴 도는 동안 계속 나간다. 그런데 **어디에 있는지는 앱이 이미 안다** — 어느 랩을 열었고
 * 하네스의 어느 단계인지. 그러니 AI 가 검색어를 잘 지어내야 찾아지는 구조로 만들 이유가 없다.
 * (검색어 방식은 실패했다: "compare two groups unequal variance" 에 networkx 가 1등으로 나왔다.)
 *
 * 랩 것은 랩에, 실험 설계·가설 수립·논문 작성처럼 랩과 무관한 공통 절차는 하네스 단계에 매단다.
 * 한 자리의 후보는 3~12개라 이름 한 줄씩이면 수백 자다.
 */
function skillsHere(input) {
    const lab = input && typeof input === "object" ? input.lab : null;
    const stage = input && typeof input === "object" ? input.stage : null;
    if (!lab && !stage) throw new SkillError("science-skill-place-required", "Give the lab you are in, the research stage you are at, or both.");
    const rows = INDEX.skills.filter((skill) =>
      (lab && (skill.labs || []).includes(lab)) || (stage && (skill.stages || []).includes(stage)));
    return {
      schema: "agentlas.science-skills-here/v1",
      lab: lab || null,
      stage: stage || null,
      procedures: rows.map((skill) => ({ name: skill.name, summary: oneLine(skill.description) })),
      note: rows.length
        ? "Open one with open_scientific_skill before you invent a method of your own."
        : "No established procedure is filed here. Proceed with your own method and say so plainly in the write-up.",
    };
}

function findSkill(input) {
  const query = input && typeof input === "object" ? input.query : null;
  if (typeof query !== "string" || !query.trim()) throw new SkillError("science-skill-query-required", "Describe what you are trying to do.");
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 15);
  const words = terms(query);
  const ranked = INDEX.skills
    .map((skill) => ({ skill, points: score(skill, words) }))
    .filter((row) => row.points > 0)
    .sort((left, right) => right.points - left.points || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit);
  return {
    schema: "agentlas.science-skill-search/v1",
    query,
    total: INDEX.count,
    matches: ranked.map(({ skill }) => ({
      name: skill.name,
      summary: oneLine(skill.description),
      requires: skill.requires,
      license: skill.license,
    })),
    // 0건일 때 조용히 빈 배열만 주면 모델은 "그런 건 없다"로 읽는다. 다음 행동을 준다.
    note: ranked.length
      ? "Open exactly one with open_scientific_skill to get its full procedure."
      : "No skill name or description matched those words. Try the method name (for example \"mixed model\", \"docking\", \"forest plot\"), or browse with list_scientific_skills.",
  };
}

function openSkill(input) {
  const name = input && typeof input === "object" ? input.name : null;
  if (typeof name !== "string" || !name.trim()) throw new SkillError("science-skill-name-required", "Give the exact name from find_scientific_skill.");
  const skill = INDEX.skills.find((row) => row.name === name.trim());
  if (!skill) throw new SkillError("science-skill-not-found", `No skill named "${name}". Use find_scientific_skill first.`);
  // 경로는 색인에서만 온다 — 입력 문자열을 경로로 쓰지 않는다.
  const file = path.join(ROOT, "skills", skill.dir, "SKILL.md");
  if (!fs.existsSync(file)) throw new SkillError("science-skill-body-missing", `The procedure file for "${name}" is not installed.`);
  const body = fs.readFileSync(file, "utf8");
  let references = [];
  const referenceDir = path.join(ROOT, "skills", skill.dir, "references");
  if (fs.existsSync(referenceDir)) {
    references = fs.readdirSync(referenceDir).filter((entry) => entry.endsWith(".md")).sort();
  }
  let scripts = [];
  const scriptDir = path.join(ROOT, "skills", skill.dir, "scripts");
  if (fs.existsSync(scriptDir)) scripts = fs.readdirSync(scriptDir).sort();
  return {
    schema: "agentlas.science-skill/v1",
    name: skill.name,
    license: skill.license,
    version: skill.version,
    requires: skill.requires,
    procedure: body,
    references,
    scripts,
    directory: path.join("skills", skill.dir),
  };
}

function listSkills(input) {
  const cursor = Math.max(Number(input && input.cursor) || 0, 0);
  const limit = Math.min(Math.max(Number(input && input.limit) || 40, 1), 80);
  const page = INDEX.skills.slice(cursor, cursor + limit);
  return {
    schema: "agentlas.science-skill-list/v1",
    total: INDEX.count,
    cursor,
    // 이름만 준다. 설명까지 주면 이 도구가 곧 메뉴판이 되어 버린다.
    names: page.map((skill) => skill.name),
    nextCursor: cursor + limit < INDEX.count ? cursor + limit : null,
  };
}

module.exports = { PLUGIN_VERSION, SkillError, skillsHere, findSkill, openSkill, listSkills, skillIndex: INDEX };
