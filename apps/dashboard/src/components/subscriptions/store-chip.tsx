import { Apple, CreditCard, Globe, PenLine, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { SubscriptionStore } from "./types";

const LOGO_CLASS =
  "inline-flex size-[18px] items-center justify-center rounded-[4px] border border-rv-divider";

const STORE_LOGO: Record<SubscriptionStore, { className: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  ios: { className: "border-transparent bg-black text-white", icon: Apple },
  play: {
    className:
      "border-transparent bg-[linear-gradient(135deg,#34A853,#4285F4)] text-white",
    icon: Play,
  },
  stripe: {
    className: "border-transparent bg-[#635BFF] text-white",
    icon: CreditCard,
  },
  web: { className: "bg-rv-c3 text-rv-mute-700", icon: Globe },
  manual: { className: "bg-rv-c3 text-rv-mute-700", icon: PenLine },
};

type Props = {
  store: SubscriptionStore;
  className?: string;
};

/**
 * Store badge with a small lucide logo + readable label. Matches the
 * design's `.store` pill — used in the table and KV list.
 */
export function StoreChip({ store, className }: Props) {
  const { t } = useTranslation();
  const meta = STORE_LOGO[store];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-rv-mono text-[11px] text-rv-mute-700",
        className,
      )}
    >
      <span className={cn(LOGO_CLASS, meta.className)}>
        <Icon size={10} />
      </span>
      {t(`subscriptions.stores.${store}.label`)}
    </span>
  );
}

/** Long form name used inside the expanded row's billing kv list. */
export function storeFullName(
  store: SubscriptionStore,
  t: (key: string) => string,
): string {
  return t(`subscriptions.stores.${store}.full`);
}
