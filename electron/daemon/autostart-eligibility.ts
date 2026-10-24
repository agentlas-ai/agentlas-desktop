/*
 * 로그인 자동 시작(LaunchAgent 등)은 설치된(패키징된) 제품만 만든다.
 *
 * 개발·QA 인스턴스(node_modules/electron 으로 띄운 앱, AGENTLAS_E2E, 격리 사용자 데이터)가
 * 설치별 라벨 `cloud.agentlas.daemon.<hash>` 로 영구 plist 를 깔면, 시험을 돌릴 때마다
 * 오너 Mac 에 로그인 항목이 쌓이고 지워진 경로를 60초마다 되살린다(2026-10-10: 57개).
 * 패키징된 제품의 동작은 바뀌지 않는다.
 */
export interface AutostartEnvironment {
  env: Record<string, string | undefined>;
  execPath: string;
  defaultApp?: boolean;
}

export function currentAutostartEnvironment(): AutostartEnvironment {
  return { env: process.env, execPath: process.execPath, defaultApp: (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp };
}

/** 이 프로세스가 영구 로그인 항목을 설치하면 안 되는 개발/QA 인스턴스인가. */
export function isNonProductionInstance(environment: AutostartEnvironment = currentAutostartEnvironment()): boolean {
  if (environment.env.AGENTLAS_E2E === "1") return true;
  if (environment.env.AGENTLAS_QA_USER_DATA_DIR?.trim()) return true;
  if (environment.defaultApp === true) return true;
  return /[\\/]node_modules[\\/]electron[\\/]/.test(environment.execPath);
}
