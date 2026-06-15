import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkInstall } from 'fumadocs-docgen';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    // `package-install` code blocks expand to npm/yarn/pnpm/bun tabs;
    // `persist` syncs the chosen manager across the whole site.
    remarkPlugins: [[remarkInstall, { persist: { id: 'package-manager' } }]],
  },
});
