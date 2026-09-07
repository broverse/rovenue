import { index, route, type RouteConfig } from '@react-router/dev/routes';
import { searchIndexFile } from './lib/shared';

export default [
  index('routes/home.tsx'),
  route('docs/*', 'routes/docs.tsx'),
  // Prerendered to build/client/search-index.json — the static image has no
  // Node process, so this is an exported index, not a query API.
  route(searchIndexFile, 'routes/search.ts'),
  route('og/docs/*', 'routes/og.docs.tsx'),

  // LLM integration:
  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/docs/*', 'llms/mdx.ts'),

  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
