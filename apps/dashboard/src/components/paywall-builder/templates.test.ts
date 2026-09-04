import { describe, expect, it } from "vitest";
import {
  builderConfigSchema,
  collectMediaUrls,
  isBlockingIssue,
  validateBuilderConfig,
  type PaywallNode,
} from "@rovenue/shared/paywall";
import { TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_PLACEHOLDER_ISSUE_CODES } from "./templates";

// =============================================================
// One test over EVERY catalogue entry, so a nineteenth template cannot
// skip validation by being added without a test of its own.
// =============================================================

/** The roadmap item asks for 15-20 templates; below 15 the gallery is not
 *  the feature, and above 20 the grid stops being browsable. */
const MIN_TEMPLATES = 15;
const MAX_TEMPLATES = 20;

/** A template binds to NO offering, so the validator sees an empty package
 *  set — which is exactly the condition `FOREIGN_PACKAGE_ID` fires on if a
 *  template ever names a package. `now` is pinned so a countdown template's
 *  deadline check cannot depend on the wall clock. */
const VALIDATE_OPTS = {
  offeringPackageIds: [] as string[],
  now: () => Date.parse("2026-01-01T00:00:00Z"),
};

const PLACEHOLDER_CODES: ReadonlySet<string> = new Set(TEMPLATE_PLACEHOLDER_ISSUE_CODES);

/** Every node in the tree, including cell templates and fallback subtrees. */
function walk(node: PaywallNode, visit: (n: PaywallNode) => void): void {
  visit(node);
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
  if ("cellTemplate" in node && node.cellTemplate) walk(node.cellTemplate, visit);
  if (node.fallback) walk(node.fallback, visit);
}

function nodesOf(config: ReturnType<(typeof TEMPLATES)[number]["build"]>): PaywallNode[] {
  const out: PaywallNode[] = [];
  walk(config.root, (n) => out.push(n));
  return out;
}

describe("template catalogue", () => {
  it("holds between MIN_TEMPLATES and MAX_TEMPLATES entries", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(MIN_TEMPLATES);
    expect(TEMPLATES.length).toBeLessThanOrEqual(MAX_TEMPLATES);
  });

  it("has unique ids and unique names", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length);
  });

  it("keeps the two retired preset ids resolvable", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(expect.arrayContaining(["hero", "comparison"]));
  });

  it("puts every template in a declared category, and leaves no category empty", () => {
    const declared = new Set<string>(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const t of TEMPLATES) expect(declared.has(t.category)).toBe(true);
    for (const c of TEMPLATE_CATEGORIES) {
      expect(TEMPLATES.some((t) => t.category === c.id)).toBe(true);
    }
  });

  it("gives every template a non-empty name, tag and description", () => {
    for (const t of TEMPLATES) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.tag.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
    }
  });

  describe.each(TEMPLATES.map((t) => [t.id, t] as const))("%s", (_id, template) => {
    const config = template.build("en");
    const issues = validateBuilderConfig(config, VALIDATE_OPTS);

    it("parses against the strict authoring schema", () => {
      const parsed = builderConfigSchema.safeParse(config);
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
    });

    it("raises only the known placeholder issue codes", () => {
      const unexpected = issues
        .filter((i) => !PLACEHOLDER_CODES.has(i.code))
        .map((i) => `${i.code}: ${i.message}`);
      expect(unexpected).toEqual([]);
    });

    it("is SAVE-valid — a template an author cannot even save is useless", () => {
      expect(issues.filter(isBlockingIssue)).toEqual([]);
    });

    it("references no package id and sets no defaultSelected", () => {
      for (const node of nodesOf(config)) {
        if (node.type === "packageList") {
          expect(node.packageIds).toEqual([]);
          expect(node.defaultSelected).toBeUndefined();
        }
      }
    });

    it("carries no asset URL — every media node is an empty placeholder", () => {
      expect(collectMediaUrls(config)).toEqual([]);
    });

    it("carries no baked link URL either — walked directly, not inferred", () => {
      // `collectMediaUrls` deliberately does NOT walk `footerLinks`: a link's
      // destination is an external URL the host opens, not a CDN asset the
      // publish-time usage index should claim. So the media check above says
      // nothing about link URLs, and `EMPTY_ACTION_URL` is a `.some(...)`
      // existence check that a HALF-filled footer would still satisfy — one
      // empty sibling keeps it true.
      //
      // Walk the actions instead. A template cannot know a project's legal
      // URLs, so every url-action must be the empty placeholder. This is the
      // assertion the catalogue's portability actually rests on.
      const bakedUrls: string[] = [];
      for (const node of nodesOf(config)) {
        const actions =
          node.type === "footerLinks"
            ? node.links.map((l) => l.action)
            : node.type === "button"
              ? [node.action]
              : [];
        for (const action of actions) {
          if (action.kind === "url" && action.url.trim().length > 0) {
            bakedUrls.push(`${node.id}: ${action.url}`);
          }
        }
      }
      expect(bakedUrls).toEqual([]);
    });

    it("gives every localization key its own non-empty copy in the default locale", () => {
      // UNKNOWN_LOC_KEY / EMPTY_LOC_VALUE would already have failed the
      // placeholder-code assertion above; this checks the table directly so a
      // template with a blank string is caught by name here too.
      const table = config.localizations.en ?? {};
      for (const [key, value] of Object.entries(table)) {
        expect(`${key}=${value.trim()}`).not.toBe(`${key}=`);
      }
    });

    it("ships exactly one purchase button — a paywall that cannot be bought is not a template", () => {
      const count = nodesOf(config).filter((n) => n.type === "purchaseButton").length;
      expect(count).toBe(1);
    });

    it("ends in a footerLinks row, so every template carries Restore/Terms/Privacy", () => {
      const last = config.root.children[config.root.children.length - 1];
      expect(last?.type).toBe("footerLinks");
    });

    // --- The placeholder codes are ASSERTED, not merely tolerated. ---
    //
    // Read these two for what they are: they check that the VALIDATOR still
    // flags the placeholders a template ships, so a future change that
    // silently stopped flagging them (and therefore stopped blocking the
    // publish) fails here. They are not what proves a template carries no
    // real URL — the two direct walks above are, because these are
    // `.some(...)` existence checks that a half-filled footer would satisfy.

    it("raises EMPTY_ACTION_URL for its footer's Terms/Privacy links", () => {
      expect(issues.some((i) => i.code === "EMPTY_ACTION_URL")).toBe(true);
    });

    it("raises EMPTY_MEDIA_URL exactly when it contains a media node", () => {
      const hasMedia = nodesOf(config).some(
        (n) => n.type === "image" || n.type === "video" || n.type === "lottie",
      );
      expect(issues.some((i) => i.code === "EMPTY_MEDIA_URL")).toBe(hasMedia);
    });
  });

  it("exercises the media placeholder path in at least one template", () => {
    const withMedia = TEMPLATES.filter((t) =>
      nodesOf(t.build("en")).some(
        (n) => n.type === "image" || n.type === "video" || n.type === "lottie",
      ),
    );
    expect(withMedia.length).toBeGreaterThan(0);
  });
});
