import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Apple Pay only appears on the funnel paywall if Stripe can verify the
// funnel domain, and Stripe verifies it by fetching
// `/.well-known/apple-developer-merchantid-domain-association` from that
// domain. The funnel is served from the dashboard's static origin, so the
// file ships in `public/`. Delete it and the SPA fallback answers that
// path with a 200 of `index.html` — verification fails while looking like
// it succeeded, and Apple Pay silently never renders. This test is the
// tripwire: it must exist and be Stripe's real file, not an HTML page.
describe("Apple Pay domain association file", () => {
  // vitest runs this package with cwd = apps/dashboard; fall back to the
  // repo-root layout in case it is ever run from there.
  const rel = "public/.well-known/apple-developer-merchantid-domain-association";
  const path = existsSync(resolve(process.cwd(), rel))
    ? resolve(process.cwd(), rel)
    : resolve(process.cwd(), "apps/dashboard", rel);

  it("exists and is the association file, not an HTML fallback", () => {
    const contents = readFileSync(path, "utf8");
    // Stripe's file is a substantial opaque token; index.html would be
    // short and start with a doctype/tag.
    expect(contents.length).toBeGreaterThan(1000);
    expect(contents.trimStart().startsWith("<")).toBe(false);
  });
});
