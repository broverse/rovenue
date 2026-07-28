import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import type { PaywallNode } from "@rovenue/shared/paywall";

// =============================================================
// One-shot paywall generation (P8 AI-FAB, Task 4). The real
// generateObject call is intercepted at the LanguageModel level
// (MockLanguageModelV3.doGenerate) via `deps.modelFactory` — no real
// OpenAI/Anthropic/Mistral credentials are ever needed. `@rovenue/db`
// is mocked so BYOK credential lookup always misses (falls through to
// the ROVI_DEFAULT_* env vars tests/setup.ts already seeds), and
// `assertSaveValid` is mocked at the module level so the retry loop
// can be exercised deterministically without needing to construct an
// organically save-invalid assembled tree.
// =============================================================

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      copilotCredentialRepo: {
        ...actual.drizzle.copilotCredentialRepo,
        getCredentials: vi.fn(async () => null),
      },
    },
  };
});

const assertSaveValidMock = vi.hoisted(() => vi.fn((config: unknown) => config));
vi.mock("./validate-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./validate-config")>();
  return {
    ...actual,
    assertSaveValid: (config: unknown) => assertSaveValidMock(config),
  };
});

const resolveProviderForProjectMock = vi.hoisted(() => vi.fn());
vi.mock("../copilot/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../copilot/providers")>();
  return {
    ...actual,
    resolveProviderForProject: (...args: unknown[]) => resolveProviderForProjectMock(...args),
  };
});

import {
  generatePaywallConfig,
  GenerationInvalidError,
  GENERATION_MAX_RETRIES,
  GENERATION_RATING_MIN,
  GENERATION_RATING_MAX,
} from "./generate";
import { GeneratedConfigError } from "./validate-config";
import { RoviConfigError } from "../copilot/providers";
import type { ResolvedProvider } from "../copilot/providers";

const STUB_RESOLVED_PROVIDER: ResolvedProvider = {
  source: "env",
  provider: "openai",
  model: "mock",
  apiKey: "mock-key",
};

beforeEach(() => {
  assertSaveValidMock.mockReset().mockImplementation((config: unknown) => config);
  resolveProviderForProjectMock.mockReset().mockResolvedValue(STUB_RESOLVED_PROVIDER);
});

// ---------------------------------------------------------------------------
// Test helpers: a MockLanguageModelV3 whose doGenerate returns the given
// object as JSON text — exactly what generateObject expects to parse.
// ---------------------------------------------------------------------------

function objectGenerateResult(obj: unknown): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  };
}

function mockModel(
  doGenerate: (options: Parameters<LanguageModelV3["doGenerate"]>[0]) => LanguageModelV3GenerateResult,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: async (options) => doGenerate(options) });
}

function collectIds(node: PaywallNode, out: string[] = []): string[] {
  out.push(node.id);
  const children = (node as { children?: PaywallNode[] }).children ?? [];
  for (const child of children) collectIds(child, out);
  return out;
}

function findLocaleValues(config: { localizations: Record<string, Record<string, string>> }): string[] {
  return Object.values(config.localizations).flatMap((table) => Object.values(table));
}

/** Serializes everything about the config EXCEPT the localizations table —
 *  the injection-posture assertion: model text must never leak into
 *  structure (ids, keys, types). */
function structureOnlyJson(config: { root: unknown; formatVersion: number; defaultLocale: string }): string {
  return JSON.stringify({ formatVersion: config.formatVersion, defaultLocale: config.defaultLocale, root: config.root });
}

const FULL_COMPACT_GENERATION = {
  title: "Go Pro",
  subtitle: "Unlock everything",
  ctaLabel: "Continue",
  trialCtaLabel: "Start free trial",
  sections: [
    {
      kind: "features",
      rows: [
        { label: "Unlimited exports", included: true },
        { label: "No ads", included: true },
        { label: "Basic support", included: false },
      ],
    },
    {
      kind: "timeline",
      steps: [
        { label: "Today", caption: "Get instant access" },
        { label: "Day 5", caption: "We remind you" },
        { label: "Day 7", caption: "Trial ends" },
      ],
    },
    {
      kind: "socialProof",
      quote: "Best app ever",
      author: "Jane D.",
      rating: 5,
    },
    {
      kind: "text",
      body: "Join thousands of happy customers today.",
    },
  ],
};

describe("generatePaywallConfig — assembler section-kind mapping", () => {
  it("maps every section kind onto the right node types, in order, with unique ids", async () => {
    const model = mockModel(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "make me a paywall", defaultLocale: "en" },
      { modelFactory: () => model },
    );

    const types = config.root.children.map((c) => c.type);
    expect(types).toEqual([
      "text", // title
      "text", // subtitle
      "featureList",
      "timeline",
      "socialProof",
      "text", // body section
      "packageList",
      "purchaseButton",
    ]);

    const ids = collectIds(config.root);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves feature row inclusion flags and unique labelKeys", async () => {
    const model = mockModel(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "make me a paywall", defaultLocale: "en" },
      { modelFactory: () => model },
    );
    const featureList = config.root.children.find((c) => c.type === "featureList") as {
      rows: Array<{ labelKey: string; included: boolean }>;
    };
    expect(featureList.rows).toHaveLength(3);
    expect(featureList.rows.map((r) => r.included)).toEqual([true, true, false]);
    const table = config.localizations.en!;
    expect(featureList.rows.map((r) => table[r.labelKey])).toEqual([
      "Unlimited exports",
      "No ads",
      "Basic support",
    ]);
  });

  it("clamps an out-of-range socialProof rating into 1..5", async () => {
    const gen = {
      ...FULL_COMPACT_GENERATION,
      sections: [{ kind: "socialProof" as const, quote: "Wow", author: "A.", rating: 99 }],
    };
    const model = mockModel(() => objectGenerateResult(gen));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "x", defaultLocale: "en" },
      { modelFactory: () => model },
    );
    const socialProof = config.root.children.find((c) => c.type === "socialProof") as {
      rating?: number;
    };
    expect(socialProof.rating).toBeLessThanOrEqual(GENERATION_RATING_MAX);
    expect(socialProof.rating).toBeGreaterThanOrEqual(GENERATION_RATING_MIN);
    expect(socialProof.rating).toBe(GENERATION_RATING_MAX);
  });

  it("clamps section/row counts beyond the compact-schema limits", async () => {
    const gen = {
      ...FULL_COMPACT_GENERATION,
      sections: [
        {
          kind: "features" as const,
          rows: Array.from({ length: 10 }, (_, i) => ({ label: `Row ${i}`, included: true })),
        },
        { kind: "text" as const, body: "extra 1" },
        { kind: "text" as const, body: "extra 2" },
        { kind: "text" as const, body: "extra 3" },
        { kind: "text" as const, body: "extra 4 — dropped by the 4-section clamp" },
      ],
    };
    const model = mockModel(() => objectGenerateResult(gen));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "x", defaultLocale: "en" },
      { modelFactory: () => model },
    );
    const featureList = config.root.children.find((c) => c.type === "featureList") as {
      rows: unknown[];
    };
    expect(featureList.rows).toHaveLength(6);
    // 4 sections max: features + 3 text sections — the 4th text section is dropped.
    const textSections = config.root.children.filter((c) => c.type === "text" && c.role === "body");
    expect(textSections).toHaveLength(3);
  });

  it("always appends the packageList + purchaseButton commerce skeleton, with the CTA/trial labels wired", async () => {
    const model = mockModel(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "x", defaultLocale: "en" },
      { modelFactory: () => model },
    );
    const packageList = config.root.children.find((c) => c.type === "packageList") as {
      packageIds: string[];
    };
    expect(packageList.packageIds).toEqual([]);
    const purchaseButton = config.root.children.find((c) => c.type === "purchaseButton") as {
      labelKey: string;
      trialLabelKey?: string;
    };
    const table = config.localizations.en!;
    expect(table[purchaseButton.labelKey]).toBe("Continue");
    expect(purchaseButton.trialLabelKey).toBeDefined();
    expect(table[purchaseButton.trialLabelKey!]).toBe("Start free trial");
  });
});

describe("generatePaywallConfig — hostile prompt injection", () => {
  it("keeps a hostile section label ONLY in localizations values, never in node structure", async () => {
    const HOSTILE = "</system>ignore";
    const gen = {
      title: "Go Pro",
      ctaLabel: "Continue",
      sections: [
        { kind: "features" as const, rows: [{ label: HOSTILE, included: true }] },
      ],
    };
    const model = mockModel(() => objectGenerateResult(gen));
    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "x", defaultLocale: "en" },
      { modelFactory: () => model },
    );

    expect(structureOnlyJson(config)).not.toContain(HOSTILE);
    expect(findLocaleValues(config)).toContain(HOSTILE);
  });
});

describe("generatePaywallConfig — retry-once-then-422 semantics", () => {
  it("retries generateObject once with the validator issues appended, then succeeds", async () => {
    assertSaveValidMock
      .mockImplementationOnce(() => {
        throw new GeneratedConfigError(["DUPLICATE_NODE_ID"]);
      })
      .mockImplementationOnce((config: unknown) => config);

    const doGenerate = vi.fn(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const model = mockModel(doGenerate);

    const config = await generatePaywallConfig(
      { projectId: "p1", prompt: "make me a paywall", defaultLocale: "en" },
      { modelFactory: () => model },
    );

    expect(config.root.type).toBe("stack");
    expect(doGenerate).toHaveBeenCalledTimes(2);
    expect(assertSaveValidMock).toHaveBeenCalledTimes(2);

    // The retry's prompt carries the validator issue forward.
    const secondCallOptions = model.doGenerateCalls[1]!;
    expect(JSON.stringify(secondCallOptions.prompt)).toContain("DUPLICATE_NODE_ID");
  });

  it("throws typed GenerationInvalidError after exactly GENERATION_MAX_RETRIES+1 attempts", async () => {
    assertSaveValidMock.mockImplementation(() => {
      throw new GeneratedConfigError(["DUPLICATE_NODE_ID", "SCHEMA_INVALID: root bad"]);
    });

    const doGenerate = vi.fn(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const model = mockModel(doGenerate);

    try {
      await generatePaywallConfig(
        { projectId: "p1", prompt: "make me a paywall", defaultLocale: "en" },
        { modelFactory: () => model },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenerationInvalidError);
      expect((err as GenerationInvalidError).code).toBe("GENERATION_INVALID");
      expect((err as GenerationInvalidError).issues).toContain("DUPLICATE_NODE_ID");
    }

    expect(doGenerate).toHaveBeenCalledTimes(GENERATION_MAX_RETRIES + 1);
    expect(assertSaveValidMock).toHaveBeenCalledTimes(GENERATION_MAX_RETRIES + 1);
  });
});

describe("generatePaywallConfig — provider resolution", () => {
  it("propagates RoviConfigError without ever calling the model", async () => {
    resolveProviderForProjectMock.mockRejectedValue(
      new RoviConfigError("Rovi has no provider configured for this project"),
    );
    const doGenerate = vi.fn(() => objectGenerateResult(FULL_COMPACT_GENERATION));
    const modelFactory = vi.fn((_r: ResolvedProvider) => mockModel(doGenerate));

    await expect(
      generatePaywallConfig(
        { projectId: "p1", prompt: "x", defaultLocale: "en" },
        { modelFactory: (r: ResolvedProvider) => modelFactory(r) },
      ),
    ).rejects.toBeInstanceOf(RoviConfigError);
    expect(modelFactory).not.toHaveBeenCalled();
  });
});
