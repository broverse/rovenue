import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Box,
  Check,
  Copy,
  KeyRound,
  Package,
  Plus,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { StoreBadges } from "../products/store-badge";
import type { StoreId } from "../products/types";
import { cn } from "../../lib/cn";
import { AccessHeader } from "./access-header";

type Props = {
  accessRow: DashboardAccessRow | null;
  grantingProducts: ReadonlyArray<DashboardProductRow>;
  /** Whether the project has any access rows at all (drives empty copy). */
  hasAnyAccess: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCreate: () => void;
};

const STORE_KEYS: StoreId[] = ["ios", "android", "web"];

const TYPE_LABEL: Record<string, string> = {
  SUBSCRIPTION: "Subscription",
  CONSUMABLE: "Consumable",
  NON_CONSUMABLE: "One-time",
};

/**
 * Right-hand column of the Access page. When a row is selected it stacks the
 * header card, a plain-language "how subscribers get this" explainer with a
 * real SDK snippet, and the list of products that grant it. With nothing
 * selected it teaches the underlying concept instead of showing a bare prompt.
 */
export function AccessDetail({
  accessRow,
  grantingProducts,
  hasAnyAccess,
  onEdit,
  onDelete,
  onCreate,
}: Props) {
  if (!accessRow) {
    return <ConceptEmptyState hasAnyAccess={hasAnyAccess} onCreate={onCreate} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AccessHeader
        accessRow={accessRow}
        grantingCount={grantingProducts.length}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <HowItWorks accessRow={accessRow} />

      <GrantingProducts products={grantingProducts} />
    </div>
  );
}

function HowItWorks({ accessRow }: { accessRow: DashboardAccessRow }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const snippet = `import { useEntitlement } from "@rovenue/sdk-rn";\n\nconst access = useEntitlement("${accessRow.identifier}");\nif (access?.active) {\n  // unlock the feature\n}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable — no-op.
    }
  };

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} className="text-rv-accent-500" />
        <h3 className="text-[13px] font-semibold">
          {t("access.how.heading", "How subscribers get this access")}
        </h3>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed text-rv-mute-600">
        {t(
          "access.how.body",
          "Anyone who buys one of the products below unlocks",
        )}{" "}
        <span className="font-medium text-foreground">
          {accessRow.displayName}
        </span>
        . {t("access.how.body2", "Your app checks it through the SDK:")}
      </p>

      <div className="group relative mt-3 overflow-x-auto rounded-md border border-rv-divider bg-black/25">
        <button
          type="button"
          onClick={copy}
          aria-label={t("access.how.copy", "Copy snippet")}
          className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded border border-rv-divider bg-rv-c3 px-1.5 py-1 font-rv-mono text-[10px] text-rv-mute-600 opacity-0 transition hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        >
          {copied ? (
            <Check size={11} className="text-rv-success" />
          ) : (
            <Copy size={11} />
          )}
          {copied
            ? t("access.menu.copied", "Copied")
            : t("access.how.copy", "Copy")}
        </button>
        <pre className="overflow-x-auto p-3 font-rv-mono text-[11.5px] leading-[1.6] text-rv-mute-700">
          <code>{renderSnippet(accessRow.identifier)}</code>
        </pre>
      </div>
    </section>
  );
}

/** Lightly highlighted snippet — keeps the string the identifier so the link
 *  between the dashboard "Access" and the SDK "entitlement" is unmistakable. */
function renderSnippet(identifier: string) {
  return (
    <>
      <span className="text-rv-mute-500">import</span>{" "}
      {"{ useEntitlement } "}
      <span className="text-rv-mute-500">from</span>{" "}
      <span className="text-emerald-300/80">"@rovenue/sdk-rn"</span>;{"\n\n"}
      <span className="text-rv-mute-500">const</span> access ={" "}
      <span className="text-sky-300/80">useEntitlement</span>(
      <span className="text-amber-300/90">"{identifier}"</span>);{"\n"}
      <span className="text-rv-mute-500">if</span> (access?.active) {"{"}
      {"\n  "}
      <span className="text-rv-mute-500">{"// unlock the feature"}</span>
      {"\n"}
      {"}"}
    </>
  );
}

function GrantingProducts({
  products,
}: {
  products: ReadonlyArray<DashboardProductRow>;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
      <div className="flex items-center gap-2">
        <Package size={14} className="text-rv-mute-600" />
        <h3 className="text-[13px] font-semibold">
          {t("access.grantingProducts.heading", "Products that grant it")}
        </h3>
        {products.length > 0 && (
          <span className="font-rv-mono text-[11px] text-rv-mute-500">
            {products.length}
          </span>
        )}
      </div>

      {products.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-rv-divider bg-rv-c2/30 px-3 py-5 text-center">
          <p className="text-[12.5px] text-rv-mute-600">
            {t(
              "access.grantingProducts.empty",
              "No product grants this access yet.",
            )}
          </p>
          <p className="mt-1 text-[11.5px] text-rv-mute-500">
            {t(
              "access.grantingProducts.emptyHint",
              "Open a product and link it to this access so purchases unlock it.",
            )}
          </p>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {products.map((p) => (
            <ProductRow key={p.id} product={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProductRow({ product }: { product: DashboardProductRow }) {
  const stores = STORE_KEYS.filter((s) => Boolean(product.storeIds?.[s]));
  const typeLabel = TYPE_LABEL[product.type] ?? product.type;

  return (
    <li className="flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c2/40 px-3 py-2.5 transition hover:border-rv-divider-strong hover:bg-rv-c2/70">
      <div className="grid size-7 shrink-0 place-items-center rounded border border-rv-divider bg-rv-c3 text-rv-mute-600">
        <Box size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {product.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-[4px] px-1.5 py-0.5 font-rv-mono text-[9.5px] uppercase tracking-wide",
              product.type === "SUBSCRIPTION"
                ? "bg-rv-accent-500/12 text-rv-accent-500"
                : "bg-rv-c4 text-rv-mute-600",
            )}
          >
            {typeLabel}
          </span>
        </div>
        <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
          {product.identifier}
        </div>
      </div>
      {stores.length > 0 && <StoreBadges stores={stores} size="sm" />}
    </li>
  );
}

function ConceptEmptyState({
  hasAnyAccess,
  onCreate,
}: {
  hasAnyAccess: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center rounded-lg border border-rv-divider bg-rv-c1 px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-rv-accent-500/25 bg-rv-accent-500/10 text-rv-accent-500">
        <KeyRound size={22} />
      </div>

      <h3 className="mt-4 text-[16px] font-semibold tracking-tight">
        {t("access.concept.title", "What is an access level?")}
      </h3>
      <p className="mt-1.5 max-w-[440px] text-[13px] leading-relaxed text-rv-mute-600">
        {t(
          "access.concept.body",
          "A capability your subscribers unlock — like Pro or Premium. A product grants it on purchase, and your app checks it through the SDK to gate features.",
        )}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 font-rv-mono text-[11px]">
        <FlowChip icon={<Box size={13} />} label={t("access.concept.flowProduct", "Product")} />
        <ArrowRight size={13} className="text-rv-mute-600" />
        <FlowChip
          icon={<KeyRound size={13} />}
          label={t("access.concept.flowAccess", "Access level")}
          accent
        />
        <ArrowRight size={13} className="text-rv-mute-600" />
        <FlowChip
          icon={<Sparkles size={13} />}
          label={t("access.concept.flowFeature", "Feature unlocked")}
        />
      </div>

      <div className="mt-7">
        {hasAnyAccess ? (
          <p className="text-[12px] text-rv-mute-500">
            {t(
              "access.concept.selectHint",
              "Select an access level on the left to inspect it.",
            )}
          </p>
        ) : (
          <Button variant="solid-primary" size="sm" onClick={onCreate}>
            <Plus size={13} />
            {t("access.concept.cta", "Create your first access level")}
          </Button>
        )}
      </div>
    </div>
  );
}

function FlowChip({
  icon,
  label,
  accent = false,
}: {
  icon: ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5",
        accent
          ? "border-rv-accent-500/25 bg-rv-accent-500/10 text-rv-accent-500"
          : "border-rv-divider bg-rv-c2/50 text-rv-mute-700",
      )}
    >
      {icon}
      {label}
    </span>
  );
}
