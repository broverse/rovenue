import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  billingPaymentMethods,
  type BillingPaymentMethod,
  type NewBillingPaymentMethod,
} from "../schema";

export async function insertPaymentMethod(
  db: Db,
  row: Omit<NewBillingPaymentMethod, "id" | "createdAt">,
): Promise<BillingPaymentMethod> {
  const rows = await db
    .insert(billingPaymentMethods)
    .values(row)
    .returning();
  return rows[0]!;
}

export async function listPaymentMethodsForProject(
  db: Db,
  projectId: string,
): Promise<BillingPaymentMethod[]> {
  return db
    .select()
    .from(billingPaymentMethods)
    .where(eq(billingPaymentMethods.projectId, projectId));
}

export async function findDefaultPaymentMethod(
  db: Db,
  projectId: string,
): Promise<BillingPaymentMethod | null> {
  const rows = await db
    .select()
    .from(billingPaymentMethods)
    .where(
      and(
        eq(billingPaymentMethods.projectId, projectId),
        eq(billingPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function setDefaultPaymentMethod(
  db: Db,
  projectId: string,
  paymentMethodId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(billingPaymentMethods)
      .set({ isDefault: false })
      .where(
        and(
          eq(billingPaymentMethods.projectId, projectId),
          eq(billingPaymentMethods.isDefault, true),
        ),
      );
    await tx
      .update(billingPaymentMethods)
      .set({ isDefault: true })
      .where(eq(billingPaymentMethods.id, paymentMethodId));
  });
}

export async function deletePaymentMethod(
  db: Db,
  paymentMethodId: string,
): Promise<void> {
  await db
    .delete(billingPaymentMethods)
    .where(eq(billingPaymentMethods.id, paymentMethodId));
}
