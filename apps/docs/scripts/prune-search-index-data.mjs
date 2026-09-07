#!/usr/bin/env node
/**
 * prune-search-index-data.mjs — deletes `build/client/search-index.json.data`
 * from the docs build output.
 *
 * `app/routes/search.ts` is a *resource* route: it returns the exported Orama
 * index as raw JSON, not a page. React Router still emits a single-fetch
 * sibling for it (`<route>.data`), the payload a client-side navigation to
 * that route would download. Nothing ever navigates to a resource route that
 * returns raw JSON — the browser fetches `/search-index.json` directly
 * (`app/components/search-dialog.tsx` → `oramaStaticClient({ from })`) — so
 * the sibling is never requested. It is ~4.9 MB, larger than the index it
 * shadows, and every byte of it ships in the image layer.
 *
 * Only this one file is removed. The other `.data` files are load-bearing:
 * they are what client-side navigation between docs pages fetches, and
 * deleting one of those breaks navigation to that page.
 *
 * ## Why this fails loudly when the file is absent
 *
 * A prune step that shrugs at a missing file is a step that can silently stop
 * doing anything — the build output would quietly regain 4.9 MB and nothing
 * would say so. So absence is an error: either React Router stopped emitting
 * the sibling (good news, delete this step and the `prune:` script entry) or
 * the path this script targets has drifted (bad news, fix it). Both need a
 * human, and both show up as a failed build rather than a fatter image.
 *
 * Run: `pnpm --filter @rovenue/docs prune:search-index-data` (part of `build`,
 * immediately after `react-router build`).
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  CLIENT_BUILD_DIR,
  SEARCH_INDEX_DATA_PATH,
  SINGLE_FETCH_DATA_SUFFIX,
} from './build-output.mjs';

const label = 'prune-search-index-data';
const target = relative(CLIENT_BUILD_DIR, SEARCH_INDEX_DATA_PATH);

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

let bytes;
try {
  bytes = (await stat(SEARCH_INDEX_DATA_PATH)).size;
} catch {
  fail(
    `build/client/${target} is not there to remove.\n` +
      `  This step exists to delete it, so its absence means one of:\n` +
      `    - React Router no longer emits a single-fetch sibling for resource\n` +
      `      routes — drop this script and its "prune:" entry in package.json;\n` +
      `    - the search index route or its filename moved — update\n` +
      `      scripts/build-output.mjs so this points at the new sibling;\n` +
      `    - react-router build did not run before this step.\n` +
      `  Failing here rather than shrugging: a prune that silently no-ops puts\n` +
      `  the dead payload back in the image with nothing to say so.`,
  );
}

const before = await listDataFiles(CLIENT_BUILD_DIR);
await rm(SEARCH_INDEX_DATA_PATH);
const after = await listDataFiles(CLIENT_BUILD_DIR);

// The other `.data` files serve real client-side navigation. Prove this step
// took exactly one file with it, by name, rather than trusting `rm`.
const removed = before.filter((path) => !after.includes(path));
if (removed.length !== 1 || removed[0] !== target) {
  fail(
    `expected to remove exactly build/client/${target}, but the build output ` +
      `lost ${removed.length} .data file(s): ${removed.join(', ')}. The other ` +
      `.data files are what client-side navigation fetches — nothing else may ` +
      `be deleted here.`,
  );
}

console.log(
  `✓ ${label}: removed build/client/${target} (${bytes} bytes), ` +
    `${after.length} live .data files untouched`,
);
