import type { RoviProvider } from "@rovenue/shared";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

export type ProviderSource = "byok" | "env";

export interface ResolvedProvider {
  source: ProviderSource;
  provider: RoviProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ResolveInput {
  projectId: string;
  loadCreds: (
    projectId: string,
  ) => Promise<{
    provider: RoviProvider;
    defaultModel: string;
    apiKey: string;
    baseUrl?: string;
  } | null>;
  env: {
    ROVI_DEFAULT_PROVIDER?: RoviProvider;
    ROVI_DEFAULT_MODEL?: string;
    ROVI_DEFAULT_API_KEY?: string;
    ROVI_DEFAULT_BASE_URL?: string;
  };
}

export class RoviConfigError extends Error {
  code = "ROVI_NOT_CONFIGURED";
}

export async function resolveProviderForProject(
  args: ResolveInput,
): Promise<ResolvedProvider> {
  const byok = await args.loadCreds(args.projectId);
  if (byok) {
    return {
      source: "byok",
      provider: byok.provider,
      model: byok.defaultModel,
      apiKey: byok.apiKey,
      baseUrl: byok.baseUrl,
    };
  }
  if (
    args.env.ROVI_DEFAULT_PROVIDER &&
    args.env.ROVI_DEFAULT_MODEL &&
    args.env.ROVI_DEFAULT_API_KEY
  ) {
    return {
      source: "env",
      provider: args.env.ROVI_DEFAULT_PROVIDER,
      model: args.env.ROVI_DEFAULT_MODEL,
      apiKey: args.env.ROVI_DEFAULT_API_KEY,
      baseUrl: args.env.ROVI_DEFAULT_BASE_URL,
    };
  }
  throw new RoviConfigError("Rovi has no provider configured for this project");
}

export function buildAiSdkModel(r: ResolvedProvider): LanguageModel {
  switch (r.provider) {
    case "openai": {
      const sdk = createOpenAI({ apiKey: r.apiKey, baseURL: r.baseUrl });
      return sdk(r.model);
    }
    case "anthropic": {
      const sdk = createAnthropic({ apiKey: r.apiKey, baseURL: r.baseUrl });
      return sdk(r.model);
    }
    case "mistral": {
      const sdk = createMistral({ apiKey: r.apiKey, baseURL: r.baseUrl });
      return sdk(r.model);
    }
    case "ollama": {
      // Ollama exposes an OpenAI-compatible endpoint at /v1.
      const sdk = createOpenAI({
        apiKey: r.apiKey || "ollama",
        baseURL: r.baseUrl ?? "http://localhost:11434/v1",
      });
      return sdk(r.model);
    }
  }
}
