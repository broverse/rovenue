import { TIER_LIMITS } from "@rovenue/shared";
import type { RoviTier } from "@rovenue/shared";

export interface QuotaInput {
  tier: RoviTier;
  unlimited: boolean;
  usage: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    mcpCalls: number;
  };
}

export type ExceededAxis =
  | "messages"
  | "input_tokens"
  | "output_tokens"
  | "mcp_calls"
  | null;

export interface QuotaResult {
  allowed: boolean;
  exceeded: ExceededAxis;
}

export function evaluateQuota(input: QuotaInput): QuotaResult {
  if (input.unlimited) return { allowed: true, exceeded: null };
  const limits = TIER_LIMITS[input.tier];
  if (input.usage.messages >= limits.messages)
    return { allowed: false, exceeded: "messages" };
  if (input.usage.inputTokens >= limits.inputTokens)
    return { allowed: false, exceeded: "input_tokens" };
  if (input.usage.outputTokens >= limits.outputTokens)
    return { allowed: false, exceeded: "output_tokens" };
  if (input.usage.mcpCalls >= limits.mcpCalls)
    return { allowed: false, exceeded: "mcp_calls" };
  return { allowed: true, exceeded: null };
}

export function resolveTier(args: {
  project: { metadata?: Record<string, unknown> | null };
  env: { ROVI_TIER?: RoviTier };
  unlimited: boolean;
}): { tier: RoviTier; unlimited: boolean } {
  const metaTier = args.project.metadata?.["rovi_tier"] as RoviTier | undefined;
  const tier =
    metaTier ?? (args.unlimited ? "enterprise" : (args.env.ROVI_TIER ?? "free"));
  return { tier, unlimited: args.unlimited };
}
