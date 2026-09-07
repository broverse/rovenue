import type { Config } from '@react-router/dev/config';
import { glob } from 'node:fs/promises';
import { createGetUrl, getSlugs } from 'fumadocs-core/source';
import { getPageImagePath } from './app/lib/og';

const getUrl = createGetUrl('/docs');

export default {
  ssr: true,
  future: {
    v8_middleware: true,
  },
  // React Router's route discovery defaults to `mode: 'lazy'`, which fetches
  // `/__manifest?p=...` on every client-side navigation. There is no server to
  // answer that: the production image is `caddy:2-alpine` serving
  // `build/client` with `try_files {path} {path}/index.html /index.html`
  // (deploy/caddy/Caddyfile.docs), so `/__manifest` is not a file on disk and
  // Caddy replies **200 with the SPA shell**. The client parses that HTML as
  // JSON, throws, and the root ErrorBoundary renders "Oops!" — every sidebar
  // link and every search result landed there.
  //
  // `mode: 'initial'` inlines the whole route manifest into the initial
  // document and stops the `/__manifest` fetch entirely. It costs nothing
  // here: `app/routes.ts` declares eight routes.
  routeDiscovery: { mode: 'initial' },
  async prerender({ getStaticPaths }) {
    // Every static path is prerendered, `/search-index.json` included: the
    // production image is Caddy serving `build/client` with no Node process,
    // so anything not written to disk here is a 404 for readers. (This list
    // used to exclude the old `/api/search` query API, which is exactly why
    // the search box opened and found nothing — see app/routes/search.ts.)
    const paths: string[] = [...getStaticPaths()];

    for await (const entry of glob('**/*.mdx', { cwd: 'content/docs' })) {
      const slugs = getSlugs(entry);

      paths.push(getUrl(slugs));
      paths.push(getPageImagePath(slugs));
    }

    return paths;
  },
} satisfies Config;
