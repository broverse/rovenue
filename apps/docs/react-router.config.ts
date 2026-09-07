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
