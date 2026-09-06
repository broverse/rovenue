#!/usr/bin/env node
/**
 * copy-openapi.mjs — copies apps/api/openapi/openapi.json into
 * apps/docs/public/openapi.json so the API explorer (app/components/
 * api-explorer.tsx) can fetch it as a static asset at runtime.
 *
 * Why a copy, not a workspace import: apps/api/openapi/openapi.json is a
 * committed JSON document (kept in sync with the live route table by
 * `pnpm --filter @rovenue/api openapi:check` in CI — see .github/workflows/
 * ci.yml), not a TS module apps/docs could `import` across the workspace
 * boundary without pulling apps/api's runtime deps into the docs bundle.
 * Vite's `resolveJsonModule` import would also get inlined into a JS chunk
 * at build time, which is unnecessary for a 140KB document the explorer
 * only needs in the browser, after hydration, fetched once. A plain static
 * copy is fetched like any other asset and needs no bundler support.
 *
 * Why this can't go stale: this script runs as part of `pnpm --filter
 * @rovenue/docs build` (see package.json), same as `generate:errors` for
 * api-errors.mdx — a docs build always re-reads the *current* checked-out
 * apps/api/openapi/openapi.json. The output lands in apps/docs/public/,
 * which is gitignored (matching the existing `/public/api/` SDK-reference
 * pattern) so nobody can commit a copy that then silently stops being
 * refreshed.
 *
 * Docker: the production image's builder stage only copies
 * apps/api/package.json (for `pnpm install`), not apps/api's source — see
 * apps/docs/Dockerfile, which separately `COPY`s apps/api/openapi before
 * running this build for exactly this reason.
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = join(__dirname, "..", "..", "api", "openapi", "openapi.json");
const DEST = join(__dirname, "..", "public", "openapi.json");

let raw;
try {
  raw = await readFile(SOURCE, "utf8");
} catch (err) {
  console.error(
    `✗ copy-openapi: could not read ${SOURCE}\n` +
      `  Expected apps/api/openapi/openapi.json to exist (it's a committed file, kept\n` +
      `  current by \`pnpm --filter @rovenue/api openapi:check\` in CI). If you're\n` +
      `  building inside Docker, check apps/docs/Dockerfile COPYs apps/api/openapi\n` +
      `  before \`RUN pnpm --filter @rovenue/docs build\`.`,
  );
  throw err;
}

// Fail loudly on malformed JSON rather than shipping a broken static asset
// the explorer would silently fail to parse in the browser.
JSON.parse(raw);

await mkdir(dirname(DEST), { recursive: true });
await copyFile(SOURCE, DEST);

console.log(`✓ copy-openapi: apps/api/openapi/openapi.json -> apps/docs/public/openapi.json (${raw.length} bytes)`);
