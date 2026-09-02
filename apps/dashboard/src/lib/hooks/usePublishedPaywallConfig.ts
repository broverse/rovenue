import { useQuery } from "@tanstack/react-query";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import { rpc, unwrap } from "../api";

/**
 * The paywall's PUBLISHED builder tree — the one `/v1/placements` actually
 * serves to devices.
 *
 * The builder canvas edits the DRAFT (`paywalls.builderConfig`), but an
 * element experiment is validated server-side against the published version
 * (`apps/api/src/services/experiment-create.ts`), because a patch can only
 * apply to what ships. A node picker built from the draft would therefore
 * offer nodes the API rejects at submit, which is the one outcome the
 * element flow must not have.
 *
 * Two round-trips: the versions list is what names the live version
 * (`isLive`), and only the per-version endpoint carries `builderConfig`.
 * Both are disabled until the caller actually needs them.
 */

interface VersionRow {
  versionNo: number;
  isLive: boolean;
}

export interface PublishedPaywallConfig {
  /** The published tree, or null while loading / when nothing is published. */
  config: BuilderConfig | null;
  /** False when the paywall has never been published at all. Only meaningful
   *  when `isError` is false — a failed lookup knows nothing either way. */
  hasPublishedVersion: boolean;
  isLoading: boolean;
  /** True when the lookup itself failed. Distinct from
   *  `hasPublishedVersion: false`: "we could not check" and "there is no
   *  published version" are different claims, and telling an operator to
   *  publish a paywall that is already published would be a confident lie
   *  about the one thing this hook exists to establish. */
  isError: boolean;
}

export function usePublishedPaywallConfig(
  projectId: string,
  paywallId: string | undefined,
  enabled: boolean,
): PublishedPaywallConfig {
  const ready = enabled && Boolean(projectId) && Boolean(paywallId);

  const versionsQuery = useQuery({
    queryKey: ["paywalls", "versions", projectId, paywallId],
    enabled: ready,
    queryFn: () =>
      unwrap<{ versions: VersionRow[] }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].versions.$get({
          param: { projectId, id: paywallId! },
        }),
      ),
  });

  const liveVersionNo =
    versionsQuery.data?.versions.find((v) => v.isLive)?.versionNo ?? null;

  const configQuery = useQuery({
    queryKey: ["paywalls", "versions", projectId, paywallId, liveVersionNo],
    enabled: ready && liveVersionNo !== null,
    queryFn: () =>
      unwrap<{ version: { builderConfig: BuilderConfig | null } }>(
        rpc.dashboard.projects[":projectId"].paywalls[":id"].versions[
          ":versionNo"
        ].$get({
          param: {
            projectId,
            id: paywallId!,
            versionNo: String(liveVersionNo),
          },
        }),
      ),
  });

  return {
    config: configQuery.data?.version.builderConfig ?? null,
    isError: versionsQuery.isError || configQuery.isError,
    // Only meaningful once the versions list has resolved; until then the
    // caller sees `isLoading` and must not conclude "never published".
    hasPublishedVersion: versionsQuery.isSuccess && liveVersionNo !== null,
    isLoading:
      ready &&
      (versionsQuery.isLoading ||
        (liveVersionNo !== null && configQuery.isLoading)),
  };
}
