import { useInfiniteQuery } from "@tanstack/react-query";
import type { SubscriberListResponse } from "@rovenue/shared";
// `subscribers` route reads query params with `c.req.query()` rather
// than `zValidator("query", ...)`, so the AppType surface has no
// query-string types to infer. Keep using the path-string `api()`
// shim until the API route adopts the validator — the path itself
// is still type-checked at the project-level rpc entry.
import { api } from "../api";

interface Params {
  projectId: string;
  q?: string;
  limit?: number;
}

export function useSubscribers({ projectId, q, limit = 50 }: Params) {
  return useInfiniteQuery<SubscriberListResponse>({
    queryKey: ["subscribers", projectId, { q, limit }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      if (q) params.set("q", q);
      params.set("limit", String(limit));
      return api<SubscriberListResponse>(
        `/dashboard/projects/${projectId}/subscribers?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
