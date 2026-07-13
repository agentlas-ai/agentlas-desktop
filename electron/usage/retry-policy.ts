import type { UsageRetryProviderId } from "../../shared/types";

export const USAGE_RETRY_PROVIDER_IDS = [
  "claude-code",
  "codex",
  "gemini",
  "grok",
] as const satisfies readonly UsageRetryProviderId[];

const PROVIDER_SET = new Set<string>(USAGE_RETRY_PROVIDER_IDS);

export function isUsageRetryProviderId(value: unknown): value is UsageRetryProviderId {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

export interface UsageRetryClaim {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Explicit retry gate. Its deadlines are deliberately separate from usage caches,
 * so invalidateUsage() and runtime health updates cannot erase this cooldown.
 */
export class UsageRetryGate {
  private readonly nextAllowedAt = new Map<UsageRetryProviderId, number>();

  constructor(private readonly cooldownMs: number) {
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      throw new Error("usage retry cooldown must be positive");
    }
  }

  claim(providerId: UsageRetryProviderId, now = Date.now()): UsageRetryClaim {
    const deadline = this.nextAllowedAt.get(providerId) ?? 0;
    if (deadline > now) {
      return { allowed: false, retryAfterMs: deadline - now };
    }
    this.nextAllowedAt.set(providerId, now + this.cooldownMs);
    return { allowed: true, retryAfterMs: this.cooldownMs };
  }

  remaining(providerId: UsageRetryProviderId, now = Date.now()): number {
    return Math.max(0, (this.nextAllowedAt.get(providerId) ?? 0) - now);
  }
}
