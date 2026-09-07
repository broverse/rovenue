import type { Route } from './+types/search';
import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

const server = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: 'english',
  // Orama builds a per-property sort index (`sorting` in the export) so that
  // `search({ sortBy })` can order hits by a field. Nothing here ever sorts:
  // `searchAdvanced()` — the only query path `oramaStaticClient` uses — passes
  // `groupBy`, never `sortBy`, and the client only ever `load()`s and queries
  // this index, never inserts into it (Orama touches the sorter on insert,
  // remove and sortBy alone). The sort index is therefore pure payload, and
  // readers download it on their first query. Measured on this content:
  // 5,911,638 → 4,754,867 bytes raw (-19.6%), 783,534 B gzipped where it was
  // ~1.02 MiB before (-27%).
  //
  // Round-tripping is a supported path, not a trick: `save()` writes
  // `sorting: { enabled: false }` for a disabled sorter and the client's
  // `load()` reads that shape back explicitly, so a sort-disabled export
  // loads into the default `initOrama` database unchanged.
  sort: { enabled: false },
});

/**
 * Exports the whole Orama index as one JSON document, instead of answering
 * individual queries with `server.GET(request)`.
 *
 * This route is *prerendered* (see `react-router.config.ts`), so
 * `react-router build` calls this loader once at build time and writes the
 * body to `build/client/search-index.json` — the only directory the
 * production image ships (`apps/docs/Dockerfile` copies it into a
 * `caddy:2-alpine` stage). There is no Node process in that image, so a
 * query-per-request search API would 404 for every reader; the client
 * (`app/components/search-dialog.tsx`) downloads this file once, on the
 * first non-empty query, and searches it in the browser.
 *
 * Keeping it as a route rather than a standalone `scripts/generate-*.mjs`
 * is deliberate: the index is derived from `@/lib/source`, whose backing
 * module (`.source/server.ts`) is built out of `import.meta.glob` and only
 * resolves inside Vite. Prerendering runs it in the real build, so the
 * index cannot go stale and `pnpm dev` serves the identical bytes at the
 * identical URL.
 */
export async function loader(_args: Route.LoaderArgs) {
  return server.staticGET();
}
