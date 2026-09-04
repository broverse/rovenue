import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

// =============================================================
// Auto-translate. The real `generateObject` call is intercepted at the
// LanguageModel level via `deps.modelFactory`, exactly as
// generate.test.ts does, so no provider credentials are ever needed.
//
// Every model response here is SCRIPTED, and most of them are scripted to
// be WRONG. That is the point: nothing in this file asserts that a model
// translates well — that would test the vendor. What is tested is that
// the service refuses output which would ship literal `{{braces}}` to a
// paying customer.
// =============================================================

const bumpUsageMock = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => undefined));
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
      copilotUsageRepo: {
        ...actual.drizzle.copilotUsageRepo,
        bumpUsage: (_db: unknown, input: Record<string, unknown>) => bumpUsageMock(input),
      },
    },
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

import { NoObjectGeneratedError } from "ai";
import {
  placeholdersPreserved,
  translateEntries,
  TranslationInvalidError,
  TRANSLATE_MAX_ENTRIES,
} from "./translate";
import type { ResolvedProvider } from "../copilot/providers";
import { currentYearMonth } from "@rovenue/db";

const STUB_RESOLVED_PROVIDER: ResolvedProvider = {
  source: "env",
  provider: "openai",
  model: "mock",
  apiKey: "mock-key",
};

const PROJECT_ID = "prj_1";

beforeEach(() => {
  resolveProviderForProjectMock.mockReset().mockResolvedValue(STUB_RESOLVED_PROVIDER);
  bumpUsageMock.mockReset().mockResolvedValue(undefined);
});

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

/** A model that answers each successive call with the next scripted object. */
function scriptedModel(responses: unknown[]): {
  model: MockLanguageModelV3;
  calls: () => number;
} {
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return objectGenerateResult(response);
    },
  });
  return { model, calls: () => call };
}

function translate(
  entries: Record<string, string>,
  responses: unknown[],
  overrides: Partial<{ sourceLocale: string; targetLocale: string }> = {},
) {
  const { model, calls } = scriptedModel(responses);
  const promise = translateEntries(
    {
      projectId: PROJECT_ID,
      sourceLocale: overrides.sourceLocale ?? "en",
      targetLocale: overrides.targetLocale ?? "es",
      entries,
    },
    { modelFactory: () => model },
  );
  return { promise, calls };
}

describe("placeholdersPreserved", () => {
  it("accepts an identical placeholder set", () => {
    expect(placeholdersPreserved("Buy for {{price}}", "Comprar por {{price}}")).toBe(true);
  });

  it("accepts placeholders in a different ORDER — languages reorder clauses", () => {
    expect(
      placeholdersPreserved("{{price}} for {{period}}", "{{period}} por {{price}}"),
    ).toBe(true);
  });

  it("rejects a renamed placeholder", () => {
    expect(placeholdersPreserved("Buy for {{price}}", "Comprar por {{precio}}")).toBe(false);
  });

  it("rejects a dropped placeholder", () => {
    expect(placeholdersPreserved("Buy for {{price}}", "Comprar ahora")).toBe(false);
  });

  it("rejects a duplicated placeholder — the comparison is a multiset", () => {
    expect(
      placeholdersPreserved("Once {{price}}", "{{price}} y {{price}}"),
    ).toBe(false);
  });

  it("accepts a genuine repeat that the source also repeats", () => {
    expect(
      placeholdersPreserved("{{price}} {{price}}", "{{price}} y {{price}}"),
    ).toBe(true);
  });
});

describe("translateEntries", () => {
  it("returns the model's entries when placeholders are preserved", async () => {
    const { promise, calls } = translate({ cta: "Continue for {{price}}" }, [
      { cta: "Continuar por {{price}}" },
    ]);
    await expect(promise).resolves.toEqual({
      entries: { cta: "Continuar por {{price}}" },
      rejected: [],
    });
    expect(calls()).toBe(1);
  });

  it("retries ONCE, naming the offending key, when a placeholder is translated away", async () => {
    const { promise, calls } = translate({ cta: "Continue for {{price}}" }, [
      { cta: "Continuar por {{precio}}" },
      { cta: "Continuar por {{price}}" },
    ]);
    await expect(promise).resolves.toEqual({
      entries: { cta: "Continuar por {{price}}" },
      rejected: [],
    });
    expect(calls()).toBe(2);
  });

  it("drops the key rather than returning a corrupted string when the retry also fails", async () => {
    // A missing translation falls back to the default locale and reads
    // correctly. A corrupted one renders `{{precio}}` to a buyer. So the
    // service must prefer the gap.
    const { promise } = translate({ cta: "Continue for {{price}}" }, [
      { cta: "Continuar por {{precio}}" },
      { cta: "Continuar por {{precio}}" },
    ]);
    await expect(promise).resolves.toEqual({ entries: {}, rejected: ["cta"] });
  });

  it("keeps the good keys and rejects only the bad ones", async () => {
    const { promise } = translate(
      { good: "Hello {{price}}", bad: "Once {{price}}" },
      [
        { good: "Hola {{price}}", bad: "{{price}} y {{price}}" },
        { bad: "{{price}} y {{price}}" },
      ],
    );
    await expect(promise).resolves.toEqual({
      entries: { good: "Hola {{price}}" },
      rejected: ["bad"],
    });
  });

  it("only retries the keys that failed, not the whole batch", async () => {
    const seen: string[][] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        // The user turn's text, not the stringified message array — the
        // latter escapes the quotes around every key.
        const userText = options.prompt
          .flatMap((m): unknown[] => (Array.isArray(m.content) ? m.content : []))
          .map((part) =>
            typeof part === "object" && part !== null && "text" in part
              ? String((part as { text: unknown }).text)
              : "",
          )
          .join("\n");
        seen.push(["good", "bad"].filter((k) => userText.includes(`"${k}"`)));
        call += 1;
        return objectGenerateResult(
          call === 1
            ? { good: "Hola {{price}}", bad: "roto" }
            : { bad: "Roto {{price}}" },
        );
      },
    });
    await translateEntries(
      {
        projectId: PROJECT_ID,
        sourceLocale: "en",
        targetLocale: "es",
        entries: { good: "Hello {{price}}", bad: "Broken {{price}}" },
      },
      { modelFactory: () => model },
    );
    expect(seen[0]).toEqual(["good", "bad"]);
    // The retry must not re-send, re-charge for, or risk re-corrupting a
    // key that already came back clean.
    expect(seen[1]).toEqual(["bad"]);
  });

  it("reports a key the model never returned instead of silently skipping it", async () => {
    const { promise } = translate({ a: "One", b: "Two" }, [{ a: "Uno" }, { a: "Uno" }]);
    await expect(promise).resolves.toEqual({ entries: { a: "Uno" }, rejected: ["b"] });
  });

  it("drops a key the caller never asked for — the model does not widen the write set", async () => {
    const { promise } = translate({ a: "One" }, [{ a: "Uno", injected: "malicious" }]);
    await expect(promise).resolves.toEqual({ entries: { a: "Uno" }, rejected: [] });
  });

  it("rejects a non-string value as not a translation", async () => {
    const { promise } = translate({ a: "One" }, [{ a: 42 }, { a: 42 }]);
    await expect(promise).resolves.toEqual({ entries: {}, rejected: ["a"] });
  });

  it("rejects a BLANK translation, even for a source with no placeholders", async () => {
    // "Restore Purchases" has no placeholders, so the placeholder check
    // passes against "" — blankness has to be its own rule, or an empty
    // value lands silently and the matrix shows the cell as still missing
    // while nothing is reported as rejected.
    const { promise } = translate({ a: "Restore Purchases" }, [{ a: "" }, { a: "   " }]);
    await expect(promise).resolves.toEqual({ entries: {}, rejected: ["a"] });
  });

  it("translates strings with no placeholders at all", async () => {
    const { promise } = translate({ a: "Restore Purchases" }, [{ a: "Restaurar compras" }]);
    await expect(promise).resolves.toEqual({
      entries: { a: "Restaurar compras" },
      rejected: [],
    });
  });

  it("rejects an empty request", async () => {
    const { promise } = translate({}, [{}]);
    await expect(promise).rejects.toBeInstanceOf(TranslationInvalidError);
  });

  it("rejects more than TRANSLATE_MAX_ENTRIES in one call", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: TRANSLATE_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, "x"]),
    );
    const { promise } = translate(entries, [{}]);
    await expect(promise).rejects.toBeInstanceOf(TranslationInvalidError);
  });

  it("rejects every pending key when the model returns no object at all", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new NoObjectGeneratedError({
          message: "no object",
          text: "not json",
          response: { id: "r", timestamp: new Date(0), modelId: "mock" },
          usage: {
            inputTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: undefined },
            outputTokens: 0,
            outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
            totalTokens: 0,
          },
          finishReason: "stop",
        });
      },
    });
    await expect(
      translateEntries(
        { projectId: PROJECT_ID, sourceLocale: "en", targetLocale: "es", entries: { a: "One" } },
        { modelFactory: () => model },
      ),
    ).resolves.toEqual({ entries: {}, rejected: ["a"] });
  });
});

describe("quota", () => {
  it("bumps messages ONCE and tokens once per model call", async () => {
    const { promise } = translate({ cta: "Continue for {{price}}" }, [
      { cta: "Continuar por {{precio}}" },
      { cta: "Continuar por {{price}}" },
    ]);
    await promise;

    const yearMonth = currentYearMonth();
    const messageBumps = bumpUsageMock.mock.calls.filter((c) => "messages" in (c[0] ?? {}));
    const tokenBumps = bumpUsageMock.mock.calls.filter((c) => "inputTokens" in (c[0] ?? {}));

    expect(messageBumps).toEqual([[{ projectId: PROJECT_ID, yearMonth, messages: 1 }]]);
    // Two model calls happened (one failed the placeholder check), and both
    // were billed by the provider, so both must move the counter.
    expect(tokenBumps).toHaveLength(2);
    expect(tokenBumps[0]![0]).toMatchObject({ projectId: PROJECT_ID, yearMonth });
  });

  it("still bumps the message counter when every key is rejected", async () => {
    // The guard reads this counter. A run that calls the model and returns
    // nothing usable was still paid for, so it must not be free.
    const { promise } = translate({ cta: "Buy {{price}}" }, [
      { cta: "roto" },
      { cta: "roto" },
    ]);
    await promise;
    expect(bumpUsageMock.mock.calls.some((c) => "messages" in (c[0] ?? {}))).toBe(true);
  });

  it("does NOT bump anything when the request is rejected before the model is called", async () => {
    const { promise } = translate({}, [{}]);
    await expect(promise).rejects.toBeInstanceOf(TranslationInvalidError);
    expect(bumpUsageMock).not.toHaveBeenCalled();
  });
});
