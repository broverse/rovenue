import { Trans, useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { OfferingCard } from "./offering-card";
import type { ProductGroup } from "./types";

type Props = {
  group: ProductGroup;
};

/**
 * Grid of paywall configurations bound to the selected group. The card
 * marked `default` is auto-served when no experiment or override matches.
 */
export function OfferingsSection({ group }: Props) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between">
        <div>
          <h3 className="text-[14px] font-semibold">{t("productGroups.offerings.heading")}</h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            <Trans
              i18nKey="productGroups.offerings.subtitle"
              components={[
                <code
                  key="0"
                  className="rounded bg-rv-c3 px-1 py-0.5 font-rv-mono text-[11px] text-rv-mute-700"
                />,
              ]}
            />
          </p>
        </div>
        <Button variant="flat" size="sm">
          <Plus size={13} />
          {t("productGroups.actions.newOffering")}
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
        {group.offerings.map((o) => (
          <OfferingCard key={o.key} offering={o} />
        ))}
      </div>
    </section>
  );
}
