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
 * Where Vite writes the hashed client bundle, including the React Router
 * client manifest that `scripts/prune-resource-route-data.mjs` classifies
 * routes from.
 */
export const CLIENT_ASSETS_DIR = join(CLIENT_BUILD_DIR, 'assets');

/**
 * The client manifest is emitted as `assets/manifest-<version>.js`, a single
 * statement assigning one JSON object literal:
 *
 *   window.__reactRouterManifest={"entry":{…},"routes":{…},"version":"…"};
 *
 * Its `routes` table carries `hasDefaultExport` per route, which is the
 * build's own record of which routes can render on the client — see
 * `scripts/prune-resource-route-data.mjs`.
 */
export const CLIENT_MANIFEST_PREFIX = 'manifest-';
export const CLIENT_MANIFEST_SUFFIX = '.js';
export const CLIENT_MANIFEST_ASSIGNMENT = 'window.__reactRouterManifest=';

/** How `app/routes.ts` spells a splat segment (`docs/*`, `og/docs/*`). */
export const SPLAT_SEGMENT = '*';
export const SPLAT_PATH_SUFFIX = `/${SPLAT_SEGMENT}`;

/**
 * Resource routes that are deliberately NOT prerendered, by route path.
 *
 * Every other resource route must contribute at least one `<route>.data` for
 * `scripts/prune-resource-route-data.mjs` to remove — otherwise the prune has
 * silently stopped covering it and the payloads are back in the image. This
 * list is the one honest exception, and it is short on purpose.
 *
 * `llms.mdx/docs/*` serves per-page MDX source on demand. `react-router.config.ts`'s
 * prerender list adds `/docs/<slug>` and `/og/docs/<slug>/image.webp` for each
 * page and never `/llms.mdx/docs/<slug>`, so the route emits nothing at build
 * time — no document, no payload, nothing to prune.
 */
export const RESOURCE_ROUTE_PATHS_NOT_PRERENDERED = ['llms.mdx/docs/*'];

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
