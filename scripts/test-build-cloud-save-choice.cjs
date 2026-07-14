#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const session = read("renderer/lib/build-session.ts");
const page = read("renderer/app/(shell)/build/page.tsx");
const dialog = read("renderer/components/build/CloudSaveChoiceDialog.tsx");
const css = read("renderer/app/globals.css");
const ipc = read("electron/ipc.ts");
const preload = read("electron/preload.ts");
const types = read("shared/types.ts");

function bodyOf(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : source.length;
  assert.ok(end > start, `missing boundary after ${signature}`);
  return source.slice(start, end);
}

// The offer exists only after a verified, durable local registration.
const registerBody = bodyOf(session, "async function performAutoRegister", "// ── 완료 신호");
const registeredAt = registerBody.indexOf("state.registered = true;");
const queuedAt = registerBody.indexOf("queueBuildCloudSaveChoice(workspace, readScope, generation);");
assert.ok(registeredAt >= 0 && queuedAt > registeredAt, "Cloud choice must follow durable local registration");
const queueBody = bodyOf(session, "function queueBuildCloudSaveChoice", "/** 빌드 완료 시");
assert.match(queueBody, /isCurrentRegistration\(generation, workspace\)/, "offer must be bound to the current Build generation");
assert.match(queueBody, /!state\.registered/, "offer must require local registration");
assert.match(queueBody, /buildScanDisposition\(state\.result\?\.securityScan\) !== "passed"/, "offer must require a passed scan");
assert.match(queueBody, /state\.cloudSaveChoice[\s\S]*?return;/, "one generation must queue at most one offer");

// Reset/cancel/new Build invalidate the old target. The upload claim then
// re-checks generation-derived identity, result path, registration, and scan.
assert.ok((session.match(/state\.cloudSaveChoice = null;/g) || []).length >= 3, "new Build, cancel, and reset must clear stale Cloud choices");
const beginBody = bodyOf(session, "export function beginBuildCloudSave", "/** A failed upload");
assert.match(beginBody, /choice\.id !== id/, "upload must claim the displayed choice token");
assert.match(beginBody, /state\.phase !== "done"/, "upload must reject an unfinished Build");
assert.match(beginBody, /!state\.registered/, "upload must reject an unregistered package");
assert.match(beginBody, /state\.result\?\.workspace !== choice\.workspace/, "upload must reject a stale result path");
assert.match(beginBody, /buildScanDisposition\(state\.result\.securityScan\) !== "passed"/, "upload must re-check security");
assert.match(beginBody, /return \{ folder: choice\.workspace, scope: choice\.readScope \};/, "upload must use the frozen choice payload");
const finishBody = bodyOf(session, "export function finishBuildCloudSave", "/** Local-only");
assert.match(finishBody, /saved \? "saved" : "presented"/, "failed Cloud save must retry the same choice without deleting local state");
const localBody = bodyOf(session, "export function chooseBuildLocalOnly", "/** 수동 재스캔");
assert.doesNotMatch(localBody, /ipc\(|publish\(|fetch\(/, "local-only must perform zero network/IPC calls");
assert.match(localBody, /choice\.status = "local-only"/, "local-only must record the explicit decision");

// Renderer adapter: owner-private Agent Cloud only, using the claimed package.
assert.match(page, /const claimed = beginBuildCloudSave\(choice\.id\);/, "page must atomically claim the current choice");
assert.match(page, /api\.cloudAgents\.saveBuiltPrivate\(\{[\s\S]*?folder: claimed\.folder,[\s\S]*?scope: claimed\.scope/, "Cloud option must use the narrow built-package adapter");
assert.match(page, /if \(!api\) throw new Error\("Desktop bridge unavailable"\)/, "missing IPC must fail visibly, never fake success");
assert.match(page, /res\.status !== "registered" \|\| !res\.registration/, "only a registered Cloud receipt can show success");
assert.match(page, /choice\.status === "uploading" \|\| cloudUploadInFlightRef\.current === choice\.id/, "rapid clicks must be single-flight per Build");
assert.match(page, /if \(finishBuildCloudSave\(choice\.id, true\)\)/, "a stale upload receipt must not update a newer Build UI");
assert.match(page, /if \(finishBuildCloudSave\(choice\.id, false\)\)/, "a stale upload failure must not update a newer Build UI");
assert.match(page, /로컬 패키지와 조직도 등록은 그대로 유지됩니다/, "failure copy must preserve local truth");
assert.doesNotMatch(page, /hephaestus\.publish\(\{[\s\S]{0,180}visibility: "private-link"/, "Build Cloud choice must not reopen generic native publish confirmation");

// Preload and Main expose no visibility/review/slug/notes/dry-run knobs. Main
// validates the exact frozen folder against the capability before packaging.
assert.match(preload, /saveBuiltPrivate: \(input\) => ipcRenderer\.invoke\("cloudAgents:saveBuiltPrivate", input\)/);
assert.match(types, /interface CloudAgentBuiltPrivateSaveRequest \{\s*folder: string;\s*scope: FsReadScope;\s*\}/);
assert.match(types, /saveBuiltPrivate: \(input: CloudAgentBuiltPrivateSaveRequest\) => Promise<CloudAgentPackageResult>/);
const builtPrivateHandler = bodyOf(ipc, 'ipcMain.handle("cloudAgents:saveBuiltPrivate"', "// Public Hub publication");
const senderGuardAt = builtPrivateHandler.indexOf("assertTrustedSitePublishIpcSender(event);");
const pathResolveAt = builtPrivateHandler.indexOf("resolveFsReadPath(input.folder, input.scope)");
const packageAt = builtPrivateHandler.indexOf("packageAndReviewCloudAgent({");
assert.ok(senderGuardAt >= 0 && pathResolveAt > senderGuardAt && packageAt > pathResolveAt, "trusted sender and Main path authority must precede packaging");
assert.match(builtPrivateHandler, /rootPath,[\s\S]*?visibility: "private-link",[\s\S]*?reviewMode: "static-only"/);
assert.doesNotMatch(builtPrivateHandler, /confirmUpload|hepPublish|input\.visibility|input\.reviewMode|\.\.\.input/, "narrow save must not show a native confirm or accept renderer policy overrides");

const localHandler = bodyOf(page, "const keepBuildLocalOnly", "const engineMissing");
assert.doesNotMatch(localHandler, /ipc\(|publish\(|fetch\(/, "local-only UI handler must perform zero network/IPC calls");
assert.match(localHandler, /네트워크 요청은 보내지 않았습니다/, "local-only receipt must be explicit");

const publicFollowup = bodyOf(page, '<div className="build-upload-choice">', "{resultDeliveryBlocked &&");
assert.match(publicFollowup, /uploadToPublicHub/, "public Hub must remain a separate result-card follow-up");
assert.match(publicFollowup, /허브 \(공개\)/, "public Hub boundary must be visible");
assert.doesNotMatch(publicFollowup, /private-link|Cloud에 올리기|로컬에만 저장/, "the result card must not add a third modal choice");
assert.equal((page.match(/visibility: "private-link"/g) || []).length, 0, "renderer must not own private visibility policy");
assert.equal((page.match(/visibility: "marketplace"/g) || []).length, 1, "Build page needs one separate public Hub adapter call");
assert.doesNotMatch(page, /이 Mac|this Mac/, "cross-platform UI must say this computer, not Mac");

// Accessible, non-ambiguous modal: two choices only. Escape safely keeps the
// already-created local package rather than uploading or silently publishing.
assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /aria-labelledby="build-cloud-choice-title"/);
assert.match(dialog, /localButtonRef\.current\?\.focus/, "initial focus must use the privacy-safe local-only choice");
assert.doesNotMatch(dialog, /setTimeout\(\(\) => cloudButtonRef\.current\?\.focus/, "an accidental Enter must never default to Cloud upload");
assert.match(dialog, /event\.key === "Escape"[\s\S]*?onLocalOnly\(\)/, "Escape must resolve to the safe local-only default");
assert.match(dialog, /event\.target === event\.currentTarget && !busy\) onLocalOnly\(\)/, "backdrop dismissal must resolve to local-only");
assert.equal((dialog.match(/<button/g) || []).length, 2, "dialog must expose exactly two buttons");
assert.match(dialog, /Cloud에 올리기/);
assert.match(dialog, /로컬에만 저장/);
assert.doesNotMatch(dialog, /visibility|marketplace|onHub|허브 업로드/, "dialog must never offer public Hub publishing");
assert.match(dialog, /호스팅 LLM 아님/);
assert.match(dialog, /다른 Desktop에서 복원·설치한 뒤, 그 Desktop에 연결된 Mobile이 호출/, "Mobile execution boundary must be accurate");
assert.match(dialog, /no network call/i, "English local-only copy must state the network boundary");

assert.match(css, /\.build-cloud-choice-backdrop[\s\S]*?position: fixed/);
assert.match(css, /\.build-cloud-choice-dialog[\s\S]*?border-radius: 24px/);
assert.match(css, /\.build-cloud-choice-option:focus-visible/, "keyboard focus must be visible");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "motion must have an accessible fallback");

console.log(JSON.stringify({ ok: true, checks: 56, surface: "desktop-build-cloud-save-choice" }, null, 2));
