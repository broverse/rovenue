import { tool } from "ai";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { emptyBuilderConfig, type BuilderConfig, type PaywallNode } from "@rovenue/shared/paywall";
import { sterilizeToolResult } from "../sterilize";
import type { ToolContext } from "./query-subscribers";

// =============================================================
// query_paywall_tree (P8 AI-FAB, §6.15)
// =============================================================
//
// Returns a COMPACT structural summary of a paywall's builder-config
// tree — never the raw config JSON. The full config can run to
// hundreds of nodes with deeply nested style/visibility/override
// props the model doesn't need to reason about an edit, and every
// extra token here is billed against the project's Rovi quota. The
// model gets exactly what it needs to target an `action_paywall_editTree`
// op: each node's id/type/parent, plus its already-resolved
// default-locale strings (so it can read copy without a second round
// trip through `localizations`).

const GetArgs = z.object({ paywallId: z.string().min(1) });

interface PaywallNodeSummary {
  id: string;
  type: string;
  parentId: string | null;
  /** This node's own copy, resolved against `config.defaultLocale`. */
  strings: string[];
}

/**
 * Node fields that hold child PaywallNode subtrees rather than the node's
 * own props — walked separately by `walkNodes`, never scanned for string
 * props (that would re-list a child's own copy under its ancestor).
 */
const SUBTREE_FIELDS = new Set(["children", "fallback", "cellTemplate"]);

/** A prop name that references a `localizations[locale]` key: `key` on
 *  `TextNode`, or any `*Key` field (`labelKey`, `captionKey`, `trialLabelKey`, …). */
function isLocaleKeyProp(propName: string): boolean {
  return propName === "key" || propName.endsWith("Key");
}

function resolveLocaleKeyProps(
  obj: Record<string, unknown>,
  locale: Record<string, string>,
  out: string[],
): void {
  for (const [propName, value] of Object.entries(obj)) {
    if (typeof value === "string" && isLocaleKeyProp(propName)) {
      const resolved = locale[value];
      if (resolved !== undefined) out.push(resolved);
    }
  }
}

/**
 * A node's own copy: its top-level `*Key`/`key` props, plus one level into
 * plain-object array fields (`FeatureRow[]`, `TimelineRow[]`) — those carry
 * their own `labelKey`/`captionKey` but aren't PaywallNode subtrees, so
 * `walkNodes` never visits them on its own.
 */
function resolveOwnStrings(node: Record<string, unknown>, locale: Record<string, string>): string[] {
  const out: string[] = [];
  resolveLocaleKeyProps(node, locale, out);
  for (const [propName, value] of Object.entries(node)) {
    if (SUBTREE_FIELDS.has(propName) || !Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        resolveLocaleKeyProps(item as Record<string, unknown>, locale, out);
      }
    }
  }
  return out;
}

function walkNodes(
  node: PaywallNode,
  parentId: string | null,
  locale: Record<string, string>,
  out: PaywallNodeSummary[],
): void {
  const raw = node as unknown as Record<string, unknown>;
  out.push({
    id: node.id,
    type: node.type,
    parentId,
    strings: resolveOwnStrings(raw, locale),
  });
  if (Array.isArray(raw.children)) {
    for (const child of raw.children as PaywallNode[]) walkNodes(child, node.id, locale, out);
  }
  if (raw.cellTemplate) walkNodes(raw.cellTemplate as PaywallNode, node.id, locale, out);
  if (raw.fallback) walkNodes(raw.fallback as PaywallNode, node.id, locale, out);
}

/**
 * The paywall's current draft config. `builderConfig` is null until the
 * builder is opened for the first time (Phase A paywalls, or a paywall
 * created before the builder existed) — mirrors the dashboard VM's own
 * `detail.builderConfig ?? emptyBuilderConfig(detail.defaultLocale)`
 * fallback (`paywall-builder.vm.ts`), sourcing the locale from
 * `remoteConfig.defaultLocale` since paywalls has no dedicated column.
 */
export function resolvePaywallDraftConfig(paywall: {
  builderConfig: unknown;
  remoteConfig: unknown;
}): BuilderConfig {
  if (paywall.builderConfig) return paywall.builderConfig as BuilderConfig;
  const defaultLocale =
    (paywall.remoteConfig as { defaultLocale?: string } | null)?.defaultLocale ?? "en";
  return emptyBuilderConfig(defaultLocale);
}

export function queryPaywallTools(ctx: ToolContext) {
  return {
    "query_paywall_tree": tool({
      description:
        "Get a compact structural summary of a paywall's builder-config tree: every node's id, type, parent id, and its default-locale copy. Never returns the raw config JSON. Use this before proposing an action_paywall_editTree op so node ids/kinds are correct.",
      inputSchema: GetArgs,
      execute: async ({ paywallId }) => {
        const paywall = await drizzle.paywallRepo.findPaywallById(
          drizzle.db,
          ctx.projectId,
          paywallId,
        );
        if (!paywall) return sterilizeToolResult(null);

        const config = resolvePaywallDraftConfig(paywall);
        const locale = config.localizations[config.defaultLocale] ?? {};
        const nodes: PaywallNodeSummary[] = [];
        walkNodes(config.root, null, locale, nodes);

        return sterilizeToolResult({
          paywallId,
          defaultLocale: config.defaultLocale,
          nodes,
        });
      },
    }),
  };
}
