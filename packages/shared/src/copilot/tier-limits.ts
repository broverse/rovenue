import type { RoviTier } from "./types";

export interface TierLimits {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  allowedModels: string[];
}

export const TIER_LIMITS: Record<RoviTier, TierLimits> = {
  free: {
    messages: 50,
    inputTokens: 250_000,
    outputTokens: 50_000,
    allowedModels: ["gpt-4o-mini", "claude-haiku-4-5"],
  },
  team: {
    messages: 1_000,
    inputTokens: 5_000_000,
    outputTokens: 1_000_000,
    allowedModels: [
      "gpt-4o-mini",
      "gpt-4o",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ],
  },
  business: {
    messages: 10_000,
    inputTokens: 50_000_000,
    outputTokens: 10_000_000,
    allowedModels: ["*"],
  },
  enterprise: {
    messages: Number.POSITIVE_INFINITY,
    inputTokens: Number.POSITIVE_INFINITY,
    outputTokens: Number.POSITIVE_INFINITY,
    allowedModels: ["*"],
  },
};

export function isModelAllowed(tier: RoviTier, model: string): boolean {
  const list = TIER_LIMITS[tier].allowedModels;
  return list.includes("*") || list.includes(model);
}
