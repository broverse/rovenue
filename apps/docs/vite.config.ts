import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import mdx from 'fumadocs-mdx/vite';

// Slugs match apps/docs/public/api/<sdk>/ (see .github/workflows/
// sdk-docs.yml and apps/docs/Dockerfile) and the cards rendered by
// app/components/sdk-reference-cards.tsx.
const SDK_DOC_SLUGS = ['core-rs', 'sdk-swift', 'sdk-kotlin', 'sdk-rn', 'sdk-web', 'sdk-flutter'] as const;

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

// Read once, at config-eval time (Node, on the machine running `react-router
// build`/`dev`), whether each SDK's generated reference is present in this
// build's context. Baked into both the client and server bundles as a
// literal object via `define` below — a plain string substitution, not a
// runtime `node:fs` call — so the hub page can render "generated" vs "not
// generated in this build" per SDK without shipping `node:fs` to the browser.
const sdkDocsPresent: Record<string, boolean> = Object.fromEntries(
  SDK_DOC_SLUGS.map((slug) => [slug, existsSync(`${publicDir}/api/${slug}/index.html`)]),
);

export default defineConfig({
  plugins: [mdx(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: ['@takumi-rs/image-response'],
  },
  define: {
    __SDK_DOCS_PRESENT__: JSON.stringify(sdkDocsPresent),
  },
});
