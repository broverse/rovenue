import { useQuery } from "@tanstack/react-query";
import type { SubscriberDetail } from "@rovenue/shared";
import { rpc, unwrap } from "../api";

export function useSubscriber(projectId: string, id: string) {
  return useQuery({
    queryKey: ["subscriber", projectId, id],
    enabled: !!id,
    queryFn: () =>
      unwrap<{ subscriber: SubscriberDetail }>(
        rpc.dashboard.projects[":projectId"].subscribers[":id"].$get({
          param: { projectId, id },
        }),
      ),
    select: (res) => res.subscriber,
  });
}
