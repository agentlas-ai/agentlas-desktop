// ONE judged decision for the deep-vertical pack seeds (creative ad pack +
// ecommerce ops). Previously each pack ran its own lexical prefilter as a GATE:
// a miss never reached the judge, so a creative or commerce request phrased
// without the listed words could never seed, while a coincidental substring
// ("small", "restore", an uploaded bug screenshot) forced the judge to veto.
//
// Now both pack intents are one judgeSubset call per One request (the subset
// cache keys on kind+labels+input, so the creative and ecommerce seeds share a
// single model verdict for the same prompt). There are no lexical
// prefilters or priors any more. Contract unified
// 2026-08-20: with NO connected model the resolution is NEUTRAL — an empty
// selection with source:"fallback". No consumer can seed a pack
// surface from a keyword guess, because none exists.

import type { ImageAttachment } from "../shared/types";
import { judgeSubset, type SubsetSpec, type SubsetVerdict } from "./system-agents/judgment";

export type OnePackIntent = "creative-ad-pack" | "ecommerce-ops";

const PACK_INTENT_LABELS = ["creative-ad-pack", "ecommerce-ops"] as const;

export const ONE_PACK_INTENT_JUDGMENT_KIND = "one-pack-intent";

export interface OnePackIntentResolution {
  selected: OnePackIntent[];
  /** "llm" = the model decided; "fallback" = neutral (empty selection). */
  source: "llm" | "fallback";
  reason: string;
}

export type OnePackIntentJudge = (
  spec: SubsetSpec<OnePackIntent>,
) => Promise<SubsetVerdict<OnePackIntent>>;

/**
 * Resolve which deep-vertical pack surfaces (zero or more) this One request
 * genuinely calls for. There is no lexical prior; the model verdict is the only seed.
 */
export async function resolveOnePackIntents(input: {
  prompt: string;
  images?: ImageAttachment[];
  signal?: AbortSignal;
  timeoutMs?: number;
  judgeSubsetFn?: OnePackIntentJudge;
}): Promise<OnePackIntentResolution> {
  if (!input.prompt.trim()) return { selected: [], source: "fallback", reason: "empty prompt" };
  let verdict: SubsetVerdict<OnePackIntent>;
  try {
    verdict = await (input.judgeSubsetFn ?? judgeSubset)({
      kind: ONE_PACK_INTENT_JUDGMENT_KIND,
      question:
        "Which of these deep-vertical work surfaces does the user's request genuinely call for? " +
        "creative-ad-pack = produce advertising/creative-marketing assets (ads, promo images/videos, banners, ad copy). " +
        "ecommerce-ops = operate an online store (products, orders, inventory, storefront, checkout).",
      labels: PACK_INTENT_LABELS,
      // The input is the prompt alone so the creative and ecommerce seeds share
      // one cached verdict per One request; attachment context rides in guidance.
      input: input.prompt.slice(0, 2_000),
      guidance:
        (input.images?.length ? `The request includes ${input.images.length} image attachment(s). ` : "") +
        "Judge the user's intent in any language. An empty selection is the correct answer for ordinary requests.",
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 8_000,
    });
  } catch {
    // 판정 실패 = 중립. 단어장 후보는 힌트였을 뿐 선택으로 승격되지 않는다.
    return { selected: [], source: "fallback", reason: "judge failed" };
  }
  if (verdict.source !== "llm") {
    return { selected: [], source: "fallback", reason: verdict.reason };
  }
  return { selected: verdict.selected, source: "llm", reason: verdict.reason };
}
