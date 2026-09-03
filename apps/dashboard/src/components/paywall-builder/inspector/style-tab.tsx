import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import type {
  ButtonNode,
  CarouselNode,
  CountdownNode,
  DividerNode,
  FeatureListNode,
  FooterLinksNode,
  IconNode,
  ImageNode,
  PaywallNode,
  PurchaseButtonNode,
  SocialProofNode,
  StackNode,
  StickyFooterNode,
  TextNode,
  TimelineNode,
} from "@rovenue/shared/paywall";
import { FOOTER_LINKS_DEFAULT_ALIGN, FOOTER_LINKS_DEFAULT_SEPARATOR } from "@rovenue/shared/paywall";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { AlignField, BorderField, NumberField, ThemeColorField } from "./fields";
import { Field, Section, Segmented } from "./primitives";

// =============================================================
// Style — how a node looks. `align` is here for text (it aligns
// glyphs); a stack's `align` is on Layout, where it aligns children.
//
// Wave D2 — `video`/`lottie` deliberately have no case here and no Style
// entry in `inspector/tabs.ts`'s `appliesTo`: neither node type has a
// style-only field (their one colour-ish knob, `posterUrl`, is content,
// not appearance). Adding a Style tab without a case here would be the
// wave-B defect in the other direction — an empty tab shipping instead of
// no tab at all. `packageList` and `spacer` are absent for the same
// reason: neither has an appearance-only field of its own.
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
    case "purchaseButton":
      return <PurchaseButtonStyle node={node} />;
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
    case "stickyFooter":
      return <StickyFooterStyle node={node} />;
    case "countdown":
      return <CountdownStyle node={node} />;
    case "carousel":
      return <CarouselStyle node={node} />;
    case "footerLinks":
      return <FooterLinksStyle node={node} />;
    // See the module doc comment above for why these four have no Style
    // case: video/lottie have no style-only field; packageList/spacer have
    // none either.
    case "packageList":
    case "spacer":
    case "video":
    case "lottie":
      return null;
    default: {
      // A new node type with no decision recorded above fails the build
      // here instead of silently rendering an empty inspector.
      const exhaustive: never = node;
      void exhaustive;
      return null;
    }
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
      <BorderField
        className="mt-3"
        label={t("paywalls.builder.properties.border", "Border")}
        value={node.border}
        onChange={(v) => set({ border: v })}
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
      <ThemeColorField
        className="mt-3"
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
      <BorderField
        className="mt-3"
        label={t("paywalls.builder.properties.border", "Border")}
        value={node.border}
        onChange={(v) => set({ border: v })}
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
      <Field label={t("paywalls.builder.properties.buttonStyle", "Variant")}>
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
      <ThemeColorField
        className="mt-3"
        label={t("paywalls.builder.properties.background", "Background")}
        value={node.background}
        onChange={(v) => set({ background: v })}
      />
      <ThemeColorField
        className="mt-3"
        label={t("paywalls.builder.properties.labelColor", "Label color")}
        value={node.labelColor}
        onChange={(v) => set({ labelColor: v })}
      />
      <BorderField
        className="mt-3"
        label={t("paywalls.builder.properties.border", "Border")}
        value={node.border}
        onChange={(v) => set({ border: v })}
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

function PurchaseButtonStyle({ node }: { node: PurchaseButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PurchaseButtonNode>) => vm.updateNode<PurchaseButtonNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.background", "Background")}
        value={node.background}
        onChange={(v) => set({ background: v })}
      />
      <ThemeColorField
        className="mt-3"
        label={t("paywalls.builder.properties.labelColor", "Label color")}
        value={node.labelColor}
        onChange={(v) => set({ labelColor: v })}
      />
      <BorderField
        className="mt-3"
        label={t("paywalls.builder.properties.border", "Border")}
        value={node.border}
        onChange={(v) => set({ border: v })}
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

function StickyFooterStyle({ node }: { node: StickyFooterNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<StickyFooterNode>) => vm.updateNode<StickyFooterNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.background", "Background")}
        value={node.background}
        onChange={(v) => set({ background: v })}
      />
    </Section>
  );
}

function CountdownStyle({ node }: { node: CountdownNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<CountdownNode>) => vm.updateNode<CountdownNode>(node.id, patch);

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

/** Absent `indicatorColor` means inherit the ambient text colour — leaving
 *  the field empty must produce no colour instruction, not a substituted
 *  value, so this passes `node.indicatorColor` straight through undefined. */
function CarouselStyle({ node }: { node: CarouselNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<CarouselNode>) => vm.updateNode<CarouselNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.appearance", "Appearance")} defaultOpen>
      <ThemeColorField
        label={t("paywalls.builder.properties.carouselIndicatorColor", "Indicator color")}
        value={node.indicatorColor}
        onChange={(v) => set({ indicatorColor: v })}
      />
    </Section>
  );
}

/**
 * `separator`/`align` are rendered with their own `Field` + `Segmented`
 * pair (rather than reusing `AlignField`) because their unset defaults are
 * `FOOTER_LINKS_DEFAULT_SEPARATOR`/`FOOTER_LINKS_DEFAULT_ALIGN` — "center",
 * not `AlignField`'s own hard-coded "start" default, and this field's label
 * ("Alignment") is deliberately more specific than `AlignField`'s generic
 * "Align" (this aligns the whole row, not text glyphs).
 */
function FooterLinksStyle({ node }: { node: FooterLinksNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<FooterLinksNode>) => vm.updateNode<FooterLinksNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.style", "Style")} defaultOpen>
      <Field label={t("paywalls.builder.properties.footerLinksSeparator", "Separator")}>
        <Segmented
          value={node.separator ?? FOOTER_LINKS_DEFAULT_SEPARATOR}
          onChange={(v) => set({ separator: v })}
          options={[
            { value: "dot", label: t("paywalls.builder.properties.footerLinksSeparatorDot", "Dot") },
            { value: "pipe", label: t("paywalls.builder.properties.footerLinksSeparatorPipe", "Pipe") },
            { value: "none", label: t("paywalls.builder.properties.footerLinksSeparatorNone", "None") },
          ]}
        />
      </Field>
      <Field className="mt-3" label={t("paywalls.builder.properties.footerLinksAlign", "Alignment")}>
        <Segmented
          value={node.align ?? FOOTER_LINKS_DEFAULT_ALIGN}
          onChange={(v) => set({ align: v })}
          options={[
            { value: "start", label: t("paywalls.builder.properties.alignStart", "Start") },
            { value: "center", label: t("paywalls.builder.properties.alignCenter", "Center") },
            { value: "end", label: t("paywalls.builder.properties.alignEnd", "End") },
          ]}
        />
      </Field>
      <ThemeColorField
        className="mt-3"
        label={t("paywalls.builder.properties.footerLinksColor", "Link color")}
        value={node.color}
        onChange={(v) => set({ color: v })}
      />
    </Section>
  );
}
