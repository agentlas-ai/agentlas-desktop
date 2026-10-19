







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
