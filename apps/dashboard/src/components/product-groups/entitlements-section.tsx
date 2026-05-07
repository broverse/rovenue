import { Trans, useTranslation } from "react-i18next";
import { Key, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "../../ui/button";
import type { EntitlementGrant, ProductGroup } from "./types";

type Props = {
  group: ProductGroup;
};

/**
 * Lists every entitlement key granted by any product in the selected
 * group. Renders an empty-state when the group is consumable-only.
 */
export function EntitlementsSection({ group }: Props) {
  const { t } = useTranslation();
  const grantingProducts = group.products.filter((p) => p.status !== "archived").length;

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">{t("productGroups.entitlements.heading")}</h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("productGroups.entitlements.subtitle")}
          </p>
        </div>
        <Button variant="flat" size="sm">
          <Plus size={13} />
          {t("productGroups.actions.add")}
        </Button>
      </header>

      {group.entitlements.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
            <Key size={16} />
          </div>
          <h4 className="mb-1 text-[13px] font-semibold">
            {t("productGroups.entitlements.empty.title")}
          </h4>
          <p className="max-w-[320px] text-[12px] text-rv-mute-500">
            {t("productGroups.entitlements.empty.body")}
          </p>
        </div>
      ) : (
        group.entitlements.map((e) => (
          <EntitlementRow key={e.key} entitlement={e} grantingProducts={grantingProducts} />
        ))
      )}
    </section>
  );
}

type RowProps = {
  entitlement: EntitlementGrant;
  grantingProducts: number;
};

function EntitlementRow({ entitlement, grantingProducts }: RowProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-rv-divider px-5 py-3 last:border-b-0">
      <div>
        <div className="flex items-center gap-2.5 font-rv-mono text-[13px] font-semibold">
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-rv-violet/15 text-[color-mix(in_srgb,var(--color-rv-violet)_25%,white)]">
            <Key size={12} />
          </span>
          <span>{entitlement.key}</span>
        </div>
        <div className="mt-1 text-[11px] text-rv-mute-500">{entitlement.description}</div>
      </div>
      <div className="font-rv-mono text-[11px] text-rv-mute-500">
        <Trans
          i18nKey="productGroups.entitlements.grantedBy"
          values={{ count: grantingProducts }}
          components={[<span key="0" className="text-rv-mute-800" />]}
        />
      </div>
      <Button variant="light" size="icon" aria-label={t("productGroups.actions.more")}>
        <MoreHorizontal size={14} />
      </Button>
    </div>
  );
}
