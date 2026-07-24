import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import type { NodeVisibility, PaywallNode, VisibilityPlatform } from "@rovenue/shared/paywall";
import { Checkbox } from "../../../ui/checkbox";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { Field, INPUT_CLASS, Section } from "./primitives";

// =============================================================
// Visibility — which platforms and app-version range a node
// renders on. Applies to every node type: every node can be
// hidden. Audience/segment targeting is deliberately NOT here —
// it stays at the placement level (gap analysis §8 decision 3).
// =============================================================

const ALL_PLATFORMS: VisibilityPlatform[] = ["ios", "android", "web"];

/** Collapse an all-defaults visibility back to `undefined`, so a node the
 * author has reset is indistinguishable from one never touched — otherwise
 * the diff, the fixtures and the wire all carry a meaningless `{}`. */
export function normalize(v: NodeVisibility): NodeVisibility | undefined {
  const platform = v.platform && v.platform.length > 0 ? v.platform : undefined;
  const min = v.minAppVersion?.trim() || undefined;
  const max = v.maxAppVersion?.trim() || undefined;
  if (!platform && !min && !max) return undefined;
  return { ...(platform && { platform }), ...(min && { minAppVersion: min }), ...(max && { maxAppVersion: max }) };
}

/**
 * The platform list after ticking or unticking one box. Absent/empty
 * already means "all", so the FIRST untick has to produce the list of the
 * others — writing `[]` would normalize straight back to `undefined` and
 * the box would spring back ticked.
 */
export function togglePlatformList(
  current: VisibilityPlatform[] | undefined,
  p: VisibilityPlatform,
): VisibilityPlatform[] {
  const selected = current && current.length > 0 ? current : ALL_PLATFORMS;
  return selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p];
}

export const VisibilityTab = component(({ node }: { node: PaywallNode }) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PaywallNode>) => vm.updateNode<PaywallNode>(node.id, patch);

  const current = node.visibility ?? {};

  const togglePlatform = (p: VisibilityPlatform) => {
    // Absent/empty already means "all", so the first untick has to produce the
    // list of the OTHERS, not an empty array — otherwise unticking one box
    // would read as no constraint and the node would stay everywhere.
    set({ visibility: normalize({ ...current, platform: togglePlatformList(current.platform, p) }) });
  };

  const setBound = (key: "minAppVersion" | "maxAppVersion", value: string) =>
    set({ visibility: normalize({ ...current, [key]: value }) });

  const isChecked = (p: VisibilityPlatform) => !current.platform?.length || current.platform.includes(p);

  return (
    <Section title={t("paywalls.builder.properties.visibility", "Visibility")} defaultOpen>
      <div className="flex flex-col gap-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
          <Checkbox
            checked={isChecked("ios")}
            onChange={() => togglePlatform("ios")}
            ariaLabel={t("paywalls.builder.properties.visibilityIos", "iOS")}
          />
          {t("paywalls.builder.properties.visibilityIos", "iOS")}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
          <Checkbox
            checked={isChecked("android")}
            onChange={() => togglePlatform("android")}
            ariaLabel={t("paywalls.builder.properties.visibilityAndroid", "Android")}
          />
          {t("paywalls.builder.properties.visibilityAndroid", "Android")}
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
          <Checkbox
            checked={isChecked("web")}
            onChange={() => togglePlatform("web")}
            ariaLabel={t("paywalls.builder.properties.visibilityWeb", "Web")}
          />
          {t("paywalls.builder.properties.visibilityWeb", "Web")}
        </label>
      </div>
      <Field className="mt-3" label={t("paywalls.builder.properties.visibilityMinVersion", "Min app version")}>
        <input
          value={current.minAppVersion ?? ""}
          onChange={(e) => setBound("minAppVersion", e.currentTarget.value)}
          placeholder="1.0.0"
          className={INPUT_CLASS}
        />
      </Field>
      <Field className="mt-3" label={t("paywalls.builder.properties.visibilityMaxVersion", "Max app version")}>
        <input
          value={current.maxAppVersion ?? ""}
          onChange={(e) => setBound("maxAppVersion", e.currentTarget.value)}
          placeholder="2.0.0"
          className={INPUT_CLASS}
        />
      </Field>
      <div className="mt-3 text-[11px] text-rv-mute-500">
        {t(
          "paywalls.builder.properties.visibilityHint",
          "Leave everything unset to show this node on every platform and version.",
        )}
      </div>
      <div className="mt-2 text-[11px] text-rv-mute-500">
        {t(
          "paywalls.builder.properties.visibilityAudienceHint",
          "Audience/segment targeting is not set here — it lives on the placement's audience rows.",
        )}
      </div>
    </Section>
  );
});
