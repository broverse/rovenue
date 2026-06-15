#!/usr/bin/env node
/**
 * check-links.mjs — internal /docs/... link validator for the Rovenue SDK docs.
 *
 * Approach: custom Node script (fumadocs-core 16.10.2 ships no link-validation
 * export, only ./link and ./dynamic-link which are React components).
 *
 * What it does:
 *   1. Globs content/docs/**\/*.mdx and builds the set of valid doc routes from
 *      file paths (e.g. content/docs/guides/configuring.mdx → /docs/guides/configuring,
 *      content/docs/index.mdx → /docs).
 *   2. Scans every .mdx file for:
 *        - Markdown links:  [text](/docs/...)
 *        - JSX href:        href="/docs/..."
 *        - JSX to prop:     to="/docs/..."
 *   3. Reports any /docs/... link whose target route does not exist.
 *   4. Exits 1 if broken links were found, 0 otherwise.
 *
 * Ignored: external (http/https) links, same-page anchors (#...), query strings.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONTENT_DIR = join(__dirname, '..', 'content', 'docs');

// ── helpers ──────────────────────────────────────────────────────────────────

async function walkMdx(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMdx(full)));
    } else if (entry.name.endsWith('.mdx')) {
      files.push(full);
    }
  }
  return files;
}

function fileToRoute(filePath) {
  const rel = relative(CONTENT_DIR, filePath).replace(/\.mdx$/, '');
  if (rel === 'index') return '/docs';
  if (rel.endsWith('/index')) return '/docs/' + rel.slice(0, -6);
  return '/docs/' + rel;
}

// ── main ─────────────────────────────────────────────────────────────────────

const mdxFiles = await walkMdx(CONTENT_DIR);
const validRoutes = new Set(mdxFiles.map(fileToRoute));

const PATTERNS = [
  // Markdown link:  [text](/docs/...)
  /\[[^\]]*\]\((\/docs\/[^)\s#"]+)/g,
  // JSX href prop:  href="/docs/..."  or  href='/docs/...'
  /href=['"](\/docs\/[^'")\s#]+)/g,
  // JSX to prop:    to="/docs/..."    or  to='/docs/...'
  /\bto=['"](\/docs\/[^'")\s#]+)/g,
];

/** @type {{ file: string; target: string }[]} */
const broken = [];

for (const file of mdxFiles) {
  const content = await readFile(file, 'utf8');
  for (const pattern of PATTERNS) {
    let match;
    // reset lastIndex each file — patterns are shared across iterations
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[1];
      // strip trailing slash and ignore anchors / query strings for route check
      const route = raw.split('#')[0].split('?')[0].replace(/\/$/, '') || '/docs';
      if (!validRoutes.has(route)) {
        broken.push({ file: relative(CONTENT_DIR, file), target: raw });
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

if (broken.length === 0) {
  console.log(`✓ check-links: all internal /docs/... links are valid (${mdxFiles.length} files checked)`);
  process.exit(0);
} else {
  console.error(`✗ check-links: ${broken.length} broken internal link(s) found:\n`);
  for (const { file, target } of broken) {
    console.error(`  ${file}  →  ${target}`);
  }
  process.exit(1);
}
