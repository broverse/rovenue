#!/usr/bin/env node
/**
 * verify-search-index.mjs — asserts that `react-router build` actually
 * emitted the Orama search index into build/client/, and that it is a usable
 * index rather than an empty or malformed one.
 *
 * Why this needs a guard at all: the docs image serves build/client with
 * Caddy and `try_files {path} {path}/index.html /index.html` (see
 * deploy/caddy/Caddyfile.docs). A *missing* search index therefore does not
 * 404 — Caddy answers `GET /search-index.json` with 200 and the SPA shell.
 * `oramaStaticClient` checks `res.ok`, which passes, then chokes on
 * `res.json()` in the browser. The reader sees exactly the defect this file
 * exists to prevent: a search box that opens, accepts typing, and finds
 * nothing. Nothing in the build fails, and nothing in CI notices.
 *
 * So the emission is checked here, in the `build` script itself (same place
 * and same spirit as generate:errors / generate:openapi), where a bad build
 * stops before it can be turned into an image.
 *
 * Run: `pnpm --filter @rovenue/docs verify:search-index` (part of `build`).
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
// Single source of truth for the build output paths, itself derived from the
// same `searchIndexFile` constant routes.ts registers the route under and the
// browser fetches — so a rename cannot leave this check pointed at a path that
// no longer exists while still passing.
import {
  CLIENT_BUILD_DIR,
  SEARCH_INDEX_PATH as INDEX_PATH,
} from './build-output.mjs';

const INDEX_LABEL = `build/client/${relative(CLIENT_BUILD_DIR, INDEX_PATH)}`;

// The shapes `fumadocs-core`'s `staticGET()` can export, and the shape
// `oramaStaticClient` knows how to `load()` on the client.
const EXPORTED_INDEX_TYPES = ['simple', 'advanced', 'i18n'];

function fail(message) {
  console.error(`✗ verify-search-index: ${message}`);
  process.exitCode = 1;
}

let raw;
try {
  raw = await readFile(INDEX_PATH, 'utf8');
} catch {
  fail(
    `${INDEX_PATH} is missing.\n` +
      `  The docs image has no Node process, so search reads this file directly.\n` +
      `  It is produced by prerendering app/routes/search.ts — check that\n` +
      `  react-router.config.ts still prerenders every path from getStaticPaths()\n` +
      `  and that routes.ts still registers the route.`,
  );
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  fail(`${INDEX_PATH} is not valid JSON (${err.message}).`);
  process.exit(1);
}

if (!EXPORTED_INDEX_TYPES.includes(data?.type)) {
  fail(
    `${INDEX_PATH} has type ${JSON.stringify(data?.type)}, expected one of ` +
      `${EXPORTED_INDEX_TYPES.join(', ')}. This usually means the route returned ` +
      `the SPA shell or a query response instead of an exported index.`,
  );
  process.exit(1);
}

// An index that parses but holds no documents finds nothing — the same
// user-visible outcome as no index at all, so it has to fail here too.
const documentCount =
  data.type === 'i18n'
    ? Object.values(data.data).reduce(
        (total, locale) => total + Object.keys(locale?.docs?.docs ?? {}).length,
        0,
      )
    : Object.keys(data.docs?.docs ?? {}).length;

if (documentCount === 0) {
  fail(`${INDEX_PATH} contains no documents — search would find nothing.`);
  process.exit(1);
}

console.log(
  `✓ verify-search-index: ${INDEX_LABEL} ` +
    `(${data.type}, ${documentCount} records, ${Buffer.byteLength(raw)} bytes)`,
);
