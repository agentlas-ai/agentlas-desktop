import type { SiteProjectOperation } from "../../shared/site-studio";

export type { SiteProjectOperation } from "../../shared/site-studio";

type ActiveSiteOperation = {
  operation: SiteProjectOperation;
  token: symbol;
};

const activeByProject = new Map<string, ActiveSiteOperation>();

/**
 * Site의 generate/edit/handoff는 같은 프로젝트 대화 세션과 파일 snapshot을
 * 공유한다. Renderer 상태는 UX 보조일 뿐 권위가 아니므로 main에서도 프로젝트별
 * single-flight를 강제한다. 반환값이 null이면 이미 다른 작업이 진행 중이다.
 */
export function tryAcquireSiteProjectOperation(
  projectId: string,
  operation: SiteProjectOperation,
): (() => void) | null {
  const id = projectId.trim();
  if (!id) throw new Error("site-project-id-required");
  if (activeByProject.has(id)) return null;

  const token = Symbol(`${id}:${operation}`);
  activeByProject.set(id, { operation, token });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeByProject.get(id)?.token === token) activeByProject.delete(id);
  };
}

export function activeSiteProjectOperation(projectId: string): SiteProjectOperation | null {
  return activeByProject.get(projectId.trim())?.operation ?? null;
}

export function assertSiteProjectIdle(projectId: string): void {
  if (activeSiteProjectOperation(projectId)) throw new Error("site-project-busy");
}
