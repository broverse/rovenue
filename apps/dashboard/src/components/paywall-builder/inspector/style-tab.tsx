import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import type {
  ButtonNode,
  DividerNode,
  FeatureListNode,
  IconNode,
  ImageNode,
  PaywallNode,
  SocialProofNode,
  StackNode,
  TextNode,
  TimelineNode,
} from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { AlignField, NumberField, ThemeColorField } from "./fields";
import { Field, Section, Segmented } from "./primitives";

// =============================================================
// Style — how a node looks. `align` is here for text (it aligns
// glyphs); a stack's `align` is on Layout, where it aligns children.
// =============================================================

export const StyleTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "stack":
      return <StackStyle node={node} />;
    case "text":
      return <TextStyle node={node} />;
    case "image":
      return <ImageStyle node={node} />;
    case "button":
      return <ButtonStyle node={node} />;
    case "divider":
      return <DividerStyle node={node} />;
    case "icon":
      return <IconStyle node={node} />;
    case "featureList":
      return <FeatureListStyle node={node} />;
    case "timeline":
      return <TimelineStyle node={node} />;
    case "socialProof":
      return <SocialProofStyle node={node} />;
    default:
      return null;
  }
});

function StackStyle({ node }: { node: StackNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<StackNode>) => vm.updateNode<StackNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.background", "Background")}
        value={node.background}
        onChange={(v) => set({ background: v })}
      />
      <NumberField
        className="mt-3"
        label={t("paywalls.builder.properties.cornerRadius", "Corner radius")}
        value={node.cornerRadius}
        onChange={(v) => set({ cornerRadius: v })}
      />
    </Section>
  );
}

function TextStyle({ node }: { node: TextNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<TextNode>) => vm.updateNode<TextNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
      <Field label={t("paywalls.builder.properties.role", "Role")}>
        <Segmented
          value={node.role}
          onChange={(v) => set({ role: v })}
          options={[
            { value: "title", label: t("paywalls.builder.properties.roleTitle", "Title") },
            { value: "subtitle", label: t("paywalls.builder.properties.roleSubtitle", "Subtitle") },
            { value: "body", label: t("paywalls.builder.properties.roleBody", "Body") },
            { value: "caption", label: t("paywalls.builder.properties.roleCaption", "Caption") },
          ]}
        />
      </Field>
      <AlignField className="mt-3" value={node.align} onChange={(v) => set({ align: v })} />
      <ThemeColorField
        className="mt-3"
        label={t("paywalls.builder.properties.color", "Color")}
        value={node.color}
        onChange={(v) => set({ color: v })}
      />
    </Section>
  );
}

function ImageStyle({ node }: { node: ImageNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ImageNode>) => vm.updateNode<ImageNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <NumberField
        label={t("paywalls.builder.properties.cornerRadius", "Corner radius")}
        value={node.cornerRadius}
        onChange={(v) => set({ cornerRadius: v })}
      />
    </Section>
  );
}

function ButtonStyle({ node }: { node: ButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ButtonNode>) => vm.updateNode<ButtonNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
      <Field label={t("paywalls.builder.properties.buttonStyle", "Style")}>
        <Segmented
          value={node.style}
          onChange={(v) => set({ style: v })}
          options={[
            { value: "primary", label: t("paywalls.builder.properties.buttonStylePrimary", "Primary") },
            { value: "secondary", label: t("paywalls.builder.properties.buttonStyleSecondary", "Secondary") },
            { value: "plain", label: t("paywalls.builder.properties.buttonStylePlain", "Plain") },
          ]}
        />
      </Field>
    </Section>
  );
}

function DividerStyle({ node }: { node: DividerNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<DividerNode>) => vm.updateNode<DividerNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.color", "Color")}
        value={node.color}
        onChange={(v) => set({ color: v })}
      />
    </Section>
  );
}

function IconStyle({ node }: { node: IconNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<IconNode>) => vm.updateNode<IconNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.color", "Color")}
        value={node.color}
        onChange={(v) => set({ color: v })}
      />
    </Section>
  );
}

function FeatureListStyle({ node }: { node: FeatureListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<FeatureListNode>) => vm.updateNode<FeatureListNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.featureListIconColor", "Icon color")}
        value={node.iconColor}
        onChange={(v) => set({ iconColor: v })}
      />
    </Section>
  );
}

function TimelineStyle({ node }: { node: TimelineNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<TimelineNode>) => vm.updateNode<TimelineNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.timelineConnectorColor", "Connector color")}
        value={node.connectorColor}
        onChange={(v) => set({ connectorColor: v })}
      />
    </Section>
  );
}

function SocialProofStyle({ node }: { node: SocialProofNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<SocialProofNode>) => vm.updateNode<SocialProofNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.socialProofStarColor", "Star color")}
        value={node.starColor}
        onChange={(v) => set({ starColor: v })}
      />
    </Section>
  );
}
