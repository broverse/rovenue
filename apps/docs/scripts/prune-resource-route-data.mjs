#!/usr/bin/env node
/**
 * prune-resource-route-data.mjs — deletes every dead single-fetch payload
 * (`<route>.data`) from the docs build output.
 *
 * React Router emits a `<route>.data` sibling for each prerendered path: the
 * payload a *client-side* navigation to that route would download instead of a
 * full document. For a **resource route** — a route module that exports a
 * `loader` and no default component — there is no such navigation. It has
 * nothing to render on the client, so the browser only ever fetches its real
 * URL (`/search-index.json`, `/llms.txt`, `/og/docs/<page>/image.webp`), never
 * the `.data`. Those payloads are pure image weight.
 *
 * ## How a route is classified — from the build, not from a list here
 *
 * `react-router build` writes its own client manifest to
 * `build/client/assets/manifest-<version>.js`, and every route entry in it
 * carries `hasDefaultExport`. That flag is the build's own answer to "can the
 * client router render this route?", so it — not a hand-maintained list of
 * filenames — is what this script partitions on. Adding, renaming or removing
 * a route changes the manifest, and this script follows it automatically.
 *
 * At the time of writing that partition is:
 *
 *   hasDefaultExport: true   root, routes/home, routes/docs, routes/not-found
 *   hasDefaultExport: false  routes/search, routes/og.docs, llms/index,
 *                            llms/full, llms/mdx
 *
 * The five resource routes' client modules are emitted as *empty files* (all
 * five share one 0-byte chunk), which is the same fact from the other side:
 * there is no client code to run, so there is no client navigation to feed.
 *
 * The `.data` files of routes with a default export are load-bearing — they
 * are exactly what sidebar links and search-result clicks fetch — and deleting
 * one breaks navigation to that page. Hence the guards below.
 *
 * ## Why this fails loudly rather than shrugging
 *
 * A prune step that quietly finds nothing to do is a step that has silently
 * stopped working, and the only symptom is a fatter image. So this fails when:
 *
 *   - the client manifest is missing, ambiguous or unparseable;
 *   - the manifest declares no resource routes at all;
 *   - a prerendered resource route contributes no `.data` payload to remove
 *     (`RESOURCE_ROUTE_PATHS_NOT_PRERENDERED` in `scripts/build-output.mjs` is
 *     the one, documented, exception — and a stale entry in it fails too);
 *   - nothing at all was selected for removal;
 *   - a `.data` file is claimed by both a resource route and a page route
 *     (an ambiguous route table — a human has to look);
 *   - the set of files that actually disappeared differs, by name, from the
 *     set this script intended to remove.
 *
 * Run: `pnpm --filter @rovenue/docs prune:resource-route-data` (part of
 * `build`, immediately after `react-router build`).
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  CLIENT_ASSETS_DIR,
  CLIENT_BUILD_DIR,
  CLIENT_MANIFEST_ASSIGNMENT,
  CLIENT_MANIFEST_PREFIX,
  CLIENT_MANIFEST_SUFFIX,
  RESOURCE_ROUTE_PATHS_NOT_PRERENDERED,
  SINGLE_FETCH_DATA_SUFFIX,
  SPLAT_PATH_SUFFIX,
} from './build-output.mjs';

const label = 'prune-resource-route-data';

function fail(message) {
  console.error(`✗ ${label}: ${message}`);
  process.exit(1);
}

/** Every `*.data` file under build/client, as paths relative to it. */
async function listDataFiles(dir) {
  const found = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await listDataFiles(full)));
    } else if (entry.name.endsWith(SINGLE_FETCH_DATA_SUFFIX)) {
      found.push(relative(CLIENT_BUILD_DIR, full));
    }
  }

  return found;
}

async function readClientManifest() {
  let entries;
  try {
    entries = await readdir(CLIENT_ASSETS_DIR);
  } catch {
    fail(
      `build/client/assets is not there.\n` +
        `  react-router build must run before this step.`,
    );
  }

  const candidates = entries.filter(
    (name) =>
      name.startsWith(CLIENT_MANIFEST_PREFIX) &&
      name.endsWith(CLIENT_MANIFEST_SUFFIX),
  );

  if (candidates.length !== 1) {
    fail(
      `expected exactly one build/client/assets/${CLIENT_MANIFEST_PREFIX}*` +
        `${CLIENT_MANIFEST_SUFFIX}, found ${candidates.length}` +
        `${candidates.length ? `: ${candidates.join(', ')}` : ''}.\n` +
        `  This script classifies routes from that manifest; without exactly\n` +
        `  one it cannot tell which .data files are dead, and guessing would\n` +
        `  risk deleting a payload real navigation depends on.`,
    );
  }

  const path = join(CLIENT_ASSETS_DIR, candidates[0]);
  const source = await readFile(path, 'utf8');

  if (!source.startsWith(CLIENT_MANIFEST_ASSIGNMENT)) {
    fail(
      `build/client/assets/${candidates[0]} does not start with ` +
        `\`${CLIENT_MANIFEST_ASSIGNMENT}\`.\n` +
        `  React Router changed how it emits the client manifest; update\n` +
        `  scripts/build-output.mjs rather than letting this step guess.`,
    );
  }

  const literal = source
    .slice(CLIENT_MANIFEST_ASSIGNMENT.length)
    .trim()
    .replace(/;$/, '');

  try {
    return JSON.parse(literal);
  } catch (err) {
    fail(
      `build/client/assets/${candidates[0]} did not parse as JSON ` +
        `(${err.message}).`,
    );
  }
}

/**
 * A predicate over `.data` paths (relative to build/client) for one route
 * path. `llms.txt` owns exactly `llms.txt.data`; the splat route `og/docs/*`
 * owns `og/docs.data` and everything beneath `og/docs/`.
 */
function ownsDataPath(routePath) {
  if (routePath.endsWith(SPLAT_PATH_SUFFIX)) {
    const prefix = routePath.slice(0, -SPLAT_PATH_SUFFIX.length);

    return (dataPath) =>
      dataPath === `${prefix}${SINGLE_FETCH_DATA_SUFFIX}` ||
      dataPath.startsWith(`${prefix}/`);
  }

  return (dataPath) => dataPath === `${routePath}${SINGLE_FETCH_DATA_SUFFIX}`;
}

const manifest = await readClientManifest();
const routes = Object.values(manifest.routes ?? {});

// `path` is absent on the index route and empty on root; neither owns a
// `.data` sibling of its own, and matching on "" would claim everything.
const routed = routes.filter((route) => route.path);
const resourceRoutes = routed.filter((route) => route.hasDefaultExport !== true);
const pageRoutes = routed.filter((route) => route.hasDefaultExport === true);

if (resourceRoutes.length === 0) {
  fail(
    `the client manifest declares no resource routes (every route has a\n` +
      `  default export), so there is nothing this step could ever delete.\n` +
      `  Either the routes changed — drop this script and its "prune:" entry\n` +
      `  in package.json — or the manifest shape did, and the classification\n` +
      `  above is now reading the wrong field. Both need a human.`,
  );
}

const before = await listDataFiles(CLIENT_BUILD_DIR);

const doomed = new Set();
const ambiguous = [];

for (const dataPath of before) {
  const owningResource = resourceRoutes.find((route) =>
    ownsDataPath(route.path)(dataPath),
  );
  if (!owningResource) continue;

  const owningPage = pageRoutes.find((route) =>
    ownsDataPath(route.path)(dataPath),
  );
  if (owningPage) {
    ambiguous.push(
      `${dataPath} (resource ${owningResource.id} / page ${owningPage.id})`,
    );
    continue;
  }

  doomed.add(dataPath);
}

if (ambiguous.length > 0) {
  fail(
    `these .data files are claimed by both a resource route and a page ` +
      `route: ${ambiguous.join(', ')}.\n` +
      `  A page route's .data is what client-side navigation fetches, so an\n` +
      `  ambiguous claim cannot be resolved by deleting. Fix the overlapping\n` +
      `  route paths in app/routes.ts.`,
  );
}

// The excused list must describe routes that actually exist, or it is quietly
// excusing nothing while a real route slips past unchecked.
const stale = RESOURCE_ROUTE_PATHS_NOT_PRERENDERED.filter(
  (path) => !resourceRoutes.some((route) => route.path === path),
);
if (stale.length > 0) {
  fail(
    `RESOURCE_ROUTE_PATHS_NOT_PRERENDERED names route path(s) that are no ` +
      `longer resource routes: ${stale.join(', ')}.\n` +
      `  Remove them from scripts/build-output.mjs — a stale exemption is an\n` +
      `  exemption that could later excuse a route it was never meant to.`,
  );
}

// Every resource route that IS prerendered must have produced at least one
// payload to delete. Otherwise the prune has silently stopped covering that
// route and its payloads are back in the image with nothing to say so.
for (const route of resourceRoutes) {
  if (RESOURCE_ROUTE_PATHS_NOT_PRERENDERED.includes(route.path)) continue;

  const owns = ownsDataPath(route.path);
  if (![...doomed].some(owns)) {
    fail(
      `resource route ${route.id} (${route.path}) has no ` +
        `${SINGLE_FETCH_DATA_SUFFIX} payload to remove.\n` +
        `  This step exists to delete payloads like it, so their absence means\n` +
        `  one of:\n` +
        `    - React Router no longer emits single-fetch siblings for resource\n` +
        `      routes — drop this script and its "prune:" entry in package.json;\n` +
        `    - the route path moved, or it stopped being prerendered (if that\n` +
        `      is deliberate, add it to RESOURCE_ROUTE_PATHS_NOT_PRERENDERED in\n` +
        `      scripts/build-output.mjs with the reason);\n` +
        `    - react-router build did not run before this step.\n` +
        `  Failing here rather than shrugging: a prune that silently no-ops\n` +
        `  puts the dead payloads back in the image with nothing to say so.`,
    );
  }
}

if (doomed.size === 0) {
  fail(
    `no dead .data payloads were selected for removal out of ${before.length} ` +
      `.data file(s).\n` +
      `  A prune that removes nothing is a prune that has stopped working.`,
  );
}

let bytes = 0;
for (const dataPath of doomed) {
  const full = join(CLIENT_BUILD_DIR, dataPath);
  bytes += (await stat(full)).size;
  await rm(full);
}

// Prove what left, by name, rather than trusting `rm`: every remaining .data
// file belongs to a page route and is what client-side navigation fetches.
const after = await listDataFiles(CLIENT_BUILD_DIR);
const removed = before.filter((path) => !after.includes(path));
const unexpected = removed.filter((path) => !doomed.has(path));
const survived = [...doomed].filter((path) => after.includes(path));

if (unexpected.length > 0 || survived.length > 0) {
  fail(
    `the build output did not lose exactly the ${doomed.size} dead payload(s) ` +
      `this step selected.\n` +
      (unexpected.length
        ? `  Also removed (must not be): ${unexpected.join(', ')}\n`
        : '') +
      (survived.length ? `  Still present: ${survived.join(', ')}\n` : '') +
      `  The surviving .data files are what client-side navigation fetches — ` +
      `nothing else may be deleted here.`,
  );
}

console.log(
  `✓ ${label}: removed ${doomed.size} dead single-fetch payload(s) ` +
    `(${bytes} bytes) from ${resourceRoutes.length} resource route(s), ` +
    `${after.length} live .data files untouched`,
);
