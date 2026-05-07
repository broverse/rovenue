import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { StoreId } from "./types";

export const storeBadgeVariants = cva(
  "inline-flex items-center justify-center rounded-[4px] border border-rv-divider bg-rv-c3 font-rv-mono font-semibold tracking-tight",
  {
    variants: {
      size: {
        sm: "size-[18px] text-[9px]",
        md: "h-5 px-1.5 text-[10px]",
      },
      store: {
        ios: "text-rv-mute-800",
        android: "text-emerald-300",
        web: "text-sky-300",
      },
    },
    defaultVariants: { size: "sm", store: "ios" },
  },
);

const STORE_LABEL: Record<StoreId, string> = {
  ios: "iOS",
  android: "A",
  web: "W",
};

export type StoreBadgeProps = Omit<VariantProps<typeof storeBadgeVariants>, "store"> & {
  store: StoreId;
  className?: string;
};

export function StoreBadge({ store, size, className }: StoreBadgeProps) {
  return (
    <span
      role="img"
      aria-label={store}
      className={cn(storeBadgeVariants({ size, store }), className)}
    >
      {STORE_LABEL[store]}
    </span>
  );
}

type StoreBadgesProps = {
  stores: ReadonlyArray<StoreId>;
  size?: VariantProps<typeof storeBadgeVariants>["size"];
  className?: string;
};

/** Stack of `StoreBadge` chips — one per store the product is published to. */
export function StoreBadges({ stores, size, className }: StoreBadgesProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {stores.map((s) => (
        <StoreBadge key={s} store={s} size={size} />
      ))}
    </span>
  );
}
