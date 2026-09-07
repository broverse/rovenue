export const appName = 'Rovenue SDK';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'rovenue',
  repo: 'rovenue',
  branch: 'main',
};

/**
 * The Orama search index, exported at build time by `routes/search.ts`'s
 * `staticGET()` and prerendered to `build/client/search-index.json` (see
 * `react-router.config.ts`). The production image is `caddy:2-alpine`
 * serving `build/client` — there is no Node process — so search has to read
 * a plain static file, not a server route.
 *
 * `searchIndexFile` is the react-router route path (no leading slash, as
 * `routes.ts` requires); `searchIndexRoute` is the URL the browser fetches
 * (`oramaStaticClient({ from })` in `components/search-dialog.tsx`).
 */
export const searchIndexFile = 'search-index.json';
export const searchIndexRoute = `/${searchIndexFile}`;
