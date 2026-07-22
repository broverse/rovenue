// =============================================================
// RovenuePaywallView — React Native renderer for Phase-B builder
// paywalls. JS-side sibling of the web renderer
// (packages/paywall-renderer) and the Swift/Kotlin native views;
// semantics are the normative shared set: unknown node → fallback
// else nothing, never a crash; empty packageIds = every offering
// package; restore hidden without a handler; the renderer NEVER
// opens URLs itself; children keyed POSITIONALLY (node ids are
// user-authored and only uniqueness-validated server-side).
// Variables ({{price}} …) resolve against real store pricing from
// the hydrated offering. Builder paywalls auto-track: one
// logPaywallShown per distinct paywall content per mounted view.
//
// Phase D2 (overrides/cellTemplate): every node passes through
// `applyOverrides` BEFORE any style/text resolution, mirroring the web
// renderer's `renderNode` and the Swift/Kotlin `BuilderNodeView.body` —
// `introEligible` is derived NATIVELY from the relevant package's
// `product.isEligibleForIntroOffer` (RN has the enriched StoreProduct
// already hydrated, no separate `priceView`/`eligibility` prop needed);
// `selected` is only ever active for nodes inside a `packageList`'s
// `cellTemplate` subtree, which threads a `CellScope` (packageId + its
// resolved PackageView) in place of the pre-D2 bare `PackageView`.
// =============================================================

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { logPaywallShown, logPaywallClosed } from "../api/paywalls";
import { purchase } from "../api/purchases";
import type { Offering, Paywall, PurchaseResult } from "../types";
import {
  effectivePackageIds,
  initialSelection,
  packageView,
  resolveText,
  resolveVariables,
  themeValue,
  type PackageView,
} from "./helpers";
import { decodeBuilderConfig, type BuilderConfigModel, type BuilderNode } from "./model";
import { activeOverrideConditions, applyOverrides } from "./overrides";

export type RovenuePaywallViewProps = {
  paywall: Paywall;
  locale?: string;
  colorScheme?: "light" | "dark";
  onPurchaseCompleted?: (result: PurchaseResult) => void;
  onPurchaseFailed?: (error: unknown) => void;
  onClose?: () => void;
  /** Omit to HIDE restore buttons entirely (e.g. funnel-like contexts). */
  onRestore?: () => void;
  /** The renderer never navigates itself — scheme-check before opening. */
  onUrl?: (url: string) => void;
};

type Ctx = {
  config: BuilderConfigModel;
  locale?: string;
  dark: boolean;
  offering: Offering | null;
  selectedPackageId: string | null;
  isPurchasing: boolean;
  select: (id: string) => void;
  startPurchase: () => void;
  onClose?: () => void;
  onRestore?: () => void;
  onUrl?: (url: string) => void;
};

/**
 * The package a `cellTemplate` subtree is currently scoped to — carries
 * both the identifier (needed to evaluate the `selected` override
 * condition against the live global selection) and its resolved
 * `PackageView` (needed for `{{variable}}` substitution). `null` outside
 * any `cellTemplate` subtree. Mirrors the Swift/Kotlin siblings' CellScope
 * / nodes.tsx's `insideCellTemplate` + `cellPackageId` pair.
 */
type CellScope = { packageId: string; view: PackageView };

export function RovenuePaywallView(props: RovenuePaywallViewProps): ReactElement | null {
  const { paywall } = props;
  const dark = props.colorScheme === "dark";

  // Identity of "which paywall content is this view showing" — drives both
  // the selection reset and the log-once guard (same composite the Swift
  // paywallStateKey and Kotlin lastBoundContentKey use).
  const contentKey =
    (paywall.paywallIdentifier ?? "") + "|" + JSON.stringify(paywall.builderConfig ?? null);

  const config = useMemo(
    () => (paywall.builderConfig ? decodeBuilderConfig(paywall.builderConfig) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentKey],
  );

  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(() =>
    config ? initialSelection(config.root, paywall.offering) : null,
  );
  const [isPurchasing, setIsPurchasing] = useState(false);
  const lastContentKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastContentKey.current === contentKey) return;
    const isSwap = lastContentKey.current !== null;
    lastContentKey.current = contentKey;
    if (isSwap) {
      // Content swapped under the same mounted view: re-derive selection.
      setSelectedPackageId(config ? initialSelection(config.root, paywall.offering) : null);
      setIsPurchasing(false);
    }
    if (config) logPaywallShown(paywall);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  if (!config) return null; // no/undecodable builderConfig → render nothing

  const ctx: Ctx = {
    config,
    locale: props.locale,
    dark,
    offering: paywall.offering,
    selectedPackageId,
    isPurchasing,
    select: setSelectedPackageId,
    startPurchase: () => {
      if (isPurchasing || !selectedPackageId) return;
      const pkg = paywall.offering?.packages.find((p) => p.identifier === selectedPackageId);
      if (!pkg) return;
      setIsPurchasing(true);
      purchase(pkg)
        .then((result) => props.onPurchaseCompleted?.(result))
        .catch((error) => props.onPurchaseFailed?.(error))
        .finally(() => setIsPurchasing(false));
    },
    onClose: () => {
      logPaywallClosed(paywall);
      props.onClose?.();
    },
    onRestore: props.onRestore,
    onUrl: props.onUrl,
  };

  return (
    <View
      testID={`rov-node-${config.root.id}-bg`}
      style={{
        flex: 1,
        ...(config.background ? { backgroundColor: themeValue(config.background, dark) } : {}),
      }}
    >
      <NodeView node={config.root} ctx={ctx} cell={null} />
    </View>
  );
}

// -------------------------------------------------------------
// Node rendering
// -------------------------------------------------------------

function label(ctx: Ctx, key: string, cell: CellScope | null): string {
  const text = resolveText(ctx.config, ctx.locale, key) ?? "";
  const pkg =
    cell?.view ??
    (() => {
      if (!ctx.selectedPackageId) return null;
      const found = ctx.offering?.packages.find((p) => p.identifier === ctx.selectedPackageId);
      return found ? packageView(found.product, found.product.displayName, ctx.offering) : null;
    })();
  return resolveVariables(text, pkg);
}

const TEXT_ROLE_STYLE = {
  title: { fontSize: 24, fontWeight: "700" as const },
  subtitle: { fontSize: 18, fontWeight: "400" as const },
  body: { fontSize: 15, fontWeight: "400" as const },
  caption: { fontSize: 12, fontWeight: "400" as const },
};

function NodeView({
  node,
  ctx,
  cell,
}: {
  node: BuilderNode;
  ctx: Ctx;
  cell: CellScope | null;
}): ReactElement | null {
  // Every node passes through `applyOverrides` here, BEFORE any
  // style/text resolution happens below — `resolved` (not the original
  // `node`) is what gets dispatched. Mirrors nodes.tsx's `renderNode` /
  // the Swift/Kotlin siblings' `BuilderNodeView.body`.
  const active = activeOverrideConditions(cell?.packageId ?? null, ctx.selectedPackageId, ctx.offering);
  const resolved = applyOverrides(node, active);

  switch (resolved.type) {
    case "stack": {
      const align =
        resolved.align === "center" ? "center" : resolved.align === "end" ? "flex-end" : "flex-start";
      return (
        <View
          testID={`rov-node-${resolved.id}`}
          style={{
            flexDirection: resolved.axis === "h" ? "row" : "column",
            ...(resolved.axis === "z" ? { position: "relative" } : {}),
            gap: resolved.spacing,
            alignItems: align,
            paddingTop: resolved.padding?.t,
            paddingRight: resolved.padding?.r,
            paddingBottom: resolved.padding?.b,
            paddingLeft: resolved.padding?.l,
            ...(resolved.size?.width === "fill" ? { alignSelf: "stretch" } : {}),
            ...(typeof resolved.size?.width === "number" ? { width: resolved.size.width } : {}),
            ...(typeof resolved.size?.height === "number" ? { height: resolved.size.height } : {}),
            ...(resolved.background
              ? { backgroundColor: themeValue(resolved.background, ctx.dark) }
              : {}),
            ...(resolved.cornerRadius ? { borderRadius: resolved.cornerRadius } : {}),
          }}
        >
          {resolved.children.map((child, index) => (
            // Positional keys — never node.id (duplicate user-authored ids
            // reach clients unvalidated; React duplicate keys are UB).
            <NodeView key={index} node={child} ctx={ctx} cell={cell} />
          ))}
        </View>
      );
    }
    case "text":
      return (
        <Text
          testID={`rov-node-${resolved.id}`}
          style={{
            ...TEXT_ROLE_STYLE[resolved.role],
            ...(resolved.color ? { color: themeValue(resolved.color, ctx.dark) } : {}),
            textAlign:
              resolved.align === "center" ? "center" : resolved.align === "end" ? "right" : "left",
          }}
        >
          {label(ctx, resolved.key, cell)}
        </Text>
      );
    case "image":
      return (
        <Image
          testID={`rov-node-${resolved.id}`}
          source={{ uri: themeValue(resolved.url, ctx.dark) }}
          accessibilityLabel={resolved.alt ? label(ctx, resolved.alt, cell) : undefined}
          style={{
            ...(resolved.height ? { height: resolved.height } : {}),
            ...(resolved.cornerRadius ? { borderRadius: resolved.cornerRadius } : {}),
            alignSelf: "stretch",
          }}
        />
      );
    case "button": {
      if (resolved.action.kind === "restore" && !ctx.onRestore) {
        return resolved.fallback ? (
          <NodeView node={resolved.fallback} ctx={ctx} cell={cell} />
        ) : null;
      }
      const action = resolved.action;
      const onPress = () => {
        if (action.kind === "close") ctx.onClose?.();
        else if (action.kind === "restore") ctx.onRestore?.();
        else ctx.onUrl?.(action.url);
      };
      return (
        <Pressable testID={`rov-node-${resolved.id}`} onPress={onPress}>
          <Text
            style={{
              fontSize: 15,
              fontWeight: resolved.style === "primary" ? ("600" as const) : ("400" as const),
              opacity: resolved.style === "plain" ? 0.7 : 1,
            }}
          >
            {label(ctx, resolved.labelKey, cell)}
          </Text>
        </Pressable>
      );
    }
    case "packageList": {
      const ids = effectivePackageIds(resolved, ctx.offering);
      const cells = ids.flatMap((id) => {
        const pkg = ctx.offering?.packages.find((p) => p.identifier === id);
        return pkg ? [pkg] : [];
      });
      return (
        <View
          testID={`rov-node-${resolved.id}`}
          style={{ flexDirection: resolved.cellLayout === "row" ? "row" : "column", gap: 8 }}
        >
          {cells.map((pkg, index) => {
            const view = packageView(pkg.product, pkg.product.displayName, ctx.offering);
            const selected = ctx.selectedPackageId === pkg.identifier;
            const cellScope: CellScope = { packageId: pkg.identifier, view };
            return (
              <Pressable
                key={index}
                testID={`rov-cell-${pkg.identifier}`}
                accessibilityState={{ selected }}
                onPress={() => ctx.select(pkg.identifier)}
              >
                {resolved.cellTemplate ? (
                  // Render the template subtree once per package, INSIDE
                  // the same Pressable cell wrapper (testID/aria semantics
                  // unchanged) — the cell-scoped CellScope is what makes
                  // `{{price}}` etc. inside the template resolve to THIS
                  // cell's package rather than the globally selected one,
                  // and what makes a `selected`-condition override inside
                  // the template match only the currently-selected cell.
                  <NodeView node={resolved.cellTemplate} ctx={ctx} cell={cellScope} />
                ) : (
                  // No cellTemplate -> built-in cell (name + price),
                  // unchanged from before overrides/cellTemplate existed.
                  <View
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      borderWidth: selected ? 2 : 1,
                      borderColor: selected ? "#3B82F6" : "rgba(120,120,128,0.35)",
                    }}
                  >
                    <Text style={{ fontWeight: "600" as const }}>{view.packageName}</Text>
                    <Text style={{ fontSize: 12 }}>{view.pricePerPeriod}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      );
    }
    case "purchaseButton": {
      const enabled = ctx.selectedPackageId !== null && !ctx.isPurchasing;
      return (
        <Pressable
          testID={`rov-node-${resolved.id}`}
          disabled={!enabled}
          accessibilityState={{ disabled: !enabled }}
          onPress={ctx.startPurchase}
        >
          <View
            style={{
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderRadius: 12,
              backgroundColor: "#3B82F6",
              opacity: enabled ? 1 : 0.4,
              alignSelf: "stretch",
            }}
          >
            <Text style={{ color: "#FFFFFF", fontWeight: "600" as const, textAlign: "center" }}>
              {label(ctx, resolved.labelKey, null)}
            </Text>
          </View>
        </Pressable>
      );
    }
    case "spacer":
      return (
        <View
          testID={`rov-node-${resolved.id}`}
          style={resolved.size ? { width: resolved.size, height: resolved.size } : { flex: 1 }}
        />
      );
    case "unknown":
      return resolved.fallback ? (
        <NodeView node={resolved.fallback} ctx={ctx} cell={cell} />
      ) : null;
  }
}
