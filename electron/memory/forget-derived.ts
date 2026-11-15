// 잊기가 지우는 "저장소 옆 파생 파일" — 엔진이 만든 검색 색인(`recall-index.sqlite`)과 옛 `MEMORY.md` (#5).
//
// 이 파일은 `stores.ts` 도 가져다 쓰므로 `stores.ts` 를 가져오지 않는다(순환 없음). 파일을 지우는 일뿐이고 던지지 않는다.
// 색인 안의 삭제는 빈 페이지에 글을 남기므로 파일째 지우고 다음 검색이 다시 만든다. 하나도 안 남았으면 true.
import fs from "node:fs";
import path from "node:path";

export const RECALL_INDEX_FILE = "recall-index.sqlite";

export function dropRecallIndex(folder: string): boolean {
  let clean = true;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = path.join(folder, RECALL_INDEX_FILE + suffix);
    try { if (fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") clean = false; }
  }
  return clean;
}

/** 옛 엔진이 에이전트 저장소 옆에 둔 `MEMORY.md`(와 임시 파일)를 지운다 — 아무도 읽지 않고 잊은 글을 디스크에 남긴다. 지운 것이 있으면 true. */
export function removeMemoryMdBeside(storeFile: string): boolean {
  let removed = false;
  const folder = path.dirname(storeFile);
  try {
    for (const name of fs.readdirSync(folder)) {
      if (name === "MEMORY.md" || (name.startsWith(".MEMORY.md.") && name.endsWith(".tmp"))) { try { fs.unlinkSync(path.join(folder, name)); removed = true; } catch { /* 다음 기회 */ } }
    }
  } catch { /* 폴더 없음 */ }
  return removed;
}

/**
 * 저장소 하나가 잊은 글을 비울 때 같이 지우는 파생 파일: 그 폴더의 검색 색인, 에이전트 저장소면 `MEMORY.md` 도.
 * 이 저장소가 잊은 글을 실제로 갖고 있던 때만 부른다 — 갖지 않은 저장소의 색인은 그대로 둔다(다시 만드는 비용).
 */
export function dropDerivedBesideStore(kind: string, storeFile: string): boolean {
  if (kind === "agent") removeMemoryMdBeside(storeFile);
  return dropRecallIndex(path.dirname(storeFile));
}
