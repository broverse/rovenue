import type { BuilderConfig } from "@rovenue/shared/paywall";

// =============================================================
// Pure helpers behind the start gallery.
//
// The abstract silhouette that used to live here is gone: with eighteen
// templates the cards render the real tree through `PaywallRenderer`
// (`template-preview.tsx`), because four minimal templates produce four
// indistinguishable stacks of bars and a silhouette cannot show copy.
// =============================================================

/** True when there is nothing in the tree yet — the "just created it" moment. */
export function shouldAutoOpenStart(config: BuilderConfig): boolean {
  return config.root.children.length === 0;
}

// =============================================================
// Gallery filtering. Pure, so the modal keeps no search logic of its own.
// =============================================================

/** What a gallery card exposes to the filter — the fields an author reads. */
export interface FilterableTemplate {
  id: string;
  name: string;
  tag: string;
  description: string;
  category: string;
}

/**
 * Templates matching `category` (null = all) AND `query`.
 *
 * The query matches name, tag, description and category together rather
 * than name alone: an author looking for "trial" should find the
 * trial-led templates whether the word sits in the name, the badge or the
 * one-line description, and searching for a word that appears only in a
 * description is the common case with eighteen entries.
 */
export function filterTemplates<T extends FilterableTemplate>(
  templates: readonly T[],
  opts: { category: string | null; query: string },
): T[] {
  const needle = opts.query.trim().toLowerCase();
  return templates.filter((t) => {
    if (opts.category !== null && t.category !== opts.category) return false;
    if (needle.length === 0) return true;
    const haystack = `${t.name} ${t.tag} ${t.description} ${t.category}`.toLowerCase();
    return haystack.includes(needle);
  });
}
