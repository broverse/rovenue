#!/usr/bin/env node
/**
 * check-links.mjs — internal /docs/... link + #fragment validator for the
 * Rovenue SDK docs.
 *
 * Approach: custom Node/tsx script (fumadocs-core 16.10.2 ships no
 * link-validation export, only ./link and ./dynamic-link which are React
 * components).
 *
 * What it does:
 *   1. Globs content/docs/**\/*.mdx and builds the set of valid doc routes
 *      from file paths (e.g. content/docs/guides/configuring.mdx ->
 *      /docs/guides/configuring, content/docs/index.mdx -> /docs).
 *   2. For every route, computes the set of heading anchors that route's
 *      page actually produces — same algorithm fumadocs' own
 *      `remarkHeading` plugin uses (github-slugger over the flattened
 *      heading text; a trailing `[#custom-id]` overrides the auto-slug),
 *      so this stays correct without needing a real build.
 *   3. Scans every .mdx file for:
 *        - Markdown links:  [text](/docs/...) or [text](#...)
 *        - JSX href:        href="/docs/..." or href="#..."
 *        - JSX to prop:     to="/docs/..."
 *      and validates: (a) the target route exists, and (b) if the link
 *      carries a `#fragment`, that fragment is a real anchor on the target
 *      page (same-page `#frag` links resolve against the file's own route).
 *   4. Separately validates the one significant DYNAMIC internal-link
 *      source that (2)+(3) can't see because the fragment is computed at
 *      runtime, not written as a literal string in an .mdx file: the API
 *      explorer (apps/docs/app/components/api-explorer.tsx) links every
 *      `ERROR_CATALOG` entry to `/docs/reference/api-errors#<wire-value
 *      lowercased>`. Five wire values differ from their `ERROR_CODE` key
 *      (asset_in_use, asset_missing, purchase_not_paid,
 *      apple_offer_signing_unavailable, apple_offer_signing_failed), so this
 *      check imports the real catalog and the real generated page's anchors
 *      and cross-checks them — instead of trusting the two independently
 *      hand-maintained "this is how the anchor is computed" comments (in the
 *      explorer component and in generate-error-catalog.mjs) to agree
 *      forever.
 *   5. Exits 1 if anything broken was found, 0 otherwise.
 *
 * Ignored: external (http/https) links, query strings, and any link whose
 * fragment is produced by an expression this script has no special case
 * for (e.g. a future `${...}`-interpolated href elsewhere) — those aren't
 * silently "validated true", they're just not matched by the static
 * patterns at all, same as today.
 *
 * Run via `tsx` (not plain `node`): the ERROR_CATALOG cross-check in step 4
 * imports `@rovenue/shared/error-catalog`, a raw .ts module (see
 * packages/shared/package.json's `exports`), same as
 * generate-error-catalog.mjs already does.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CONTENT_DIR = join(__dirname, '..', 'content', 'docs');

// ── route + anchor computation ──────────────────────────────────────────────

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

// Mirrors fumadocs-core's `remarkHeading` custom-id syntax: a heading whose
// text ends in `[#some-id]` gets that literal id instead of an auto-slug.
const CUSTOM_ID_RE = /\s*\[#([^\]]+?)\]\s*$/;

/**
 * Reduce a raw markdown heading line's text to plain prose, the same shape
 * `flattenNode` produces from the mdast tree: strip link syntax down to its
 * label, strip inline-code backticks, strip bold/italic markers, strip any
 * inline HTML/JSX tags.
 */
function flattenHeadingText(raw) {
  let text = raw;
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [label](url) -> label
  text = text.replace(/`([^`]*)`/g, '$1'); // `code` -> code
  text = text.replace(/\*\*([^*]*)\*\*/g, '$1'); // **bold** -> bold
  text = text.replace(/\*([^*]*)\*/g, '$1'); // *italic* -> italic
  text = text.replace(/<[^>]+>/g, ''); // strip inline tags
  return text.trim();
}

/**
 * Compute the set of heading anchors a single .mdx file's page renders,
 * using github-slugger the same way fumadocs-core's remarkHeading does
 * (one Slugger instance per file, reset — i.e. fresh — for each page, so
 * repeated headings within a page get the same `-1`/`-2` suffixing a real
 * build would give them).
 */
function anchorsForContent(content) {
  const slugger = new GithubSlugger();
  const anchors = new Set();
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (!match) continue;
    const rawText = match[1].trim();
    const customIdMatch = CUSTOM_ID_RE.exec(rawText);
    if (customIdMatch) {
      anchors.add(customIdMatch[1]);
      continue;
    }
    const flattened = flattenHeadingText(rawText);
    if (flattened) anchors.add(slugger.slug(flattened));
  }
  return anchors;
}

// ── main ─────────────────────────────────────────────────────────────────────

const mdxFiles = await walkMdx(CONTENT_DIR);
const validRoutes = new Set(mdxFiles.map(fileToRoute));

/** @type {Map<string, Set<string>>} route -> anchors that route's page renders */
const anchorsByRoute = new Map();
/** @type {Map<string, string>} route -> raw file content, for same-page (#frag) links */
const contentByRoute = new Map();

for (const file of mdxFiles) {
  const content = await readFile(file, 'utf8');
  const route = fileToRoute(file);
  anchorsByRoute.set(route, anchorsForContent(content));
  contentByRoute.set(route, content);
}

const PATTERNS = [
  // Markdown link:  [text](/docs/...)  or  [text](#...)
  /\[[^\]]*\]\((\/docs\/[^)\s"]+|#[^)\s"]+)\)/g,
  // JSX href prop:  href="/docs/..."  or  href="#..."
  /href=['"](\/docs\/[^'"\s]+|#[^'"\s]+)['"]/g,
  // JSX to prop:    to="/docs/..."
  /\bto=['"](\/docs\/[^'"\s]+)['"]/g,
];

/** @type {{ file: string; target: string; reason: string }[]} */
const broken = [];

for (const file of mdxFiles) {
  const content = contentByRoute.get(fileToRoute(file));
  const ownRoute = fileToRoute(file);
  for (const pattern of PATTERNS) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[1];
      const isSamePage = raw.startsWith('#');
      const withoutFragment = raw.split('#')[0].split('?')[0];
      const route = isSamePage ? ownRoute : (withoutFragment.replace(/\/$/, '') || '/docs');
      const fragment = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : null;

      if (!isSamePage && !validRoutes.has(route)) {
        broken.push({ file: relative(CONTENT_DIR, file), target: raw, reason: `no such page (${route})` });
        continue;
      }
      if (fragment) {
        const anchors = anchorsByRoute.get(route);
        if (!anchors || !anchors.has(fragment)) {
          broken.push({
            file: relative(CONTENT_DIR, file),
            target: raw,
            reason: `no such anchor "#${fragment}" on ${route}`,
          });
        }
      }
    }
  }
}

// ── dynamic case: the API explorer's ERROR_CATALOG-driven links ────────────
// apps/docs/app/components/api-explorer.tsx builds
// `/docs/reference/api-errors#${entry.code.toLowerCase()}` at runtime for
// every ERROR_CATALOG entry — never as a literal string the patterns above
// could see. Import the real catalog and cross-check against the real
// anchors computed for api-errors.mdx above.
{
  const { ERROR_CATALOG } = await import('@rovenue/shared/error-catalog');
  const route = '/docs/reference/api-errors';
  const anchors = anchorsByRoute.get(route);
  for (const entry of Object.values(ERROR_CATALOG)) {
    const anchor = entry.code.toLowerCase();
    if (!anchors || !anchors.has(anchor)) {
      broken.push({
        file: 'app/components/api-explorer.tsx (ERROR_CATALOG entry, computed at runtime)',
        target: `${route}#${anchor}`,
        reason: `no such anchor "#${anchor}" on ${route} — wire value "${entry.code}" no longer matches a heading there`,
      });
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

if (broken.length === 0) {
  console.log(
    `✓ check-links: all internal /docs/... links and #fragment anchors are valid (${mdxFiles.length} files checked)`,
  );
  process.exit(0);
} else {
  console.error(`✗ check-links: ${broken.length} broken internal link(s) found:\n`);
  for (const { file, target, reason } of broken) {
    console.error(`  ${file}  →  ${target}  (${reason})`);
  }
  process.exit(1);
}
