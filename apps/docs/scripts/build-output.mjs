/**
 * build-output.mjs — the one place that names the docs build's output paths.
 *
 * `react-router build` writes the browser bundle to `build/client`, and that
 * directory (nothing else) is what `apps/docs/Dockerfile` copies into the
 * `caddy:2-alpine` runtime stage. Several build-time guards and prune steps
 * poke at it; they all import their paths from here so a rename cannot leave
 * one of them silently pointed at a path that no longer exists — the failure
 * mode that lets a "green" check protect nothing.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported (via tsx) rather than re-typed: the same constant `routes.ts`
// registers the search route under and the browser fetches.
import { searchIndexFile } from '../app/lib/shared.ts';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

export const BUILD_DIR = join(scriptsDir, '..', 'build');
export const CLIENT_BUILD_DIR = join(BUILD_DIR, 'client');

/** The prerendered Orama index the browser downloads on the first query. */
export const SEARCH_INDEX_PATH = join(CLIENT_BUILD_DIR, searchIndexFile);

/**
 * React Router's single-fetch payload extension. A `<route>.data` file is what
 * the client fetches when it navigates to `<route>` without a document load.
 */
export const SINGLE_FETCH_DATA_SUFFIX = '.data';

/**
 * `search-index.json.data` — the single-fetch payload for the *resource* route
 * that exports the index. Nothing ever navigates to it (a resource route
 * returns raw JSON, not a page), so it is dead weight in the image; see
 * `scripts/prune-search-index-data.mjs`.
 */
export const SEARCH_INDEX_DATA_PATH = `${SEARCH_INDEX_PATH}${SINGLE_FETCH_DATA_SUFFIX}`;

/** Prerendered documents are emitted as `<route>/index.html`. */
export const PRERENDERED_DOCUMENT_GLOB = '**/index.html';

/**
 * The serialized `routeDiscovery` config React Router embeds in every
 * prerendered document, with the setting `react-router.config.ts` must keep.
 * See `scripts/verify-route-discovery.mjs` for why it is load-bearing.
 */
export const ROUTE_DISCOVERY_INITIAL_MARKER =
  '"routeDiscovery":{"mode":"initial"}';
export const ROUTE_DISCOVERY_LAZY_MARKER = '"routeDiscovery":{"mode":"lazy"';
