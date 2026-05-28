export type RoviTier = "free" | "team" | "business" | "enterprise";

export type RoviProvider = "openai" | "anthropic" | "mistral" | "ollama";

export interface RoviUsageSnapshot {
  tier: RoviTier;
  period: { start: string; end: string; daysLeft: number };
  messages: { used: number; limit: number; percent: number };
  tokens: {
    input: { used: number; limit: number };
    output: { used: number; limit: number };
  };
  resetAt: string;
  unlimited: boolean;
}

export interface RoviIntentPreviewField {
  label: string;
  before?: string | number | null;
  after: string | number | null;
}

export interface RoviIntentPreview {
  title: string;
  fields: RoviIntentPreviewField[];
}

export interface RoviPendingIntent {
  intentId: string;
  toolName: string;
  preview: RoviIntentPreview;
  requiresRole: string;
  expiresAt: string;
}

export interface RoviExecutedIntentResult {
  intentId: string;
  status: "executed" | "failed" | "rejected" | "expired";
  result?: unknown;
  error?: { code: string; message: string };
}

export interface RoviChatContext {
  route: string;
  focusedEntityId?: string;
}
