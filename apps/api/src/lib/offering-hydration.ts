import { z } from "zod";
import { drizzle } from "@rovenue/db";

// Shape of each item in Offering.packages JSON array
export const packageSchema = z.object({
  identifier: z.string(),
  productId: z.string(),
  order: z.number().int().nonnegative().default(0),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
export const packagesSchema = z.array(packageSchema);

const storeIdsSchema = z.object({
  apple: z.string().optional(),
  google: z.string().optional(),
  stripe: z.string().optional(),
}).passthrough();

export function parseStoreIds(raw: unknown): Record<string, string> {
  const parsed = storeIdsSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Record<string, string>) : {};
}

export interface OfferingProductEntry {
  packageIdentifier: string; // the package slot id ($rov_monthly…) from the offering
  identifier: string;        // the product's own identifier (unchanged, additive)
  type: string;
  displayName: string;
  order: number;
  isPromoted: boolean;
  accessIds: string[];
  storeIds: Record<string, string>;
  androidBasePlanId: string | null;
  androidOfferId: string | null;
  metadata: unknown;
}

export type PackageSlot = z.infer<typeof packageSchema>;

export function hydrateProducts(
  memberships: PackageSlot[],
  productById: Map<string, {
    identifier: string;
    type: string;
    displayName: string;
    accessIds: string[];
    isActive: boolean;
    storeIds: unknown;
    androidBasePlanId: string | null;
    androidOfferId: string | null;
  }>,
): OfferingProductEntry[] {
  return [...memberships]
    .sort((a, b) => a.order - b.order)
    .map((entry): OfferingProductEntry | null => {
      const product = productById.get(entry.productId);
      if (!product || !product.isActive) return null;
      return {
        packageIdentifier: entry.identifier,
        identifier: product.identifier,
        type: product.type,
        displayName: product.displayName,
        order: entry.order,
        isPromoted: entry.isPromoted,
        accessIds: product.accessIds,
        storeIds: parseStoreIds(product.storeIds),
        androidBasePlanId: product.androidBasePlanId ?? null,
        androidOfferId: product.androidOfferId ?? null,
        metadata: entry.metadata ?? {},
      };
    })
    .filter((p): p is OfferingProductEntry => p !== null);
}

/**
 * Convenience wrapper: parse packages → findProductsByIds → hydrateProducts
 * Returns offering with hydrated packages, or empty packages array on parse failure
 */
export async function hydrateOffering(
  projectId: string,
  offering: {
    identifier: string;
    isDefault: boolean;
    packages: unknown;
    metadata: unknown;
  },
): Promise<{
  identifier: string;
  isDefault: boolean;
  packages: OfferingProductEntry[];
  metadata: unknown;
}> {
  const packageSlots = packagesSchema.safeParse(offering.packages);

  if (!packageSlots.success) {
    return {
      identifier: offering.identifier,
      isDefault: offering.isDefault,
      packages: [],
      metadata: offering.metadata,
    };
  }

  const productIds = packageSlots.data.map((m) => m.productId);
  const products = await drizzle.offeringRepo.findProductsByIds(
    drizzle.db,
    projectId,
    productIds,
  );
  const productById = new Map(products.map((p) => [p.id, p] as const));

  return {
    identifier: offering.identifier,
    isDefault: offering.isDefault,
    packages: hydrateProducts(packageSlots.data, productById as any),
    metadata: offering.metadata,
  };
}
