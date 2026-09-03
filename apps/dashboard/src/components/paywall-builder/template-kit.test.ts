import { describe, expect, it } from "vitest";
import { builderConfigSchema, validateBuilderConfig } from "@rovenue/shared/paywall";
import { compose, footer, headline, packages, purchaseCta } from "./template-kit";

/** A template binds to no offering, so the validator sees an empty package
 *  set -- which is exactly the condition FOREIGN_PACKAGE_ID fires on if a
 *  template ever names a package. `now` is pinned so a countdown section's
 *  deadline check cannot depend on the wall clock. */
const VALIDATE_OPTS = { offeringPackageIds: [], now: () => Date.parse("2026-01-01T00:00:00Z") };

describe("template kit", () => {
  it("composes sections into a config the strict schema accepts", () => {
    const config = compose("en", [
      headline({ id: "h", title: "Go Pro", subtitle: "Everything, unlocked." }),
      packages({ id: "p", layout: "column" }),
      purchaseCta({ id: "c", label: "Continue" }),
      footer({ id: "f", restore: "Restore Purchases", terms: "Terms", privacy: "Privacy" }),
    ]);
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
  });

  it("merges every section's copy into the default locale table", () => {
    const config = compose("en", [
      headline({ id: "h", title: "Go Pro", subtitle: "Everything, unlocked." }),
    ]);
    expect(Object.values(config.localizations.en!)).toContain("Go Pro");
    expect(Object.values(config.localizations.en!)).toContain("Everything, unlocked.");
  });

  it("gives every localization key a value — no key without copy", () => {
    const config = compose("en", [
      headline({ id: "h", title: "T" }),
      packages({ id: "p", layout: "row" }),
      purchaseCta({ id: "c", label: "Go", trialLabel: "Start free trial" }),
      footer({ id: "f", restore: "R", terms: "T", privacy: "P" }),
    ]);
    const issues = validateBuilderConfig(config, VALIDATE_OPTS);
    const missing = issues.filter((i) => i.code === "UNKNOWN_LOC_KEY" || i.code === "EMPTY_LOC_VALUE");
    expect(missing).toEqual([]);
  });

  it("namespaces node ids and locale keys by the section id, so two sections never collide", () => {
    const config = compose("en", [
      headline({ id: "a", title: "One" }),
      headline({ id: "b", title: "Two" }),
    ]);
    expect(builderConfigSchema.safeParse(config).success).toBe(true);
    const issues = validateBuilderConfig(config, VALIDATE_OPTS);
    expect(issues.filter((i) => i.code === "DUPLICATE_NODE_ID")).toEqual([]);
  });

  it("binds to no project data: no package ids, no defaultSelected, no asset urls", () => {
    const config = compose("en", [packages({ id: "p", layout: "column" })]);
    const json = JSON.stringify(config);
    expect(json).not.toContain("defaultSelected");
    const list = config.root.children.find((n) => n.type === "packageList");
    expect(list && "packageIds" in list ? list.packageIds : null).toEqual([]);
  });
});
