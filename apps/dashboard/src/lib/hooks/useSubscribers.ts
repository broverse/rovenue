import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  SubscriberListFilters,
  SubscriberListResponse,
  SubscriberListSortMode,
} from "@rovenue/shared";
// `subscribers` route reads query params with `c.req.query()` rather
// than `zValidator("query", ...)`, so the AppType surface has no
// query-string types to infer. Keep using the path-string `api()`
// shim until the API route adopts the validator — the path itself
// is still type-checked at the project-level rpc entry.
import { api } from "../api";

interface Params extends SubscriberListFilters {
  projectId: string;
  /** Inclusive `lastSeenAt` lower bound as `YYYY-MM-DD` or full ISO. */
  from?: string;
  /** Inclusive `lastSeenAt` upper bound as `YYYY-MM-DD` or full ISO. */
  to?: string;
  /** Defaults to backend default (`last_activity`) when omitted. */
  sort?: SubscriberListSortMode;
  limit?: number;
}

export function useSubscribers({
  projectId,
  q,
  status,
  entitlement,
  platforms,
  country,
  ltvMin,
  from,
  to,
  sort,
  limit = 50,
}: Params) {
  // Normalise platforms so the queryKey + URL stay stable across
  // equivalent inputs (`['ios','android']` vs `['android','ios']`).
  const platformsKey =
    platforms && platforms.length > 0 ? [...platforms].sort() : undefined;

  return useInfiniteQuery<SubscriberListResponse>({
    queryKey: [
      "subscribers",
      projectId,
      {
        q,
        status,
        entitlement,
        platforms: platformsKey,
        country,
        ltvMin,
        from,
        to,
        sort,
        limit,
      },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      if (entitlement) params.set("entitlement", entitlement);
      if (platformsKey) params.set("platform", platformsKey.join(","));
      if (country) params.set("country", country);
      if (typeof ltvMin === "number") params.set("ltvMin", String(ltvMin));
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (sort) params.set("sort", sort);
      params.set("limit", String(limit));
      return api<SubscriberListResponse>(
        `/dashboard/projects/${projectId}/subscribers?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
