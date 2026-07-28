import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { builderConfigSchema, OVERRIDABLE_PROP_KEYS } from "./schema";
import { resolveText } from "./validate";
import { isNodeVisible, type NodeVisibility, type VisibilityPlatform } from "./visibility";
import { resolveCtaLabelKey, resolveVariables, type PackageView } from "./variables";
import type { BuilderConfig, PaywallNode } from "./schema";

// =============================================================
// render-fixtures.json — the cross-platform contract file.
//
// Swift (Codable) and Kotlin (kotlinx-serialization) builder-config
// decoders assert against the SAME file (Phase C). This suite guards
// the fixture against rot on the TS side:
//   - every `accept` config passes the strict authoring schema,
//   - every `acceptLenient` config FAILS the strict schema (they
//     contain unknown node types platform decoders must tolerate by
//     falling back — the asymmetry is deliberate, see _comment),
//   - every `reject` config fails the schema,
//   - variable / resolveText vectors match the real implementations.
// =============================================================

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "render-fixtures.json",
);

interface Fixture {
  _comment: string;
  accept: Array<{ name: string; config: unknown }>;
  acceptLenient: Array<{ name: string; config: unknown }>;
  reject: Array<{ name: string; reason: string; config: unknown }>;
  variables: Array<{
    text: string;
    pkg: PackageView | null;
    expected: string;
  }>;
  resolveText: Array<{
    locale: string;
    key: string;
    expected: string | null;
  }>;
  visibility: Array<{
    name: string;
    visibility: NodeVisibility;
    // Deliberately `string`, not `VisibilityPlatform`: the table carries a
    // blank-platform case that TS's own types forbid but the native ports'
    // nullable String allows, so the contract can pin all four on it.
    platform: string | null;
    appVersion: string | null;
    expected: boolean;
  }>;
  // The cross-platform defaults Swift/Kotlin hand-mirror (see schema.ts's
  // DIVIDER_DEFAULT_*/FEATURE_ROW_*/TIMELINE_*/SOCIAL_PROOF_* constants).
  // Generated from those exports, not retyped — see the generation note
  // near the bottom of this file.
  defaults: Record<string, unknown>;
  // Task 9 — which loc key a purchaseButton renders (`resolveCtaLabelKey`),
  // consumed by Tasks 10-12's native/RN CTA rendering.
  trialLabel: {
    _comment: string;
    cases: Array<{
      name: string;
      trialLabelKey?: string;
      labelKey: string;
      selectedHasIntroPeriod: boolean | null;
      expectedKey: string;
    }>;
  };
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("render-fixtures contract", () => {
  it("has the required coverage counts", () => {
    expect(fixture.accept.length).toBeGreaterThanOrEqual(6);
    expect(fixture.acceptLenient.length).toBeGreaterThanOrEqual(1);
    expect(fixture.reject.length).toBeGreaterThanOrEqual(5);
    expect(fixture.variables.length).toBeGreaterThanOrEqual(8);
    expect(fixture.resolveText.length).toBeGreaterThanOrEqual(4);
    expect(fixture.visibility.length).toBeGreaterThanOrEqual(14);
    expect(fixture._comment).toContain("lenient");
  });

  describe("accept", () => {
    for (const c of fixture.accept) {
      it(`schema accepts: ${c.name}`, () => {
        const r = builderConfigSchema.safeParse(c.config);
        expect(r.success, JSON.stringify((r as { error?: unknown }).error)).toBe(true);
      });
    }
  });

  describe("acceptLenient (strict schema must REJECT these)", () => {
    for (const c of fixture.acceptLenient) {
      it(`strict schema rejects: ${c.name}`, () => {
        expect(builderConfigSchema.safeParse(c.config).success).toBe(false);
      });
    }
  });

  describe("reject", () => {
    for (const c of fixture.reject) {
      it(`schema rejects: ${c.name} (${c.reason})`, () => {
        expect(builderConfigSchema.safeParse(c.config).success).toBe(false);
      });
    }
  });

  describe("variables vectors", () => {
    fixture.variables.forEach((v, i) => {
      it(`vector ${i}: ${JSON.stringify(v.text).slice(0, 40)}`, () => {
        expect(resolveVariables(v.text, v.pkg)).toBe(v.expected);
      });
    });
  });

  // Selected BY NAME, never by index. The native decoders already do this
  // (`entries.first { name.hasPrefix(...) }` in Swift, `entryWithNamePrefix`
  // in Kotlin) after an index-based access silently repointed two Kotlin
  // tests at a different config when the fixture was widened. New entries
  // have only ever been appended so far, but a future PREPEND would repoint
  // this vector table exactly as silently — and every `resolveText`
  // expectation below is written against the multi-locale config's
  // `localizations`, not against whichever config happens to be first.
  const RESOLVE_TEXT_CONFIG_NAME_PREFIX = "canonical every-node";

  describe(`resolveText vectors (against "${RESOLVE_TEXT_CONFIG_NAME_PREFIX}…")`, () => {
    const entry = fixture.accept.find((c) => c.name.startsWith(RESOLVE_TEXT_CONFIG_NAME_PREFIX));
    // Renaming or dropping that entry fails the file loudly at collection
    // time, which is the point: the alternative is vectors quietly running
    // against a config that never carried the keys they assert.
    if (!entry) {
      throw new Error(
        `render-fixtures.json has no accept entry named "${RESOLVE_TEXT_CONFIG_NAME_PREFIX}…"`,
      );
    }
    const config = entry.config as BuilderConfig;
    for (const v of fixture.resolveText) {
      it(`${v.locale}/${v.key} → ${JSON.stringify(v.expected)}`, () => {
        expect(resolveText(config, v.locale, v.key)).toBe(v.expected);
      });
    }
  });

  // Task 9 — `resolveCtaLabelKey`: which loc key a purchaseButton renders,
  // given its own labelKey/trialLabelKey and the current selection's
  // introPeriod. `selectedHasIntroPeriod` is the fixture's boolean/null
  // shorthand for a `PackageView`-shaped selection: `true` -> a selected
  // package mid-trial (`introPeriod` set), `false` -> a selected package
  // with no trial (`introPeriod` absent), `null` -> no selection at all.
  describe("trialLabel vectors", () => {
    function toSelected(
      selectedHasIntroPeriod: boolean | null,
    ): { introPeriod?: string } | null {
      if (selectedHasIntroPeriod === null) return null;
      return selectedHasIntroPeriod ? { introPeriod: "1 week" } : {};
    }

    for (const c of fixture.trialLabel.cases) {
      it(c.name, () => {
        expect(
          resolveCtaLabelKey(
            { labelKey: c.labelKey, trialLabelKey: c.trialLabelKey },
            toSelected(c.selectedHasIntroPeriod),
          ),
        ).toBe(c.expectedKey);
      });
    }
  });

  // The four-platform contract for node visibility. `isNodeVisible` is the
  // reference implementation these pin; stage 2's SwiftUI/Kotlin/RN
  // evaluators run the SAME table and must agree case-for-case.
  describe("visibility vectors", () => {
    for (const v of fixture.visibility) {
      it(`${v.name}`, () => {
        expect(
          isNodeVisible(v.visibility, {
            platform: v.platform as VisibilityPlatform | null,
            appVersion: v.appVersion,
          }),
        ).toBe(
          v.expected,
        );
      });
    }
  });

  // Guards the fixture itself against the exact gap a fix-wave review
  // found: featureList/timeline/socialProof (and, it turned out, divider/
  // icon) had ZERO coverage in accept/acceptLenient despite native
  // renderers shipping against them. `nodeTypes` is derived from
  // `OVERRIDABLE_PROP_KEYS`'s own keys rather than hand-written here — that
  // Record is typed `Record<PaywallNode["type"], readonly string[]>`, so
  // TypeScript itself guarantees its keys are exactly the PaywallNode union
  // members (a missing/extra key fails `schema.ts`'s own compile). A
  // hand-written list in the test would have quietly reproduced the same
  // bug this test exists to catch.
  describe("node-type union coverage", () => {
    const nodeTypes = Object.keys(OVERRIDABLE_PROP_KEYS) as Array<PaywallNode["type"]>;

    function collectNodeTypes(value: unknown, into: Set<string>): void {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) collectNodeTypes(item, into);
        return;
      }
      const obj = value as Record<string, unknown>;
      if (typeof obj.type === "string") into.add(obj.type);
      for (const key of Object.keys(obj)) collectNodeTypes(obj[key], into);
    }

    it("declares at least one PaywallNode member", () => {
      expect(nodeTypes.length).toBeGreaterThan(0);
    });

    it("every PaywallNode type appears somewhere in accept or acceptLenient", () => {
      const present = new Set<string>();
      for (const entry of [...fixture.accept, ...fixture.acceptLenient]) {
        collectNodeTypes(entry.config, present);
      }
      const missing = nodeTypes.filter((t) => !present.has(t));
      expect(missing, `node types missing from the fixture: ${missing.join(", ")}`).toEqual([]);
    });
  });

  // The cross-platform defaults Swift/Kotlin hand-mirror (no count stated
  // here on purpose — the list grows, and a stale number reads as a missing
  // entry). This only pins that the TS side carries the right values through
  // to the fixture — see BuilderConfigModelTests.swift / NodeViewFactoryTest.kt
  // for the native mutation-checked comparisons against THIS object by value.
  describe("defaults", () => {
    it("matches schema.ts's exported constants", async () => {
      const schema = await import("./schema");
      expect(fixture.defaults).toEqual({
        DIVIDER_DEFAULT_THICKNESS: schema.DIVIDER_DEFAULT_THICKNESS,
        DIVIDER_DEFAULT_INSET: schema.DIVIDER_DEFAULT_INSET,
        DIVIDER_DEFAULT_COLOR: schema.DIVIDER_DEFAULT_COLOR,
        FEATURE_ROW_DEFAULT_ICON: schema.FEATURE_ROW_DEFAULT_ICON,
        FEATURE_ROW_EXCLUDED_ICON: schema.FEATURE_ROW_EXCLUDED_ICON,
        FEATURE_ROW_DEFAULT_INCLUDED: schema.FEATURE_ROW_DEFAULT_INCLUDED,
        TIMELINE_ROW_DEFAULT_ICON: schema.TIMELINE_ROW_DEFAULT_ICON,
        TIMELINE_CONNECTOR_DEFAULT_COLOR: schema.TIMELINE_CONNECTOR_DEFAULT_COLOR,
        SOCIAL_PROOF_STAR_DEFAULT_COLOR: schema.SOCIAL_PROOF_STAR_DEFAULT_COLOR,
        SOCIAL_PROOF_MAX_RATING: schema.SOCIAL_PROOF_MAX_RATING,
        COUNTDOWN_DEFAULT_ON_EXPIRY: schema.COUNTDOWN_DEFAULT_ON_EXPIRY,
        COUNTDOWN_TICK_MS: schema.COUNTDOWN_TICK_MS,
        COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX: schema.COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX,
        STICKY_FOOTER_DEFAULT_BACKGROUND: schema.STICKY_FOOTER_DEFAULT_BACKGROUND,
        STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT: schema.STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT,
        CAROUSEL_DEFAULT_SHOWS_INDICATOR: schema.CAROUSEL_DEFAULT_SHOWS_INDICATOR,
        CAROUSEL_DEFAULT_LOOP: schema.CAROUSEL_DEFAULT_LOOP,
        CAROUSEL_MIN_AUTO_ADVANCE_SECONDS: schema.CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
      });
    });

    // Wave D1 — the three new keys, asserted individually and by value (not
    // merely via the object-equality check above), per the brief's explicit
    // instruction: this is what Task 5 (Swift) and Task 6 (Kotlin) mirror in
    // their own by-value sync tests.
    it("carries the three carousel defaults by value", async () => {
      const schema = await import("./schema");
      expect(fixture.defaults.CAROUSEL_DEFAULT_SHOWS_INDICATOR).toBe(
        schema.CAROUSEL_DEFAULT_SHOWS_INDICATOR,
      );
      expect(fixture.defaults.CAROUSEL_DEFAULT_LOOP).toBe(schema.CAROUSEL_DEFAULT_LOOP);
      expect(fixture.defaults.CAROUSEL_MIN_AUTO_ADVANCE_SECONDS).toBe(
        schema.CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
      );
    });
  });
});
