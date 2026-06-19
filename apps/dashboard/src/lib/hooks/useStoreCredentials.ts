import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CredentialStore,
  UpdateAppleCredentialsRequest,
  UpdateGoogleCredentialsRequest,
  UpdateStripeCredentialsRequest,
} from "@rovenue/shared";
import { api } from "../api";

export type StoreCredentialBody =
  | UpdateAppleCredentialsRequest
  | UpdateGoogleCredentialsRequest
  | UpdateStripeCredentialsRequest;

type CredentialMutationResult = {
  credential: { store: CredentialStore; configured: boolean };
};

/**
 * Upsert a store's credentials (PUT replaces the whole encrypted blob —
 * it does not merge, so callers must submit every field they want kept,
 * including secrets). OWNER-only on the server; non-owners get a 403.
 * Invalidates the credentials query so the page reflects the new status.
 */
export function useUpdateStoreCredentials(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      store,
      body,
    }: {
      store: CredentialStore;
      body: StoreCredentialBody;
    }) =>
      api<CredentialMutationResult>(
        `/dashboard/projects/${projectId}/credentials/${store}`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["credentials", projectId] }),
  });
}

/** Clear a store's credentials (soft-delete; OWNER-only). */
export function useDisconnectStore(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (store: CredentialStore) =>
      api<CredentialMutationResult>(
        `/dashboard/projects/${projectId}/credentials/${store}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["credentials", projectId] }),
  });
}
