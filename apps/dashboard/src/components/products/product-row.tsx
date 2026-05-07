import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { IconMore } from "../dashboard/icons";
import { DurationTag } from "./duration-tag";
import { EntitlementList } from "./entitlement-chip";
import { formatDuration, formatPrice } from "./format";
import { ProductIcon } from "./product-icon";
import { StatusChip } from "./status-chip";
import { StoreBadges } from "./store-badge";
import type { Product } from "./types";

type Props = {
  product: Product;
  /** Whether the row's checkbox is ticked. */
  selected: boolean;
  /** Whether the row is the one currently shown in the drawer. */
  active: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
};

export function ProductRow({ product, selected, active, onToggleSelected, onOpen }: Props) {
  const dimmed = product.status === "archived";
  return (
    <tr
      onClick={onOpen}
      className={cn(
        "group cursor-pointer border-b border-white/[0.04] transition hover:bg-rv-c2",
        active &&
          "bg-rv-accent-500/[0.08] [&>td:first-child]:shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
        dimmed && "opacity-70",
      )}
    >
      <td className="w-7 px-3 py-2.5">
        <Checkbox
          checked={selected}
          onChange={onToggleSelected}
          ariaLabel={`Select ${product.name}`}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ProductIcon name={product.name} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">{product.name}</div>
            <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
              {product.sku}
            </div>
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5">
        <DurationTag>{formatDuration(product.duration)}</DurationTag>
        {product.trial && (
          <DurationTag tone="trial" className="ml-1">
            {product.trial} trial
          </DurationTag>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span className="text-[12px] text-rv-mute-700">{product.group}</span>
      </td>
      <td className="px-3 py-2.5">
        <EntitlementList entitlements={product.entitlements} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums">
        {formatPrice(product.price, product.currency)}
        <span className="ml-1 text-[10px] text-rv-mute-500">{product.currency}</span>
      </td>
      <td className="px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums">
        {product.subs == null ? "—" : product.subs.toLocaleString()}
      </td>
      <td className="px-3 py-2.5 text-right font-rv-mono text-[13px] tabular-nums">
        {product.mrr === 0 ? "—" : `$${product.mrr.toLocaleString()}`}
      </td>
      <td className="px-3 py-2.5">
        <StoreBadges stores={product.stores} />
      </td>
      <td className="px-3 py-2.5">
        <StatusChip status={product.status} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 font-rv-mono text-[11px] text-rv-mute-500">
        {product.updated}
      </td>
      <td className="w-8 px-2 py-2.5">
        <Button
          variant="light"
          size="icon"
          aria-label={`Actions for ${product.name}`}
          className="size-6 opacity-0 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <IconMore size={14} />
        </Button>
      </td>
    </tr>
  );
}
