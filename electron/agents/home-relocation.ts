// "이 옛 경로의 폴더는 어디로 옮겨졌나" — 폴더 이동(home-move.ts)이 새 폴더에 남긴 출처 표식(`.agentlas-local/origin.json`)을 읽는 순수 함수.
// Electron·DB 를 가져오지 않는다(업데이트 연속성 검사가 워커 프로세스에서 읽는다). 아무것도 쓰지 않는다.
import fs from "node:fs";
import path from "node:path";
import { agentHomeRoot } from "./home";

export interface MovedFolder {
  /** 지금 폴더(에이전트 루트 안). */
  folder: string;
  /** 옮기기 전 폴더. */
  from: string;
}

/** 에이전트 루트 안에서 "옮겨졌다"고 적힌 폴더 전부. 루트가 없거나 못 읽으면 빈 목록. */
export function movedFolders(root: string = agentHomeRoot()): MovedFolder[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const found: MovedFolder[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const folder = path.join(root, name);
    try {
      const origin = JSON.parse(fs.readFileSync(path.join(folder, ".agentlas-local", "origin.json"), "utf8").replace(/^﻿/, "")) as { kind?: unknown; from?: unknown };
      if (origin?.kind === "moved" && typeof origin.from === "string" && path.isAbsolute(origin.from)) found.push({ folder, from: path.resolve(origin.from) });
    } catch { /* no marker: not a moved folder */ }
  }
  return found;
}

function underFolder(root: string, target: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

/**
 * 옛 경로가 가리키던 곳의 지금 경로. 옛 경로가 옮겨진 폴더(또는 그 안쪽)였으면 새 경로, 아니면 null.
 * 옛 경로에 지금도 무언가 있으면(예: 옛 엔진 플러그인이 같은 자리에 다시 만들었다) 옮겨진 것으로 보지 않는다 — 호출자가 그 경우를 따로 판단한다.
 */
export function relocatedPath(oldPath: string, moved: readonly MovedFolder[] = movedFolders()): string | null {
  for (const item of moved) {
    const relative = underFolder(item.from, oldPath);
    if (relative !== null) return relative ? path.join(item.folder, relative) : item.folder;
  }
  return null;
}

/**
 * 이 경로(옮긴 폴더 또는 그 안쪽)가 *옮기기 전에* 있던 곳 — 적힌 그대로의 경로와 실제 경로. 옮긴 폴더가 아니면 null. 아무것도 쓰지 않는다.
 * 위치를 정체성에 넣은 기록(열려 있는 Science 배정의 핀)이 "폴더를 옮긴 것"과 "패키지가 바뀐 것"을 가를 때 쓴다: 옮기기 전 위치로 다시 계산한 값이 기록과
 * 정확히 같으면 같은 패키지다.
 */
export function locationBeforeMove(currentPath: string, root: string = agentHomeRoot()): { path: string; realPath: string } | null {
  const roots = [path.resolve(root)];
  try { const real = fs.realpathSync.native(root); if (real !== roots[0]) roots.push(real); } catch { /* the lexical root alone */ }
  for (const candidate of roots) {
    const relative = underFolder(candidate, currentPath);
    if (!relative) continue;
    const [unitName, ...rest] = relative.split(path.sep);
    try {
      const origin = JSON.parse(fs.readFileSync(path.join(candidate, unitName, ".agentlas-local", "origin.json"), "utf8").replace(/^\uFEFF/, "")) as { kind?: unknown; from?: unknown; realFrom?: unknown };
      if (origin?.kind !== "moved" || typeof origin.from !== "string" || !path.isAbsolute(origin.from)) return null;
      const realFrom = typeof origin.realFrom === "string" && path.isAbsolute(origin.realFrom) ? origin.realFrom : origin.from;
      return { path: path.join(origin.from, ...rest), realPath: path.join(realFrom, ...rest) };
    } catch { return null; }
  }
  return null;
}
