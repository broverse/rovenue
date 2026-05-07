import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { Sparkline } from "../dashboard/sparkline";
import { IconArrowUp, IconKey, IconX } from "../dashboard/icons";
import { DurationTag } from "./duration-tag";
import { formatDuration, formatPrice } from "./format";
import { ProductIcon } from "./product-icon";
import { StatusChip } from "./status-chip";
import { StoreBadges } from "./store-badge";
import type { Product } from "./types";

const TABS = ["overview", "pricing", "entitlements", "subscribers", "activity"] as const;
type Tab = (typeof TABS)[number];

type Props = {
  product: Product | null;
  onClose: () => void;
};

/**
 * Right-side slide-over with tabbed product detail. Backed by base-ui Dialog
 * for focus trapping + escape-to-close + return-focus on dismiss.
 */
export function ProductDrawer({ product, onClose }: Props) {
  return (
    <Dialog.Root
      open={product != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity duration-200" />
        <Dialog.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[520px] max-w-[100vw] flex-col border-l border-rv-divider bg-rv-c1 shadow-[-20px_0_60px_rgba(0,0,0,0.4)]",
            "transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full",
            "focus:outline-none",
          )}
        >
          {product && <DrawerContent product={product} onClose={onClose} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DrawerContent({ product, onClose }: { product: Product; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("overview");

  // Synthesize a stable mini-revenue series keyed off the product id.
  const series = useMemo(() => {
    const rng = mulberry32(hashId(product.id));
    return Array.from({ length: 28 }, () =>
      product.mrr ? product.mrr / 28 + (rng() - 0.5) * (product.mrr / 10) : rng() * 10,
    );
  }, [product.id, product.mrr]);

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-rv-divider px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <ProductIcon name={product.name} size="md" />
            <div className="min-w-0">
              <Dialog.Title className="truncate text-[16px] font-semibold">
                {product.name}
              </Dialog.Title>
              <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
                {product.id}
              </div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <StatusChip status={product.status} />
            <DurationTag>{formatDuration(product.duration)}</DurationTag>
            {product.trial && <DurationTag tone="trial">{product.trial} trial</DurationTag>}
            <StoreBadges stores={product.stores} />
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="flat" size="sm" className="h-7">
            {t("products.drawer.edit")}
          </Button>
          <Button
            variant="light"
            size="icon"
            aria-label={t("products.drawer.close")}
            onClick={onClose}
          >
            <IconX size={14} />
          </Button>
        </div>
      </header>

      <div role="tablist" className="flex gap-0.5 border-b border-rv-divider px-3">
        {TABS.map((tabId) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            aria-selected={tab === tabId}
            onClick={() => setTab(tabId)}
            className={cn(
              "cursor-pointer border-b-2 border-transparent px-2.5 py-2 text-[12px] font-medium text-rv-mute-500 transition hover:text-rv-mute-800",
              tab === tabId && "border-rv-accent-500 text-foreground",
            )}
          >
            {t(`products.drawer.tabs.${tabId}`)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-10 pt-4 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
        {tab === "overview" && <OverviewTab product={product} series={series} />}
        {tab === "pricing" && <PricingTab product={product} />}
        {tab === "entitlements" && <EntitlementsTab product={product} />}
        {tab === "subscribers" && <SubscribersTab product={product} />}
        {tab === "activity" && <ActivityTab product={product} />}
      </div>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
      {children}
    </h4>
  );
}

function KvRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-3 border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0">
      <dt className="font-rv-mono text-[11px] text-rv-mute-500">{k}</dt>
      <dd className="m-0 break-all font-rv-mono tabular-nums text-rv-mute-800">{v}</dd>
    </div>
  );
}

function OverviewTab({ product, series }: { product: Product; series: number[] }) {
  const { t } = useTranslation();
  return (
    <>
      <section className="mb-5">
        <SectionHeading>{t("products.drawer.performance")}</SectionHeading>
        <div className="grid grid-cols-3 gap-3">
          <MiniKpi
            label={t("products.kpi.mrr")}
            value={`$${product.mrr.toLocaleString()}`}
            delta="8.2%"
            positive
          />
          <MiniKpi
            label={t("products.kpi.activeSubs")}
            value={product.subs == null ? "—" : product.subs.toLocaleString()}
            delta="34"
            positive
          />
          <MiniKpi
            label={t("products.kpi.conversion")}
            value={product.trial ? "42%" : "—"}
            delta={product.trial ? t("products.drawer.trialToPaid") : t("products.drawer.noTrial")}
          />
        </div>
        <div className="mt-3">
          <Sparkline data={series} color="var(--color-rv-accent-500)" height={60} />
        </div>
      </section>

      <section>
        <SectionHeading>{t("products.drawer.details")}</SectionHeading>
        <dl className="m-0">
          <KvRow k="sku" v={product.sku} />
          <KvRow k="group" v={product.group} />
          <KvRow k="duration" v={product.duration} />
          <KvRow k="trial" v={product.trial ?? "—"} />
          <KvRow k="currency" v={product.currency} />
          <KvRow k="created_at" v={product.created} />
          <KvRow k="updated_at" v={product.updated} />
        </dl>
      </section>
    </>
  );
}

function PricingTab({ product }: { product: Product }) {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading>{t("products.drawer.storePricing")}</SectionHeading>
      <dl className="m-0">
        {product.stores.map((store) => (
          <KvRow key={store} k={store} v={formatPrice(product.price, product.currency)} />
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-rv-mute-500">
        {t("products.drawer.regionalNote", { group: product.group })}
      </p>
    </section>
  );
}

function EntitlementsTab({ product }: { product: Product }) {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading>{t("products.drawer.grantsOnPurchase")}</SectionHeading>
      {product.entitlements.length === 0 ? (
        <p className="text-[12px] text-rv-mute-500">{t("products.drawer.consumableNoGrants")}</p>
      ) : (
        product.entitlements.map((e) => (
          <div
            key={e}
            className="flex items-center gap-2.5 border-b border-rv-divider py-2 text-[12px] last:border-b-0"
          >
            <IconKey size={14} className="text-rv-violet" />
            <code className="font-rv-mono text-[12px] text-rv-mute-800">{e}</code>
            <span className="ml-auto font-rv-mono text-[11px] text-rv-mute-500">
              {t("products.drawer.grantedOnPurchase")}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function SubscribersTab({ product }: { product: Product }) {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading>
        {product.subs == null
          ? t("products.drawer.noSubscribersConsumable")
          : t("products.drawer.activeSubscribersCount", { count: product.subs })}
      </SectionHeading>
      {product.subs != null && (
        <p className="text-[12px] text-rv-mute-700">{t("products.drawer.openFullList")}</p>
      )}
    </section>
  );
}

function ActivityTab({ product }: { product: Product }) {
  const { t } = useTranslation();
  return (
    <section>
      <SectionHeading>{t("products.drawer.recentChanges")}</SectionHeading>
      <ol className="relative m-0 list-none p-0 pl-5 before:absolute before:left-[5px] before:top-1 before:bottom-1 before:w-px before:bg-rv-divider">
        <TimelineItem label="price_updated" detail={`${product.updated} · by furkan@posely.app`} />
        <TimelineItem label="entitlement_linked" detail="3d ago · premium" />
        <TimelineItem label="product_created" detail={product.created} />
      </ol>
    </section>
  );
}

function TimelineItem({ label, detail }: { label: string; detail: string }) {
  return (
    <li
      className={cn(
        "relative py-1.5 pb-2.5 pl-0 text-[12px]",
        "before:absolute before:-left-[16px] before:top-2.5 before:size-2 before:rounded-full before:border-2 before:border-rv-c1 before:bg-rv-accent-500 before:shadow-[0_0_0_1px_var(--color-rv-accent-500)]",
      )}
    >
      <div className="font-rv-mono text-[12px] text-rv-mute-800">{label}</div>
      <div className="mt-0.5 font-rv-mono text-[11px] text-rv-mute-500">{detail}</div>
    </li>
  );
}

function MiniKpi({
  label,
  value,
  delta,
  positive,
}: {
  label: string;
  value: string;
  delta: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-md border border-rv-divider bg-rv-c1 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-1 font-rv-mono text-[18px] tabular-nums">{value}</div>
      <div
        className={cn(
          "mt-0.5 inline-flex items-center gap-0.5 font-rv-mono text-[11px]",
          positive ? "text-rv-success" : "text-rv-mute-500",
        )}
      >
        {positive && <IconArrowUp size={9} />}
        {delta}
      </div>
    </div>
  );
}

// Tiny, deterministic pseudo-random helpers so the per-product sparkline
// stays stable across re-renders without pulling in a dependency.
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
