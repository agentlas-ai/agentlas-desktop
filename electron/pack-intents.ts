// ONE judged decision for the deep-vertical pack seeds (creative ad pack +
// ecommerce ops). Previously each pack ran its own lexical prefilter as a GATE:
// a miss never reached the judge, so a creative or commerce request phrased
// without the listed words could never seed, while a coincidental substring
// ("small", "restore", an uploaded bug screenshot) forced the judge to veto.
//
// Now both pack intents are one judgeSubset call per One request (the subset
// cache keys on kind+labels+input, so the creative and ecommerce seeds share a
// single model verdict for the same prompt). The prefilters are demoted to
// hints and remain only the labeled fallback (today's verdicts) when no model
// answers — a lexical miss can still seed when the model says so, and "empty
// selection" from the model genuinely means "neither pack".

import type { ImageAttachment } from "../shared/types";
import { judgeSubset, type SubsetSpec, type SubsetVerdict } from "./system-agents/judgment";

export type OnePackIntent = "creative-ad-pack" | "ecommerce-ops";

const PACK_INTENT_LABELS = ["creative-ad-pack", "ecommerce-ops"] as const;

export const ONE_PACK_INTENT_JUDGMENT_KIND = "one-pack-intent";

export interface OnePackIntentResolution {
  selected: OnePackIntent[];
  /** "llm" = the model decided; "fallback" = today's prefilter verdicts, labeled. */
  source: "llm" | "fallback";
  reason: string;
}

export type OnePackIntentJudge = (
  spec: SubsetSpec<OnePackIntent>,
) => Promise<SubsetVerdict<OnePackIntent>>;

/**
 * Resolve which deep-vertical pack surfaces (zero or more) this One request
 * genuinely calls for. The lexical prefilters are hints, never a gate.
 */
export async function resolveOnePackIntents(input: {
  prompt: string;
  images?: ImageAttachment[];
  signal?: AbortSignal;
  timeoutMs?: number;
  judgeSubsetFn?: OnePackIntentJudge;
}): Promise<OnePackIntentResolution> {
  // Lazy imports keep the surface modules ↔ intent module dependency acyclic.
  const { shouldSeedCreativeAdPack } = await import("./creative-pack/surface");
  const { shouldSeedEcommerceOps } = await import("./ecommerce-pack/surface");
  const lexical: OnePackIntent[] = [
    ...(shouldSeedCreativeAdPack(input.prompt, input.images) ? ["creative-ad-pack" as const] : []),
    ...(shouldSeedEcommerceOps(input.prompt) ? ["ecommerce-ops" as const] : []),
  ];
  if (!input.prompt.trim()) return { selected: lexical, source: "fallback", reason: "empty prompt" };
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
        `A deterministic prefilter suggested [${lexical.join(", ") || "none"}]. Treat that as a hint, not a gate. ` +
        (input.images?.length ? `The request includes ${input.images.length} image attachment(s). ` : "") +
        "A coincidental substring ('small', 'restore', 'add a task') is NOT intent, and a genuine creative or " +
        "commerce request in any language qualifies even when no reference word appears. An empty selection is " +
        "the correct answer for ordinary requests.",
      hints: [
        {
          label: "creative-ad-pack",
          words: ["ad", "advertisement", "banner", "poster", "campaign", "creative", "reels", "tiktok", "광고", "배너", "포스터", "릴스", "영상", "상세페이지"],
        },
        {
          label: "ecommerce-ops",
          words: ["shop", "store", "mall", "checkout", "orders", "inventory", "product listing", "쇼핑몰", "커머스", "주문", "재고", "상품 등록"],
        },
      ],
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 8_000,
    });
  } catch {
    return { selected: lexical, source: "fallback", reason: "judge failed" };
  }
  if (verdict.source !== "llm") {
    return { selected: lexical, source: "fallback", reason: verdict.reason };
  }
  return { selected: verdict.selected, source: "llm", reason: verdict.reason };
}
