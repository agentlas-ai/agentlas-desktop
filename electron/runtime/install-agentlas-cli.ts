// `agentlas` 터미널 CLI 설치 — VS Code `code` 명령 방식.
// 래퍼 스크립트를 PATH에 두고, 그 래퍼가 Agentlas의 Electron 바이너리를
// Electron-as-Node 모드로 실행해 cli/agentlas.cjs를 돌린다.
// (앱이 번들한 better-sqlite3 / keytar 네이티브 모듈을 그대로 사용)
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentUiLocale } from "../main";

export interface InstallCliResult {
  ok: boolean;
  path: string;
  message: string;
}

function cliScriptPath(): string {
  // 패키지: <app.asar>/cli/agentlas.cjs, dev: <project>/cli/agentlas.cjs
  return path.join(app.getAppPath(), "cli", "agentlas.cjs");
}

export function installAgentlasCli(locale: "ko" | "en" = currentUiLocale()): InstallCliResult {
  const ko = locale === "ko";
  const exec = process.execPath; // Agentlas Electron 바이너리
  const script = cliScriptPath();

  if (process.platform === "win32") {
    const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), "Agentlas", "bin");
    const target = path.join(dir, "agentlas.cmd");
    const wrapper = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exec}" "${script}" %*\r\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, wrapper, "utf8");
      const onPath = (process.env.PATH || "").split(path.delimiter).includes(dir);
      return {
        ok: true,
        path: target,
        message: ko
          ? (onPath ? `설치됨: ${target}` : `설치됨: ${target}\nPATH에 ${dir} 를 추가하세요.`)
          : (onPath ? `Installed: ${target}` : `Installed: ${target}\nAdd ${dir} to your PATH.`),
      };
    } catch (e) {
      return {
        ok: false,
        path: "",
        message: ko ? `설치 실패: ${(e as Error).message}` : `Install failed: ${(e as Error).message}`,
      };
    }
  }

  const wrapper = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exec}" "${script}" "$@"\n`;
  const candidates = ["/usr/local/bin/agentlas", path.join(os.homedir(), ".local", "bin", "agentlas")];
  for (const target of candidates) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, wrapper, { mode: 0o755 });
      fs.chmodSync(target, 0o755);
      const dir = path.dirname(target);
      const onPath = (process.env.PATH || "").split(path.delimiter).includes(dir);
      return {
        ok: true,
        path: target,
        message: ko
          ? (onPath ? `설치됨: ${target} — 터미널에서 'agentlas list'` : `설치됨: ${target}\nPATH에 ${dir} 를 추가한 뒤 'agentlas list'`)
          : (onPath ? `Installed: ${target} — run 'agentlas list' in a terminal` : `Installed: ${target}\nAdd ${dir} to your PATH, then run 'agentlas list'`),
      };
    } catch {
      // 다음 후보로
    }
  }
  return {
    ok: false,
    path: "",
    message: ko
      ? "자동 설치 실패(권한). 수동 설치:\n" +
        `sudo sh -c 'printf %s "${wrapper.replace(/"/g, '\\"')}" > /usr/local/bin/agentlas && chmod +x /usr/local/bin/agentlas'`
      : "Automatic install failed (permissions). Manual install:\n" +
        `sudo sh -c 'printf %s "${wrapper.replace(/"/g, '\\"')}" > /usr/local/bin/agentlas && chmod +x /usr/local/bin/agentlas'`,
  };
}
