// 멀티모달 엔진 "실제 가용성" 프로브 + auto 해석.
//  - cli-subscription 엔진(codex / nanobanana=agy): 실행 파일(bin)이 PATH에 있으면 준비됨(키리스).
//  - api-key / cloud-credentials 엔진: 필요한 env 키가 전부 보관함/환경에 있으면 준비됨.
// trex/imagegen.ts가 이미 검증한 키리스-우선 로직을 일반 에이전트 경로로 끌어올린 것.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTO_PROVIDER,
  getMultimodalProvider,
  providerLadder,
  type MultimodalModality,
  type MultimodalProvider,
  type MultimodalSettings,
} from "../../shared/multimodal";
import { hasEnvVar } from "../secrets/vault";

/** cli-subscription provider id → 찾을 실행 파일 이름 + 흔한 설치 경로. */
const CLI_BINS: Record<string, { name: string; extra: string[] }> = {
  "codex-cli-image": {
    name: "codex",
    extra: [
      path.join(os.homedir(), ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ],
  },
  "nanobanana-image": {
    name: "agy",
    extra: [
      path.join(os.homedir(), ".local/bin/agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ],
  },
};

function resolveBin(name: string, extra: string[]): string | null {
  const fromPath = (process.env.PATH || "").split(":").filter(Boolean).map((d) => path.join(d, name));
  for (const c of [...extra, ...fromPath]) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** 이 provider가 지금 바로 쓸 수 있나? (키리스=bin 존재 / 키필요=키 전부 존재) */
export async function isProviderReady(provider: MultimodalProvider): Promise<boolean> {
  const cli = CLI_BINS[provider.id];
  if (cli) return !!resolveBin(cli.name, cli.extra);
  // 나노바나나는 agy 키리스가 우선이지만 GEMINI_API_KEY 폴백도 허용(trex와 동일).
  if (provider.envKeys.length === 0) return true; // 키 불필요 엔진(이론상 CLI 미등록)
  const checks = await Promise.all(provider.envKeys.map((key) => hasEnvVar(key)));
  return checks.every(Boolean);
}

export interface ResolvedProvider {
  /** 확정된 엔진. auto인데 가용한 게 하나도 없으면 null. */
  provider: MultimodalProvider | null;
  ready: boolean;
  /** "explicit" = 사용자가 직접 고름, "auto" = 사다리에서 자동 선택. */
  via: "explicit" | "auto";
}

/**
 * 지정된(또는 auto) provider를 실제 가용성 기준으로 확정한다.
 *  - 명시 선택: 그 provider 그대로 반환(+ready 여부). 사용자의 의도를 존중.
 *  - "auto": 사다리(키리스 우선)에서 처음으로 ready인 것을 고른다. 없으면 provider=null, ready=false.
 */
export async function resolveActiveProvider(
  modality: MultimodalModality,
  settings: MultimodalSettings,
): Promise<ResolvedProvider> {
  const selected =
    modality === "image"
      ? settings.imageProvider
      : modality === "video"
        ? settings.videoProvider
        : settings.audioProvider;

  if (selected && selected !== AUTO_PROVIDER) {
    const provider = getMultimodalProvider(selected);
    if (provider) return { provider, ready: await isProviderReady(provider), via: "explicit" };
  }

  // auto (또는 알 수 없는 값): 사다리를 키리스-우선 순서로 걸어 첫 ready를 채택.
  for (const provider of providerLadder(modality)) {
    if (await isProviderReady(provider)) {
      return { provider, ready: true, via: "auto" };
    }
  }
  return { provider: null, ready: false, via: "auto" };
}
