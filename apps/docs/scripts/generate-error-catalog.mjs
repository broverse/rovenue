#!/usr/bin/env node
/**
 * generate-error-catalog.mjs — renders `ERROR_CATALOG` (packages/shared/src/
 * error-catalog.ts) into content/docs/reference/api-errors.mdx.
 *
 * Why generated: `ERROR_CATALOG` is typed as a TOTAL
 * `Record<keyof typeof ERROR_CODE, ErrorCatalogEntry>`, so an undocumented
 * error code is a TypeScript compile error, not a doc that quietly falls out
 * of date. Rendering it by hand would throw that guarantee away the moment
 * someone edited the .mdx directly instead of the source Record. Run via
 * `pnpm --filter @rovenue/docs generate:errors`; also wired into `build` so a
 * built image can never ship a stale page.
 *
 * WIRE VALUE, not the object key: `entry.code` is what actually appears in
 * an API response's `error.code`. Five keys are SCREAMING_CASE while their
 * `code` is lowercase (ASSET_IN_USE -> asset_in_use, ASSET_MISSING,
 * PURCHASE_NOT_PAID, APPLE_OFFER_SIGNING_UNAVAILABLE,
 * APPLE_OFFER_SIGNING_FAILED). Emitting the key instead would publish five
 * strings no client could ever match against a real response.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `ERROR_CATALOG` is imported from the dedicated subpath, not the package
// root (`@rovenue/shared`) — see the comment above `export * from
// "./error-catalog"` (removed) in packages/shared/src/index.ts. Re-exporting
// it from the barrel made this file and error-catalog.ts mutually dependent;
// error-catalog.ts dereferences `ERROR_CODE` eagerly at module-evaluation
// time, so plain Node ESM (which this script runs under, via `tsx`) hit
// `ReferenceError: Cannot access 'ERROR_CODE' before initialization` —
// Vitest's bundler-aware resolver hid the same cycle completely.
import { ERROR_CATALOG } from "@rovenue/shared/error-catalog";
import { ERROR_CODE } from "@rovenue/shared";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const OUT_FILE = join(__dirname, "..", "content", "docs", "reference", "api-errors.mdx");
const SOURCE_PATH = "packages/shared/src/error-catalog.ts";

// `tsx` type-strips rather than type-checks, so the compile-time guarantee
// that every ERROR_CODE key has a catalog entry (and vice versa) isn't
// actually enforced when this script runs. Re-check it at runtime so a
// drift here fails the generator loudly instead of silently publishing a
// partial page.
const codeKeys = Object.keys(ERROR_CODE).sort();
const catalogKeys = Object.keys(ERROR_CATALOG).sort();
if (codeKeys.length !== catalogKeys.length || codeKeys.some((k, i) => k !== catalogKeys[i])) {
  throw new Error(
    `ERROR_CATALOG keys don't match ERROR_CODE keys.\n  ERROR_CODE: ${codeKeys.join(", ")}\n  ERROR_CATALOG: ${catalogKeys.join(", ")}`,
  );
}

// Entries whose real-world behavior would be misleading if it only showed
// up in a single-line table cell — called out with a Callout instead of
// being flattened into the table row.
const CALLOUT_KEYS = new Set(["HTTP_ERROR", "INTERNAL_ERROR"]);

/** rehype-slug-style anchor: lowercase, matches how fumadocs slugs headings. */
function anchorFor(code) {
  return code.toLowerCase();
}

const entries = Object.entries(ERROR_CATALOG); // preserves source declaration order

const quickRefRows = entries
  .map(([, entry]) => `| [\`${entry.code}\`](#${anchorFor(entry.code)}) | \`${entry.httpStatus}\` |`)
  .join("\n");

const sections = entries
  .map(([key, entry]) => {
    const heading = `### \`${entry.code}\`\n\n**HTTP status:** \`${entry.httpStatus}\``;
    const body = CALLOUT_KEYS.has(key)
      ? `\n\n<Callout type="warn">\n${entry.summary}\n</Callout>`
      : `\n\n${entry.summary}`;
    const resolution = `\n\n**What to do:** ${entry.resolution}`;
    return `${heading}${body}${resolution}`;
  })
  .join("\n\n---\n\n");

const mdx = `---
title: API Errors
description: Every error code the API can return, documented by its exact wire value.
---

{/*
  GENERATED FILE — DO NOT EDIT BY HAND.
  Source: ${SOURCE_PATH}
  Regenerate: pnpm --filter @rovenue/docs generate:errors
  (also runs automatically as part of this app's \`build\` script)
*/}

import { Callout } from 'fumadocs-ui/components/callout';

Every Rovenue API response is either \`{ data: T }\` or \`{ error: { code, message } }\`. This page documents every value \`error.code\` can take — the exact string returned on the wire, alongside the HTTP status it ships with, what it means, and what to do about it.

Looking for **SDK** errors instead — the \`RovenueError\`/\`RovenueException\` \`kind\` thrown by the React Native, Swift, and Kotlin SDKs? See [SDK Errors](/docs/reference/errors); this page is the *API's* \`{ error: { code, message } }\` envelope, a different (and larger) set aimed at anyone calling the HTTP API directly rather than through an SDK.

<Callout type="warn">
Five codes are lowercase on the wire even though their name in the API's source is SCREAMING_CASE: \`asset_in_use\`, \`asset_missing\`, \`purchase_not_paid\`, \`apple_offer_signing_unavailable\`, \`apple_offer_signing_failed\`. Match on the exact string in the table below — not an uppercased guess.
</Callout>

---

## Quick reference

| Code | HTTP status |
|------|-------------|
${quickRefRows}

---

## Codes

${sections}
`;

await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, mdx, "utf8");

console.log(`Generated ${entries.length} error-code entries -> ${OUT_FILE}`);
