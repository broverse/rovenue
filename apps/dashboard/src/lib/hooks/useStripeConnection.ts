import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc, unwrap } from "../api";

export interface StripeConnectionSummary {
  accountId: string;
  livemode: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  country: string;
  defaultCurrency: string;
  connectedAt: string;
}

export interface StripeConnectionStatus {
  /** Whether this *deployment* has Stripe Connect platform credentials
   * configured — an operator concern, not something a project owner can
   * fix from the dashboard. */
  platformConfigured: boolean;
  /** Whether the deployment also has a test-mode Connect client id, so the
   * connect flow can offer a test-mode option. */
  testModeAvailable: boolean;
  connection: StripeConnectionSummary | null;
}

/**
 * Stripe Connect status for a project (platform config + linked account, if
 * any). Mirrors `useProjectCredentials`'s shape/query-key style.
 */
export function useStripeConnection(projectId: string) {
  return useQuery({
    queryKey: ["stripe-connection", projectId],
    enabled: Boolean(projectId),
    staleTime: 30_000,
    queryFn: () =>
      unwrap<StripeConnectionStatus>(
        rpc.dashboard.projects[":projectId"].stripe.connection.$get({
          param: { projectId },
        }),
      ),
  });
}

/**
 * Disconnect the project's linked Stripe account (OWNER-only on the
 * server). This only revokes Rovenue's access — it does not touch
 * subscriptions already running on the customer's Stripe account.
 */
export function useDisconnectStripe(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap<{ disconnected: boolean }>(
        rpc.dashboard.projects[":projectId"].stripe.connect.$delete({
          param: { projectId },
        }),
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["stripe-connection", projectId] }),
  });
}
