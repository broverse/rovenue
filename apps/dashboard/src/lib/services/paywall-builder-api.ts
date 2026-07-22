import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { BuilderConfig } from "@rovenue/shared/paywall";
import type { DashboardOfferingRow, DashboardPaywallRow } from "@rovenue/shared";

// =============================================================
// Thin RPC wrapper the paywall builder VM depends on. Mirrors
// FunnelApi's shape (typed Hono RPC client via rpc/unwrap).
//
// The dashboard paywall detail endpoint (GET /paywalls/:id) returns
// a `DashboardPaywallRow` — it does NOT carry the offering's package
// identifiers, only `offeringId`. The builder VM needs those ids to
// run `validateBuilderConfig` (FOREIGN_PACKAGE_ID checks). Rather
// than adding a new API endpoint or bloating the paywall row, the
// cheapest correct fix is composing it here: `get()` follows up with
// a GET on the offering and folds `packages[].identifier` into the
// DTO. `patchBuilderConfig()` reuses the caller's already-known
// offering package ids when the PATCH response's `offeringId` is
// unchanged (the common autosave case), and only re-fetches the
// offering when it actually changed.
// =============================================================

export interface PaywallBuilderDetailDto {
  id: string;
  projectId: string;
  identifier: string;
  name: string;
  offeringId: string;
  isActive: boolean;
  configFormatVersion: number;
  builderConfig: BuilderConfig | null;
  /** Fallback default locale to seed an empty BuilderConfig with, taken from `remoteConfig.defaultLocale`. */
  defaultLocale: string;
  offeringPackageIds: string[];
  updatedAt: string;
  createdAt: string;
}

function toDetailDto(
  row: DashboardPaywallRow,
  offeringPackageIds: string[],
): PaywallBuilderDetailDto {
  return {
    id: row.id,
    projectId: row.projectId,
    identifier: row.identifier,
    name: row.name,
    offeringId: row.offeringId,
    isActive: row.isActive,
    configFormatVersion: row.configFormatVersion,
    builderConfig: (row.builderConfig as BuilderConfig | null) ?? null,
    defaultLocale: row.remoteConfig?.defaultLocale ?? "en",
    offeringPackageIds,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

@injectable()
export class PaywallBuilderApi {
  private async fetchOfferingPackageIds(
    projectId: string,
    offeringId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const { offering } = await unwrap<{ offering: DashboardOfferingRow }>(
      rpc.dashboard.projects[":projectId"].offerings[":id"].$get(
        { param: { projectId, id: offeringId } },
        { init: { signal } },
      ),
    );
    return offering.packages.map((p) => p.identifier);
  }

  async get(
    projectId: string,
    paywallId: string,
    signal?: AbortSignal,
  ): Promise<PaywallBuilderDetailDto> {
    const { paywall } = await unwrap<{ paywall: DashboardPaywallRow }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].$get(
        { param: { projectId, id: paywallId } },
        { init: { signal } },
      ),
    );
    const offeringPackageIds = await this.fetchOfferingPackageIds(
      projectId,
      paywall.offeringId,
      signal,
    );
    return toDetailDto(paywall, offeringPackageIds);
  }

  async patchBuilderConfig(
    projectId: string,
    paywallId: string,
    builderConfig: BuilderConfig,
    previousOfferingId: string,
    previousOfferingPackageIds: string[],
    signal?: AbortSignal,
  ): Promise<PaywallBuilderDetailDto> {
    const { paywall } = await unwrap<{ paywall: DashboardPaywallRow }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].$patch(
        {
          param: { projectId, id: paywallId },
          json: { builderConfig } as never,
        },
        { init: { signal } },
      ),
    );
    const offeringPackageIds =
      paywall.offeringId === previousOfferingId
        ? previousOfferingPackageIds
        : await this.fetchOfferingPackageIds(projectId, paywall.offeringId, signal);
    return toDetailDto(paywall, offeringPackageIds);
  }
}
