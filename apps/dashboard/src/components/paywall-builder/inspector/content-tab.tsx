import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import {
  ICON_NAMES,
  type ButtonNode,
  type DividerNode,
  type IconNode,
  type ImageNode,
  type PaywallNode,
  type PurchaseButtonNode,
  type TextNode,
} from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { LocalizedTextField, NumberField, SelectField } from "./fields";
import { Field, INPUT_CLASS, Section } from "./primitives";

// =============================================================
// Content — what the node actually shows. Localized strings live
// here, which is why the Content tab carries the UNKNOWN_LOC_KEY and
// EMPTY_LOC_VALUE dots.
// =============================================================

export const ContentTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "text":
      return <TextContent node={node} />;
    case "image":
      return <ImageContent node={node} />;
    case "button":
      return <ButtonContent node={node} />;
    case "purchaseButton":
      return <PurchaseButtonContent node={node} />;
    case "divider":
      return <DividerContent node={node} />;
    case "icon":
      return <IconContent node={node} />;
    default:
      return null;
  }
});

function TextContent({ node }: { node: TextNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.text", "Text")} locKey={node.key} />
    </Section>
  );
}

function ImageContent({ node }: { node: ImageNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ImageNode>) => vm.updateNode<ImageNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.image", "Image")} defaultOpen>
      <Field label={t("paywalls.builder.properties.urlLight", "URL (light)")}>
        <input
          value={node.url.light}
          onChange={(e) => set({ url: { ...node.url, light: e.currentTarget.value } })}
          placeholder="https://cdn.example.com/photo.png"
          className={INPUT_CLASS}
        />
      </Field>
      <Field className="mt-3" label={t("paywalls.builder.properties.urlDark", "URL (dark)")}>
        <input
          value={node.url.dark ?? ""}
          onChange={(e) => set({ url: { ...node.url, dark: e.currentTarget.value || undefined } })}
          placeholder="https://cdn.example.com/photo-dark.png"
          className={INPUT_CLASS}
        />
      </Field>
      <Field className="mt-3" label={t("paywalls.builder.properties.alt", "Alt text")}>
        <input
          value={node.alt ?? ""}
          onChange={(e) => set({ alt: e.currentTarget.value || undefined })}
          className={INPUT_CLASS}
        />
      </Field>
    </Section>
  );
}

function ButtonContent({ node }: { node: ButtonNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
    </Section>
  );
}

function PurchaseButtonContent({ node }: { node: PurchaseButtonNode }) {
  const { t } = useTranslation();
  return (
    <Section title={t("paywalls.builder.properties.content", "Content")} defaultOpen>
      <LocalizedTextField label={t("paywalls.builder.properties.label", "Label")} locKey={node.labelKey} />
    </Section>
  );
}

function DividerContent({ node }: { node: DividerNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<DividerNode>) => vm.updateNode<DividerNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.divider", "Divider")} defaultOpen>
      <NumberField
        label={t("paywalls.builder.properties.thickness", "Thickness")}
        value={node.thickness}
        onChange={(v) => set({ thickness: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.inset", "Inset")}
        value={node.inset}
        onChange={(v) => set({ inset: v })}
      />
    </Section>
  );
}

function IconContent({ node }: { node: IconNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<IconNode>) => vm.updateNode<IconNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.icon", "Icon")} defaultOpen>
      <SelectField
        label={t("paywalls.builder.properties.iconName", "Icon")}
        value={node.name}
        options={ICON_NAMES}
        onChange={(v) => set({ name: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.size", "Size")}
        value={node.size}
        onChange={(v) => set({ size: v })}
      />
    </Section>
  );
}
