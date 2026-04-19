import { useQuery } from "@tanstack/react-query";
import type { SubscriberDetail } from "@rovenue/shared";
import { api } from "../api";

export function useSubscriber(projectId: string, id: string) {
  return useQuery({
    queryKey: ["subscriber", projectId, id],
    queryFn: () =>
      api<{ subscriber: SubscriberDetail }>(
        `/dashboard/projects/${projectId}/subscribers/${id}`,
      ),
    select: (res) => res.subscriber,
  });
}
