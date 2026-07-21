import { useQuery } from "@tanstack/react-query";
import type { CredentialsListResponse } from "@rovenue/shared";
import { api } from "../api";

/**
 * Per-store credential status (apple / google) for a project.
 * `credentials.<store>.configured` is the authoritative "store connected"
 * signal — the store-catalog fetch and the iOS/Android product store-id
 * pickers gate on it. Stripe's connection status lives separately, see
 * `useStripeConnection`.
 */
export function useProjectCredentials(projectId: string) {
  return useQuery({
    queryKey: ["credentials", projectId],
    enabled: Boolean(projectId),
    staleTime: 60_000,
    queryFn: () =>
      api<CredentialsListResponse>(
        `/dashboard/projects/${projectId}/credentials`,
      ),
  });
}
