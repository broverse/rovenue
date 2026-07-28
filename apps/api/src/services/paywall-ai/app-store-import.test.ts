import { describe, expect, it, vi } from "vitest";
import {
  AppStoreLookupError,
  buildImportTree,
  fetchAppStoreListing,
  IMPORT_MAX_DESCRIPTION_CHARS,
  IMPORT_MAX_SCREENSHOTS,
  parseAppStoreUrl,
  type AppStoreListing,
} from "./app-store-import";
import { GeneratedConfigError } from "./validate-config";

// =============================================================
// App Store import (P8 §6.14): URL parsing, iTunes lookup mapping,
// and draft-tree assembly. The tree builder's output must clear the
// SAVE tier (assertSaveValid) — publish-tier gaps are deliberate.
// =============================================================

describe("parseAppStoreUrl", () => {
  it("parses a country-prefixed listing URL", () => {
    expect(
      parseAppStoreUrl("https://apps.apple.com/tr/app/super-app/id1234567890"),
    ).toEqual({ appId: "1234567890", country: "tr" });
  });

  it("defaults the country to us when the path has no country segment", () => {
    expect(parseAppStoreUrl("https://apps.apple.com/app/super-app/id999")).toEqual({
      appId: "999",
      country: "us",
    });
  });

  it("rejects a non-apple host", () => {
    expect(parseAppStoreUrl("https://example.com/tr/app/super-app/id123")).toBeNull();
  });

  it("rejects a path without an id segment", () => {
    expect(parseAppStoreUrl("https://apps.apple.com/tr/app/super-app")).toBeNull();
  });

  it("rejects garbage that is not a URL at all", () => {
    expect(parseAppStoreUrl("not a url")).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const LOOKUP_RESULT = {
  resultCount: 1,
  results: [
    {
      trackName: "Super App",
      description: "The best app.",
      artworkUrl512: "https://is1-ssl.mzstatic.com/icon512.png",
      screenshotUrls: [
        "https://is1-ssl.mzstatic.com/s1.png",
        "https://is1-ssl.mzstatic.com/s2.png",
        "https://is1-ssl.mzstatic.com/s3.png",
        "https://is1-ssl.mzstatic.com/s4.png",
        "https://is1-ssl.mzstatic.com/s5.png",
      ],
      artistName: "Super Corp",
    },
  ],
};

describe("fetchAppStoreListing", () => {
  it("maps the lookup response onto AppStoreListing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LOOKUP_RESULT)) as unknown as typeof fetch;
    const listing = await fetchAppStoreListing({ appId: "123", country: "tr" }, { fetchImpl });
    expect(listing).toEqual({
      name: "Super App",
      description: "The best app.",
      iconUrl: "https://is1-ssl.mzstatic.com/icon512.png",
      screenshotUrls: LOOKUP_RESULT.results[0]!.screenshotUrls,
      artistName: "Super Corp",
    });
    const calledUrl = String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(calledUrl).toContain("itunes.apple.com/lookup");
    expect(calledUrl).toContain("id=123");
    expect(calledUrl).toContain("country=tr");
  });

  it("throws APP_NOT_FOUND when resultCount is 0", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ resultCount: 0, results: [] }),
    ) as unknown as typeof fetch;
    await expect(fetchAppStoreListing({ appId: "1", country: "us" }, { fetchImpl })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
    });
  });

  it("throws APP_STORE_LOOKUP_FAILED on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    await expect(fetchAppStoreListing({ appId: "1", country: "us" }, { fetchImpl })).rejects.toMatchObject({
      code: "APP_STORE_LOOKUP_FAILED",
    });
  });

  it("throws APP_STORE_LOOKUP_FAILED on malformed JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not-json{", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchAppStoreListing({ appId: "1", country: "us" }, { fetchImpl })).rejects.toBeInstanceOf(
      AppStoreLookupError,
    );
  });
});

function listing(overrides: Partial<AppStoreListing> = {}): AppStoreListing {
  return {
    name: "Super App",
    description: "Short and sweet.",
    iconUrl: "https://is1-ssl.mzstatic.com/icon512.png",
    screenshotUrls: LOOKUP_RESULT.results[0]!.screenshotUrls,
    artistName: "Super Corp",
    ...overrides,
  };
}

function collectIds(node: { id: string; children?: unknown[] }, out: string[] = []): string[] {
  out.push(node.id);
  for (const child of (node.children ?? []) as Array<{ id: string; children?: unknown[] }>) {
    collectIds(child, out);
  }
  return out;
}

describe("buildImportTree", () => {
  it("assembles icon, title, body, screenshot carousel and the commerce skeleton", () => {
    const config = buildImportTree(listing(), "en");
    const types = config.root.children.map((c) => c.type);
    expect(types).toEqual(["image", "text", "text", "carousel", "packageList", "purchaseButton"]);
    const carousel = config.root.children.find((c) => c.type === "carousel") as {
      children: Array<{ type: string }>;
    };
    expect(carousel.children).toHaveLength(IMPORT_MAX_SCREENSHOTS);
    expect(carousel.children.every((c) => c.type === "image")).toBe(true);
  });

  it("puts every string into the default locale's table, never node structure", () => {
    const config = buildImportTree(listing(), "en");
    const table = config.localizations.en!;
    expect(Object.values(table)).toContain("Super App");
    const titleNode = config.root.children.find((c) => c.type === "text") as { key: string };
    expect(table[titleNode.key]).toBe("Super App");
  });

  it("truncates the description at a word boundary with an ellipsis", () => {
    const longWordy = `${"word ".repeat(80)}tail`;
    const config = buildImportTree(listing({ description: longWordy }), "en");
    const table = config.localizations.en!;
    const body = Object.values(table).find((v) => v.startsWith("word")) as string;
    expect(body.length).toBeLessThanOrEqual(IMPORT_MAX_DESCRIPTION_CHARS + 1); // +1 for the ellipsis char
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toMatch(/wor…$/); // never cut mid-word
  });

  it("omits the carousel when there are no screenshots and the body when the description is empty", () => {
    const config = buildImportTree(listing({ screenshotUrls: [], description: "" }), "en");
    const types = config.root.children.map((c) => c.type);
    expect(types).not.toContain("carousel");
    expect(types.filter((t) => t === "text")).toHaveLength(1); // title only
  });

  it("produces unique node ids and passes assertSaveValid", () => {
    const config = buildImportTree(listing(), "en");
    const ids = collectIds(config.root as { id: string; children?: unknown[] });
    expect(new Set(ids).size).toBe(ids.length);
    // buildImportTree already calls assertSaveValid internally; reaching here
    // without a throw IS the assertion, but pin the contract explicitly too:
    expect(() => buildImportTree(listing(), "en")).not.toThrow();
  });

  it("rejects a hostile javascript: iconUrl via assertSaveValid's URL-scheme gate", () => {
    // Nothing in this module itself validates the listing's URLs — the
    // iTunes lookup response is untrusted the same way a user-supplied
    // string would be. The gate lives in assertSaveValid, which
    // buildImportTree already funnels its result through.
    expect(() => buildImportTree(listing({ iconUrl: "javascript:alert(1)" }), "en")).toThrow(
      GeneratedConfigError,
    );
  });
});
