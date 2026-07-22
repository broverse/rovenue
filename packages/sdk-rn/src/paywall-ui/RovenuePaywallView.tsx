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
// =============================================================

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { logPaywallShown } from "../api/paywalls";
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
    onClose: props.onClose,
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
      <NodeView node={config.root} ctx={ctx} cellPackage={null} />
    </View>
  );
}

// -------------------------------------------------------------
// Node rendering
// -------------------------------------------------------------

function label(ctx: Ctx, key: string, cellPackage: PackageView | null): string {
  const text = resolveText(ctx.config, ctx.locale, key) ?? "";
  const pkg =
    cellPackage ??
    (() => {
      if (!ctx.selectedPackageId) return null;
      const found = ctx.offering?.packages.find((p) => p.identifier === ctx.selectedPackageId);
      return found ? packageView(found.product, found.product.displayName) : null;
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
  cellPackage,
}: {
  node: BuilderNode;
  ctx: Ctx;
  cellPackage: PackageView | null;
}): ReactElement | null {
  switch (node.type) {
    case "stack": {
      const align =
        node.align === "center" ? "center" : node.align === "end" ? "flex-end" : "flex-start";
      return (
        <View
          testID={`rov-node-${node.id}`}
          style={{
            flexDirection: node.axis === "h" ? "row" : "column",
            ...(node.axis === "z" ? { position: "relative" } : {}),
            gap: node.spacing,
            alignItems: align,
            paddingTop: node.padding?.t,
            paddingRight: node.padding?.r,
            paddingBottom: node.padding?.b,
            paddingLeft: node.padding?.l,
            ...(node.size?.width === "fill" ? { alignSelf: "stretch" } : {}),
            ...(typeof node.size?.width === "number" ? { width: node.size.width } : {}),
            ...(typeof node.size?.height === "number" ? { height: node.size.height } : {}),
            ...(node.background
              ? { backgroundColor: themeValue(node.background, ctx.dark) }
              : {}),
            ...(node.cornerRadius ? { borderRadius: node.cornerRadius } : {}),
          }}
        >
          {node.children.map((child, index) => (
            // Positional keys — never node.id (duplicate user-authored ids
            // reach clients unvalidated; React duplicate keys are UB).
            <NodeView key={index} node={child} ctx={ctx} cellPackage={cellPackage} />
          ))}
        </View>
      );
    }
    case "text":
      return (
        <Text
          testID={`rov-node-${node.id}`}
          style={{
            ...TEXT_ROLE_STYLE[node.role],
            ...(node.color ? { color: themeValue(node.color, ctx.dark) } : {}),
            textAlign:
              node.align === "center" ? "center" : node.align === "end" ? "right" : "left",
          }}
        >
          {label(ctx, node.key, cellPackage)}
        </Text>
      );
    case "image":
      return (
        <Image
          testID={`rov-node-${node.id}`}
          source={{ uri: themeValue(node.url, ctx.dark) }}
          accessibilityLabel={node.alt ? label(ctx, node.alt, cellPackage) : undefined}
          style={{
            ...(node.height ? { height: node.height } : {}),
            ...(node.cornerRadius ? { borderRadius: node.cornerRadius } : {}),
            alignSelf: "stretch",
          }}
        />
      );
    case "button": {
      if (node.action.kind === "restore" && !ctx.onRestore) {
        return node.fallback ? (
          <NodeView node={node.fallback} ctx={ctx} cellPackage={cellPackage} />
        ) : null;
      }
      const action = node.action;
      const onPress = () => {
        if (action.kind === "close") ctx.onClose?.();
        else if (action.kind === "restore") ctx.onRestore?.();
        else ctx.onUrl?.(action.url);
      };
      return (
        <Pressable testID={`rov-node-${node.id}`} onPress={onPress}>
          <Text
            style={{
              fontSize: 15,
              fontWeight: node.style === "primary" ? ("600" as const) : ("400" as const),
              opacity: node.style === "plain" ? 0.7 : 1,
            }}
          >
            {label(ctx, node.labelKey, cellPackage)}
          </Text>
        </Pressable>
      );
    }
    case "packageList": {
      const ids = effectivePackageIds(node, ctx.offering);
      const cells = ids.flatMap((id) => {
        const pkg = ctx.offering?.packages.find((p) => p.identifier === id);
        return pkg ? [pkg] : [];
      });
      return (
        <View
          testID={`rov-node-${node.id}`}
          style={{ flexDirection: node.cellLayout === "row" ? "row" : "column", gap: 8 }}
        >
          {cells.map((pkg, index) => {
            const view = packageView(pkg.product, pkg.product.displayName);
            const selected = ctx.selectedPackageId === pkg.identifier;
            return (
              <Pressable
                key={index}
                testID={`rov-cell-${pkg.identifier}`}
                accessibilityState={{ selected }}
                onPress={() => ctx.select(pkg.identifier)}
              >
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
          testID={`rov-node-${node.id}`}
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
              {label(ctx, node.labelKey, null)}
            </Text>
          </View>
        </Pressable>
      );
    }
    case "spacer":
      return (
        <View
          testID={`rov-node-${node.id}`}
          style={node.size ? { width: node.size, height: node.size } : { flex: 1 }}
        />
      );
    case "unknown":
      return node.fallback ? (
        <NodeView node={node.fallback} ctx={ctx} cellPackage={cellPackage} />
      ) : null;
  }
}
