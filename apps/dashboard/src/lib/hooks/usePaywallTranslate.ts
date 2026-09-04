import { useMutation } from "@tanstack/react-query";
import { api } from "../api";

export type TranslateRequest = {
  /** Taken from the caller rather than from the router: the paywall
   *  builder's own view model already holds both ids, and reading them
   *  from `useParams` would make this hook unusable anywhere outside a
   *  mounted route — including in the localization modal's own tests. */
  projectId: string;
  paywallId: string;
  sourceLocale: string;
  targetLocale: string;
  /** Source-locale text, keyed by localization key. */
  entries: Record<string, string>;
};

export type TranslateResponse = {
  /** Translations that preserved every `{{placeholder}}`. */
  entries: Record<string, string>;
  /**
   * Keys the model never returned, or whose output could not preserve the
   * source's placeholders. Surfaced to the author rather than swallowed —
   * a locale that looks complete but is not is worse than a visible gap.
   */
  rejected: string[];
};

/**
 * Auto-translate one locale's strings.
 *
 * The endpoint writes nothing: it takes the CLIENT's current strings and
 * returns translations for the caller to merge through the builder VM's
 * `applyTranslations`. The builder autosaves on its own schedule, so the
 * paywall row the server could read is stale by design — see the route.
 */
export function usePaywallTranslate() {
  return useMutation({
    mutationFn: ({ projectId, paywallId, ...body }: TranslateRequest) =>
      api<TranslateResponse>(
        `/dashboard/projects/${projectId}/paywalls/${paywallId}/translate`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  });
}
