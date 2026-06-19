import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui-components/react/dialog";
import { Popover } from "@base-ui-components/react/popover";
import { AlertTriangle, ArrowUp, Check, Layers, Plus, Trash2, X } from "lucide-react";
import type {
  DashboardOfferingRow,
  DashboardOfferingUpdateInput,
  OfferingMembership,
} from "@rovenue/shared";
import { Button, buttonVariants } from "../../ui/button";
import { cn } from "../../lib/cn";
import { api } from "../../lib/api";
import { useProjectOfferings } from "../../lib/hooks/useProjectOfferings";
import { Sparkline } from "../dashboard/sparkline";
import { DurationTag } from "./duration-tag";
import { formatDuration, formatPrice } from "./format";
import { ProductIcon } from "./product-icon";
import { StatusChip } from "./status-chip";
import { StoreBadges } from "./store-badge";
import type { Product } from "./types";

const TABS = ["overview", "pricing", "groups", "activity"] as const;
type Tab = (typeof TABS)[number];

type Props = {
  projectId: string;
  product: Product | null;
  onClose: () => void;
  onEdit?: (productId: string) => void;
};

/**
 * Right-side slide-over with tabbed product detail. Backed by base-ui Dialog
 * for focus trapping + escape-to-close + return-focus on dismiss.
 */
export function ProductDrawer({ projectId, product, onClose, onEdit }: Props) {
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
          {product && (
            <DrawerContent
              projectId={projectId}
              product={product}
              onClose={onClose}
              onEdit={onEdit}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DrawerContent({
  projectId,
  product,
  onClose,
  onEdit,
}: {
  projectId: string;
  product: Product;
  onClose: () => void;
  onEdit?: (productId: string) => void;
}) {
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
          <Button
            variant="flat"
            size="sm"
            className="h-7"
            onClick={() => onEdit?.(product.id)}
          >
            {t("products.drawer.edit")}
          </Button>
          <Button
            variant="light"
            size="icon"
            aria-label={t("products.drawer.close")}
            onClick={onClose}
          >
            <X size={14} />
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
        {tab === "groups" && <GroupsTab projectId={projectId} product={product} />}
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

function GroupsTab({ projectId, product }: { projectId: string; product: Product }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const groupsQuery = useProjectOfferings(projectId);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<DashboardOfferingRow | null>(null);

  const allGroups = groupsQuery.data?.offerings ?? [];

  const memberOf = useMemo(
    () =>
      allGroups.filter((g: DashboardOfferingRow) =>
        g.packages.some((m: OfferingMembership) => m.productId === product.id),
      ),
    [allGroups, product.id],
  );
  const candidates = useMemo(
    () =>
      allGroups.filter(
        (g: DashboardOfferingRow) =>
          !g.packages.some((m: OfferingMembership) => m.productId === product.id),
      ),
    [allGroups, product.id],
  );

  // `useUpdateOffering` is now per-id-bound, so we can't construct a single
  // hook to PATCH whatever offering the user clicks. Issue the PATCH directly
  // via `api()` and invalidate the cache by hand.
  const patchOffering = async (
    offeringId: string,
    body: DashboardOfferingUpdateInput,
  ) => {
    setPending(true);
    setMutationError(null);
    try {
      await api(`/dashboard/projects/${projectId}/offerings/${offeringId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await qc.invalidateQueries({ queryKey: ["offerings"] });
    } catch (e) {
      setMutationError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setPending(false);
    }
  };

  const link = (group: DashboardOfferingRow) => {
    const nextOrder =
      group.packages.length === 0
        ? 0
        : Math.max(
            ...group.packages.map((m: OfferingMembership) => m.order ?? 0),
          ) + 1;
    const nextPackages: OfferingMembership[] = [
      ...group.packages,
      { identifier: `custom_${product.id.slice(0, 8)}`, productId: product.id, order: nextOrder, isPromoted: false },
    ];
    void patchOffering(group.id, { packages: nextPackages });
  };

  const unlink = async (group: DashboardOfferingRow) => {
    const nextPackages = group.packages.filter(
      (m: OfferingMembership) => m.productId !== product.id,
    );
    await patchOffering(group.id, { packages: nextPackages });
  };

  const confirmUnlink = async () => {
    if (!confirmGroup) return;
    await unlink(confirmGroup);
    setConfirmGroup(null);
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <SectionHeading>{t("products.drawer.groups.heading")}</SectionHeading>
        {candidates.length > 0 && (
          <LinkGroupMenu candidates={candidates} onPick={link} />
        )}
      </div>

      {groupsQuery.isPending ? (
        <p className="text-[12px] text-rv-mute-500">{t("common.loading")}</p>
      ) : memberOf.length === 0 ? (
        <EmptyGroups
          hasCandidates={candidates.length > 0}
          onPick={link}
          candidates={candidates}
        />
      ) : (
        <ul className="m-0 list-none p-0">
          {memberOf.map((g) => {
            const membership = g.packages.find((m: OfferingMembership) => m.productId === product.id);
            return (
              <li
                key={g.id}
                className="flex items-center gap-2.5 border-b border-rv-divider py-2 text-[12px] last:border-b-0"
              >
                <Layers size={14} className="text-rv-accent-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-rv-mono text-[12px] text-foreground">
                    {g.identifier}
                  </div>
                  <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
                    {g.isDefault
                      ? t("products.drawer.groups.defaultBadge")
                      : t("products.drawer.groups.memberCount", {
                          count: g.packages.length,
                        })}
                    {membership?.isPromoted && (
                      <>
                        {" · "}
                        {t("products.drawer.groups.promoted")}
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmGroup(g)}
                  disabled={pending}
                  className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-rv-danger disabled:opacity-60"
                  aria-label={t("products.drawer.groups.unlink", { name: g.identifier })}
                  title={t("products.drawer.groups.unlink", { name: g.identifier })}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {mutationError && (
        <p className="mt-2 text-[11px] text-rv-danger" role="alert">
          {mutationError.message || t("products.drawer.groups.error")}
        </p>
      )}

      <UnlinkOfferingDialog
        group={confirmGroup}
        pending={pending}
        onConfirm={confirmUnlink}
        onClose={() => setConfirmGroup(null)}
      />
    </section>
  );
}

function UnlinkOfferingDialog({
  group,
  pending,
  onConfirm,
  onClose,
}: {
  group: DashboardOfferingRow | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root
      open={group != null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {group && (
            <>
              <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-rv-danger/30 bg-rv-danger/10 text-rv-danger">
                    <AlertTriangle size={16} />
                  </div>
                  <div>
                    <Dialog.Title className="text-[15px] font-semibold leading-5">
                      {t("products.drawer.groups.unlinkTitle")}
                    </Dialog.Title>
                    <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                      {t("products.drawer.groups.unlinkSubtitle")}
                    </Dialog.Description>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t("common.close")}
                  className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
                >
                  <X size={14} />
                </button>
              </header>

              <div className="px-5 py-4">
                <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5 font-rv-mono text-[12px] text-foreground">
                  {group.identifier}
                </div>
              </div>

              <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
                <Button type="button" variant="flat" size="sm" onClick={onClose} disabled={pending}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="solid-primary"
                  size="sm"
                  onClick={onConfirm}
                  disabled={pending}
                  className="!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger"
                >
                  {pending
                    ? t("products.drawer.groups.unlinkPending")
                    : t("products.drawer.groups.unlinkConfirm")}
                </Button>
              </footer>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EmptyGroups({
  hasCandidates,
  onPick,
  candidates,
}: {
  hasCandidates: boolean;
  onPick: (group: DashboardOfferingRow) => void;
  candidates: ReadonlyArray<DashboardOfferingRow>;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-dashed border-rv-divider bg-rv-c2/40 px-3 py-4 text-center">
      <p className="text-[12px] text-rv-mute-500">{t("products.drawer.groups.empty")}</p>
      {hasCandidates && (
        <div className="mt-2 inline-flex">
          <LinkGroupMenu candidates={candidates} onPick={onPick} variant="primary" />
        </div>
      )}
    </div>
  );
}

function LinkGroupMenu({
  candidates,
  onPick,
  variant = "flat",
}: {
  candidates: ReadonlyArray<DashboardOfferingRow>;
  onPick: (group: DashboardOfferingRow) => void;
  variant?: "flat" | "primary";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          buttonVariants({
            variant: variant === "primary" ? "solid-primary" : "flat",
            size: "sm",
          }),
          "h-7",
        )}
      >
        <Plus size={12} />
        {t("products.drawer.groups.linkButton")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[60]">
          <Popover.Popup className="max-h-[260px] w-[240px] overflow-y-auto rounded-lg border border-rv-divider-strong bg-rv-c3 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none animate-rv-menu-in">
            {candidates.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-rv-mute-500">
                {t("products.drawer.groups.noCandidates")}
              </div>
            ) : (
              candidates.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    onPick(g);
                    setOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none hover:bg-rv-c4 hover:text-foreground"
                >
                  <Check size={12} className="text-rv-accent-500 opacity-0" />
                  <span className="truncate font-rv-mono text-[12px]">{g.identifier}</span>
                  {g.isDefault && (
                    <span className="ml-auto rounded bg-rv-accent-500/[0.15] px-1 py-0.5 text-[10px] text-rv-accent-500">
                      {t("products.drawer.groups.defaultBadge")}
                    </span>
                  )}
                </button>
              ))
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
        {positive && <ArrowUp size={9} />}
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
