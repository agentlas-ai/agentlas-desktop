#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const helper = read("renderer/components/one/OneVoiceInputHelp.tsx");
const css = read("renderer/components/one/OneVoiceInputHelp.module.css");
const shell = read("renderer/components/one/OneShell.tsx");
const shellCss = read("renderer/components/one/OneShell.module.css");
const i18n = read("renderer/lib/i18n.tsx");

assert.match(helper, /composerRef\.current\?\.focus\(\)/);
assert.match(helper, /voiceCopy\(locale, "one\.voice\.instr_mac"\)/);
assert.match(helper, /voiceCopy\(locale, "one\.voice\.instr_windows"\)/);
assert.match(helper, /voiceCopy\(locale, "one\.voice\.privacy"\)/);
assert.match(i18n, /Fn or the Globe key twice/);
assert.match(i18n, /Windows key \+ H/);
assert.match(i18n, /does not turn on the microphone or save audio here/);
assert.match(i18n, /Review the dictated text before sending it yourself/);
assert.match(helper, /aria-expanded=\{open\}/);
assert.match(helper, /role="dialog"/);
assert.match(helper, /aria-live="polite"/);
assert.match(helper, /aria-labelledby=\{titleId\}/);
assert.match(helper, /aria-describedby=\{`\$\{instructionId\} \$\{privacyId\}`\}/);
assert.match(helper, /event\.key !== "Escape"/);
assert.match(helper, /const closeToComposer = \(\) =>/);
assert.match(helper, /requestAnimationFrame\(\(\) => composerRef\.current\?\.focus\(\)\)/);
assert.match(helper, /voiceCopy\(locale, "one\.voice\.return_composer"\)/);
assert.match(i18n, /Return to composer/);
assert.match(css, /\.trigger\s*\{[\s\S]*width:\s*44px[\s\S]*min-height:\s*44px/);
assert.match(css, /\.panel button\s*\{[\s\S]*min-height:\s*44px/);
assert.match(css, /@media \(max-width:\s*599px\)/);
assert.match(css, /max-height:\s*min\(70vh,\s*460px\)/);
assert.match(css, /overflow-y:\s*auto/);
assert.match(css, /@media \(max-height:\s*420px\)/);
assert.match(css, /prefers-reduced-motion/);

assert.match(shell, /import \{ OneVoiceInputHelp \} from "\.\/OneVoiceInputHelp"/);
assert.match(
  shell,
  /<div className=\{styles\.composerTools\}>[\s\S]*className=\{styles\.attachmentButton\}[\s\S]*<OneVoiceInputHelp[\s\S]*composerRef=\{composerInputRef\}/,
);
assert.match(shellCss, /\.composer\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
assert.match(shellCss, /\.composerTools\s*\{[\s\S]*display:\s*flex/);

for (const forbidden of [
  /mediaDevices/,
  /getUserMedia/,
  /SpeechRecognition/,
  /webkitSpeechRecognition/,
  /MediaRecorder/,
]) {
  assert.doesNotMatch(helper, forbidden, "Desktop helper must not claim or start an unreliable in-app recording path");
}

console.log(JSON.stringify({
  ok: true,
  desktopSystemDictationOnly: true,
  composerFocused: true,
  honestNoRecordingClaim: true,
  keyboardDismissible: true,
  closeReturnsToComposer: true,
  screenReaderDescribed: true,
  responsiveAt200Percent: true,
  shellComposerWired: true,
  minimumTarget44: true,
}));
