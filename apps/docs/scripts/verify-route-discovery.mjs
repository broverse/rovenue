#!/usr/bin/env node
/**
 * verify-route-discovery.mjs — asserts that the prerendered documents were
 * built with `routeDiscovery: { mode: 'initial' }`.
 *
 * Why this needs a guard: React Router's route discovery defaults to
 * `mode: 'lazy'`, which fetches `/__manifest?p=...` on every client-side
 * navigation. The docs image is `caddy:2-alpine` serving `build/client` with
 * `try_files {path} {path}/index.html /index.html` (deploy/caddy/Caddyfile.docs),
 * so `/__manifest` is not a file on disk and Caddy answers **200 with the SPA
 * shell**. The client parses that HTML as JSON, throws, and the root
 * ErrorBoundary renders "Oops!" — for every sidebar link and every search
 * result. Exactly like the missing search index, a *missing* endpoint does not
 * 404 here; it returns a page, so nothing in the build or in CI notices.
 *
 * `react-router.config.ts` opts out with `routeDiscovery: { mode: 'initial' }`,
 * which inlines the route manifest into each document. This checks the built
 * documents rather than the config file: the config is the input, the embedded
 * `window.__reactRouterContext` is what the browser actually obeys.
 *
 * Run: `pnpm --filter @rovenue/docs verify:route-discovery` (part of `build`).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  CLIENT_BUILD_DIR,
  ROUTE_DISCOVERY_INITIAL_MARKER,
  ROUTE_DISCOVERY_LAZY_MARKER,
} from './build-output.mjs';

const label = 'verify-route-discovery';
const DOCUMENT_FILENAME = 'index.html';

function fail(message) {
  console.error(`✗ ${label}: ${message}`);
  process.exit(1);
}

async function listDocuments(dir) {
  const found = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) found.push(...(await listDocuments(full)));
    else if (entry.name === DOCUMENT_FILENAME) found.push(full);
  }

  return found;
}

let documents;
try {
  documents = await listDocuments(CLIENT_BUILD_DIR);
} catch (err) {
  fail(`could not read ${CLIENT_BUILD_DIR} (${err.message}).`);
}

if (documents.length === 0) {
  fail(
    `found no ${DOCUMENT_FILENAME} under ${CLIENT_BUILD_DIR} — prerendering ` +
      `produced nothing, so there is nothing to check. Run react-router build ` +
      `first, and see the prerender() list in react-router.config.ts.`,
  );
}

const offenders = [];
for (const document of documents) {
  const html = await readFile(document, 'utf8');
  if (!html.includes(ROUTE_DISCOVERY_INITIAL_MARKER)) {
    offenders.push({
      path: relative(CLIENT_BUILD_DIR, document),
      lazy: html.includes(ROUTE_DISCOVERY_LAZY_MARKER),
    });
  }
}

if (offenders.length > 0) {
  const lazy = offenders.filter((offender) => offender.lazy).length;

  fail(
    `${offenders.length} of ${documents.length} prerendered documents do not ` +
      `embed ${ROUTE_DISCOVERY_INITIAL_MARKER}` +
      (lazy > 0 ? ` (${lazy} of them embed lazy route discovery instead)` : '') +
      `.\n` +
      `  First offenders: ${offenders
        .slice(0, 5)
        .map((offender) => offender.path)
        .join(', ')}\n` +
      `  Restore routeDiscovery: { mode: 'initial' } in react-router.config.ts.\n` +
      `  Without it the client fetches /__manifest on every client-side\n` +
      `  navigation; Caddy has no such file and answers 200 with the SPA shell,\n` +
      `  so the client throws parsing HTML as JSON and every sidebar link and\n` +
      `  search result lands on the root ErrorBoundary.`,
  );
}

console.log(
  `✓ ${label}: ${documents.length} prerendered documents embed ` +
    `${ROUTE_DISCOVERY_INITIAL_MARKER}`,
);
