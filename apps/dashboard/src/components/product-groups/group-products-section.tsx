import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers, Plus, X } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { RemoveProductDialog } from "./remove-product-dialog";
import type { GroupProduct, ProductGroup } from "./types";

type Props = {
  projectId: string;
  group: ProductGroup;
  /** Triggered by both the section header and the empty-state CTA. */
  onLinkProduct: () => void;
};

/**
 * Lists every product currently bound to the group with their pricing,
 * duration, and revenue. Each row exposes a "Remove" action that opens a
 * confirm dialog before PATCHing the group's membership array.
 */
export function GroupProductsSection({ projectId, group, onLinkProduct }: Props) {
  const { t } = useTranslation();
  const [removeTarget, setRemoveTarget] = useState<GroupProduct | null>(null);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-start justify-between gap-4 border-b border-rv-divider px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("productGroups.products.heading", "Products in this group")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t(
              "productGroups.products.subtitle",
              "Subscribers who buy any product below enter this group.",
            )}
          </p>
        </div>
        <Button variant="flat" size="sm" onClick={onLinkProduct}>
          <Plus size={13} />
          {t("productGroups.products.link", "Link product")}
        </Button>
      </header>

      {group.products.length === 0 ? (
        <EmptyState onLinkProduct={onLinkProduct} />
      ) : (
        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_120px_120px_80px_100px_44px] gap-3 px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            <div>{t("productGroups.products.col.product", "Product")}</div>
            <div>{t("productGroups.products.col.duration", "Duration")}</div>
            <div>{t("productGroups.products.col.price", "Price")}</div>
            <div className="text-right">
              {t("productGroups.products.col.subs", "Subs")}
            </div>
            <div className="text-right">
              {t("productGroups.products.col.mrr", "MRR")}
            </div>
            <div />
          </div>
          <ul>
            {group.products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                onRemove={() => setRemoveTarget(product)}
              />
            ))}
          </ul>
        </div>
      )}

      <RemoveProductDialog
        projectId={projectId}
        group={group}
        product={removeTarget}
        open={removeTarget != null}
        onClose={() => setRemoveTarget(null)}
      />
    </section>
  );
}

function EmptyState({ onLinkProduct }: { onLinkProduct: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-mute-500">
        <Layers size={18} />
      </div>
      <div>
        <div className="text-[14px] font-semibold">
          {t("productGroups.products.empty.title", "No products linked yet")}
        </div>
        <p className="mt-0.5 max-w-[360px] text-[12px] text-rv-mute-500">
          {t(
            "productGroups.products.empty.body",
            "Link existing products from your catalog to grant this group's entitlements on purchase.",
          )}
        </p>
      </div>
      <Button variant="solid-primary" size="sm" onClick={onLinkProduct}>
        <Plus size={13} />
        {t("productGroups.products.link", "Link product")}
      </Button>
    </div>
  );
}

function ProductRow({
  product,
  onRemove,
}: {
  product: GroupProduct;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_120px_120px_80px_100px_44px] items-center gap-3 border-t border-rv-divider px-5 py-2.5 text-[13px] transition",
      )}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{product.name}</div>
        <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
          {product.sku}
        </div>
      </div>
      <div className="font-rv-mono text-[12px] text-rv-mute-600">
        {t(`productGroups.duration.${product.duration}`, product.duration)}
      </div>
      <div className="font-rv-mono text-[12px] tabular-nums text-foreground">
        {product.price}
      </div>
      <div className="text-right font-rv-mono text-[12px] tabular-nums text-rv-mute-600">
        {product.subs == null ? "—" : product.subs.toLocaleString()}
      </div>
      <div className="text-right font-rv-mono text-[12px] tabular-nums text-foreground">
        ${product.mrr.toLocaleString()}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("productGroups.products.remove", "Remove from group")}
          className="rounded-md p-1.5 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-rv-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}
