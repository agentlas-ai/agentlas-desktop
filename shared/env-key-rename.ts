// 저장된 env 키 중 어떤 도구도 읽지 않는 이름에 대해, 선언된 이름으로 바꾸자는 제안을 만든다.
// 순수 함수 — renderer 와 main 이 같은 이름 검증 규칙을 쓴다. 값은 다루지 않는다.

export interface EnvKeyRenameSuggestion {
  from: string;
  to: string;
}

/** .env 가져오기(parseDotEnv)와 같은 규칙. */
export function isValidEnvName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function firstToken(name: string): string {
  return name.split("_")[0].toUpperCase();
}

/**
 * - 저장된 이름이 선언된 이름이면 제안 없음(이미 읽힌다).
 * - 첫 토큰(`_` 앞)이 같은 선언 이름이 정확히 하나이고, 그 이름이 아직 저장되지 않았을 때만 제안.
 * - 선언 후보가 둘 이상이거나, 같은 목표를 노리는 저장 이름이 둘 이상이면 제안하지 않는다.
 */
export function suggestEnvKeyRenames(
  storedNames: readonly string[],
  declaredNames: readonly string[],
): EnvKeyRenameSuggestion[] {
  const stored = new Set(storedNames);
  const declared = [...new Set(declaredNames)];
  const declaredSet = new Set(declared);
  const picked: EnvKeyRenameSuggestion[] = [];
  for (const from of stored) {
    if (declaredSet.has(from) || !isValidEnvName(from)) continue;
    const token = firstToken(from);
    if (!token) continue;
    const matches = declared.filter((name) => firstToken(name) === token);
    if (matches.length !== 1) continue;
    const to = matches[0];
    if (stored.has(to) || !isValidEnvName(to)) continue;
    picked.push({ from, to });
  }
  const targetCount = new Map<string, number>();
  for (const s of picked) targetCount.set(s.to, (targetCount.get(s.to) ?? 0) + 1);
  return picked.filter((s) => targetCount.get(s.to) === 1);
}
