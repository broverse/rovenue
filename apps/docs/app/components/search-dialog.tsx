import { useMemo } from 'react';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
} from 'fumadocs-ui/components/dialog/search';
import type { SearchLink, SharedProps } from 'fumadocs-ui/contexts/search';
import { searchIndexRoute } from '@/lib/shared';

/**
 * Search dialog backed by the prerendered Orama index rather than by a
 * server route.
 *
 * fumadocs-ui's own `DefaultSearchDialog` is hard-wired to `fetchClient`,
 * which POSTs every keystroke to `/api/search`. That route needs a running
 * Node server; the docs image is `caddy:2-alpine` serving static files, so
 * in production it answered nothing and the box silently found zero results.
 * This variant downloads `searchIndexRoute` once and searches it in the
 * browser instead.
 *
 * The download is lazy: `useDocsSearch` short-circuits an empty query, and
 * `oramaStaticClient` only fetches inside `search()`, so opening the dialog
 * costs nothing — the index is fetched on the first typed query and cached
 * (module-level `Map` inside `oramaStaticClient`) for the rest of the visit.
 */
const client = oramaStaticClient({ from: searchIndexRoute });

export default function StaticSearchDialog({
  links = [],
  ...props
}: SharedProps & { links?: SearchLink[] }) {
  const { search, setSearch, query } = useDocsSearch({ client });

  // Shown while the query is empty, matching DefaultSearchDialog.
  const defaultItems = useMemo(() => {
    if (links.length === 0) return null;

    return links.map(([name, link]) => ({
      type: 'page' as const,
      id: name,
      content: name,
      url: link,
    }));
  }, [links]);

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          items={query.data !== 'empty' ? query.data : defaultItems}
        />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
