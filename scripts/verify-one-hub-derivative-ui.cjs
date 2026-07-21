#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const card = read("renderer/components/one/OneSuggestionCard.tsx");
const handoff = read("renderer/components/one/OneSuggestionReviewHandoff.tsx");
const handoffCss = read("renderer/components/one/OneSuggestionReviewHandoff.module.css");
const runtime = read("electron/one/hub-derivative.ts");
const suggestions = read("electron/one/suggestions.ts");
const preload = read("electron/preload.ts");
const ipc = read("electron/ipc.ts");
const sharedTypes = read("shared/types.ts");
const contract = read("shared/one-hub-derivative.ts");
const mobileContract = read("shared/one-mobile-suggestion.ts");
const mobileRuntime = read("electron/one/mobile-suggestions.ts");
const main = read("electron/main.ts");
const i18n = read("renderer/lib/i18n.tsx");

assert.match(card, /publicDerivativeReview:\s*true/, "Hub review must require the distinct explicit public-review choice");
assert.match(card, /suggestionCopy\(locale, "one\.sug\.hub\.box_strong"\)/);
assert.match(card, /suggestionCopy\(locale, "one\.sug\.hub\.box_span"\)/);
assert.match(card, /suggestionCopy\(locale, "one\.sug\.hub\.box_small"\)/);
assert.match(i18n, /Your files and memories stay out of the public draft|내 파일과 기억은 공개 초안에 넣지 않아요/, "candidate copy must disclose the zero-source-byte boundary in beginner language");
assert.match(i18n, /creates only a new public description and basic structure|공개 설명과 기본 구조만 새로 준비합니다/, "candidate copy must describe the generated-only draft truthfully without developer jargon");
assert.doesNotMatch(card, /allowlisted material|허용 목록만 복사/, "UI must not claim private source files were copied");
assert.match(i18n, /Publishing access, your right to publish, credit availability, and fees still need review|게시 권한·내가 올릴 권리·크레딧 기능·수수료는 아직 확인이 필요합니다/);
assert.doesNotMatch(card, /정본|canonical|스캐폴드|scaffold|Current Task|현재 Task|Asset ref|자산 참조/);

assert.match(handoff, /api\.oneHubDerivative\.getDraft\(parsed\.input\)/, "Work must hydrate the durable Main-owned draft");
assert.match(handoff, /isOneHubDerivativeDraft\(resolvedDraft\)/, "renderer must revalidate the closed draft contract");
assert.match(handoff, /\["entitlement",\s*"rights",\s*"economy",\s*"fee"\]/, "all four publish prerequisites must be shown");
assert.match(handoff, /reviewCopy\(locale, "one\.rev\.gate\.needs_review"\)/, "publish prerequisites must use the localized unresolved-state contract");
assert.match(i18n, /확인 필요|Needs review/, "publish prerequisites must remain visibly unresolved");
assert.match(handoff, /hubDraft\.includedFiles\.map/, "review must show the included-file side of the diff");
assert.match(handoff, /hubDraft\.excluded\.map/, "review must show excluded category counts without private filenames");
assert.match(handoff, /reviewCopy\(locale, "one\.rev\.hub\.not_published"\)/);
assert.match(handoff, /reviewCopy\(locale, "one\.rev\.hub\.publish_lock"\)/);
assert.match(i18n, /Not published|아직 게시 안 됨/);
assert.match(i18n, /Earnings are not guaranteed|수익은 보장되지 않습니다/);
assert.doesNotMatch(handoff, /정본|canonical|스캐폴드|scaffold|Current Task|현재 Task|Asset ref|자산 참조/);
assert.doesNotMatch(handoff, /oneHubDerivative\.(?:publish|register|upload|price)|Hub\.publish/, "review UI must expose no publish operation");
assert.match(handoffCss, /grid-template-columns:[^;]*repeat\(4/, "desktop must show the four unknown gates as a compact grid");
assert.match(handoffCss, /@media \(max-width:\s*760px\)/, "draft diff and gates must collapse for narrow/mobile Work surfaces");

assert.match(preload, /oneHubDerivative:\s*\{\s*getDraft:/, "preload must expose read-only draft hydration");
assert.doesNotMatch(preload, /oneHubDerivative:[\s\S]{0,220}(?:publish|register|upload|price):/, "preload must expose no Hub mutation");
assert.match(sharedTypes, /oneHubDerivative:\s*\{\s*getDraft:/, "renderer contract must be read-only");
assert.match(ipc, /oneHubDerivative:getDraft[\s\S]{0,500}getOneSuggestionReviewHandoff\(input\)[\s\S]{0,500}getOneHubDerivativeDraft\(input\)/,
  "Main must revalidate the canonical review handoff before returning local draft metadata");

assert.match(contract, /sourceAssetSource:\s*"agent-cloud"/, "draft must bind an Agent Cloud release, not a local-import fingerprint");
assert.match(contract, /source:\s*"generated"/, "v1 included files must be generated-only");
assert.match(runtime, /registrations\?\.\["owner-private"\]/, "runtime must require exact owner-private registration authority");
assert.match(runtime, /path-sha256-executable-v2/, "runtime must explicitly gate on portable v2 package hashing");
assert.match(runtime, /No private source file was copied into this draft/, "generated scaffold must disclose its source-copy boundary");
assert.match(runtime, /increment\("non_allowlisted"\)/, "scanner-clean source still stays excluded pending explicit per-file review");
assert.match(runtime, /publishAllowed:\s*false[\s\S]*publishingStarted:\s*false[\s\S]*revenueGuaranteed:\s*false/);
assert.doesNotMatch(runtime, /registerCloudAgent|packageAndReviewCloudAgent|getMarketSource|getCargoSource/, "draft preparation must not call Hub, Cloud registration, or package publishing");
assert.match(suggestions, /suggestion\.type === "hub_derivative" && input\.publicDerivativeReview !== true/, "the base mutation must also block state-only Hub acceptance");

assert.match(mobileContract, /entitlement:\s*"unknown"[\s\S]*rights:\s*"unknown"[\s\S]*economy:\s*"unknown"[\s\S]*fee:\s*"unknown"/);
assert.match(mobileContract, /publishAllowed:\s*false[\s\S]*revenueGuaranteed:\s*false/);
assert.match(mobileRuntime, /includedCategories:\s*\["generated_review_scaffold"\]/);
assert.doesNotMatch(mobileRuntime, /eligibilityVerified:\s*true|economy:\s*\{\s*available:\s*true/, "mobile must not claim live eligibility or economy");

assert.match(main, /reconcileOneHubDerivativeDraftStorage\(\)/, "normal Desktop startup must reconcile crash-window draft directories");
assert.match(runtime, /removedOrphans[\s\S]*removedTemps/, "reconciliation must cover both final orphans and staging temps");

console.log(JSON.stringify({
  ok: true,
  generatedOnly: true,
  ownerPrivateV2: true,
  unknownPublishGates: 4,
  publishSurface: false,
  restartReconciliation: true,
}));
