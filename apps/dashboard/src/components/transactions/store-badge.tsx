import { cva, type VariantProps } from "class-variance-authority";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { TxStore } from "./types";

/**
 * Square brand chip used across the transactions page (table row, store
 * breakdown, inspector references). Apple is intentionally blank — the
 * black tile alone carries the meaning. Play uses an inline triangle, the
 * remaining stores carry a single-letter mark.
 */
export const storeAvatarVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-rv-mono font-bold",
  {
    variants: {
      size: {
        xs: "size-4 rounded-[3px] text-[8px]",
        sm: "size-5 rounded-[4px] text-[9px]",
        md: "size-8 rounded-md text-[12px]",
      },
      store: {
        ios: "bg-black text-white",
        play: "bg-gradient-to-br from-emerald-500 to-blue-500 text-white",
        stripe: "bg-[#635BFF] text-white",
        web: "border border-rv-divider bg-rv-c3 text-rv-mute-700",
      },
    },
    defaultVariants: { size: "sm", store: "ios" },
  },
);

export type StoreAvatarProps = VariantProps<typeof storeAvatarVariants> & {
  store: TxStore;
  className?: string;
};

const GLYPH: Record<TxStore, string> = {
  ios: "",
  play: "▶",
  stripe: "S",
  web: "W",
};

/** Square brand chip — used as a stand-alone visual mark. */
export function StoreAvatar({ store, size, className }: StoreAvatarProps) {
  return (
    <span className={cn(storeAvatarVariants({ size, store }), className)} aria-hidden="true">
      {GLYPH[store]}
    </span>
  );
}

/** Avatar + label — used inline in table rows. */
export function StoreInlineBadge({ store }: { store: TxStore }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-700">
      <StoreAvatar store={store} size="xs" />
      {store === "ios"
        ? t("transactions.stores.appStore")
        : store === "play"
          ? "Play"
          : store === "stripe"
            ? "Stripe"
            : "Web"}
    </span>
  );
}
