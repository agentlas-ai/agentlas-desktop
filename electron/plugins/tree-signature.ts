/**
 * 플러그인 트리의 "바뀌었나" 서명 — 파일 내용은 읽지 않고 경로·크기·mtime·모드만 해시한다.
 *
 * 왜(2026-09-14 실측): 설치 플러그인 검증(릴리스 다이제스트 + 매니페스트 무결성)이 **모든 실행마다** 17개 패키지의
 * 전 파일을 읽어 sha256 을 냈다(buildMcpConfigFile → readInstalledPlugin). 내용 검증은 보안 관문이라 없앨 수 없지만,
 * 트리의 메타데이터가 마지막 성공 검증 때와 같다면 같은 내용이다 — 그때만 결과를 재사용한다. 실패는 캐시하지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * `changeTime` 는 ctime 도 넣는다 — 실행을 넘어 저장해 두는 서명(시작 시 내장 플러그인 재해시 생략, perf MP-04)에 쓴다.
 * mtime 은 utimes 로 되돌릴 수 있지만 ctime 은 내용·모드·utimes 어느 변경에도 바뀐다.
 */
export function pluginTreeSignature(root: string, skipTopLevel?: (name: string) => boolean, options?: { changeTime?: boolean }): string | null {
  try {
    const hash = createHash("sha256");
    const visit = (dir: string, relativeDir: string, topLevel: boolean): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (topLevel && skipTopLevel?.(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.posix.join(relativeDir, entry.name);
        const stat = fs.lstatSync(absolute);
        hash.update(`${stat.isDirectory() ? "D" : stat.isFile() ? "F" : stat.isSymbolicLink() ? "L" : "?"}\0${relative}\0${stat.size}\0${Math.floor(stat.mtimeMs)}\0${stat.mode & 0o777}\0${options?.changeTime ? `${stat.ctimeMs}\0` : ""}`);
        if (stat.isDirectory()) visit(absolute, relative, false);
      }
    };
    visit(root, "", true);
    return hash.digest("hex");
  } catch {
    return null;
  }
}
