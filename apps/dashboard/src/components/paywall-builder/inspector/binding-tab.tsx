import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import type { ButtonNode, PackageListNode, PaywallNode } from "@rovenue/shared/paywall";
import { Checkbox } from "../../../ui/checkbox";
import { NativeSelect } from "../../../ui/native-select";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { Field, INPUT_CLASS, Section, Segmented } from "./primitives";

// =============================================================
// Binding — which commerce data, or which behaviour, a node points
// at. Deliberately narrow: how the package list DRAWS its cells is
// Layout's business, not this tab's.
// =============================================================

export const BindingTab = component(({ node }: { node: PaywallNode }) => {
  switch (node.type) {
    case "button":
      return <ButtonBinding node={node} />;
    case "packageList":
      return <PackageListBinding node={node} />;
    default:
      return null;
  }
});

function ButtonBinding({ node }: { node: ButtonNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<ButtonNode>) => vm.updateNode<ButtonNode>(node.id, patch);

  return (
    <Section title={t("paywalls.builder.properties.action", "Action")} defaultOpen>
      <Field label={t("paywalls.builder.properties.actionKind", "On tap")}>
        <Segmented
          value={node.action.kind}
          onChange={(kind) =>
            set({
              action:
                kind === "url"
                  ? { kind, url: node.action.kind === "url" ? node.action.url : "" }
                  : { kind },
            })
          }
          options={[
            { value: "close", label: t("paywalls.builder.properties.actionClose", "Close") },
            { value: "url", label: t("paywalls.builder.properties.actionUrl", "Open URL") },
            { value: "restore", label: t("paywalls.builder.properties.actionRestore", "Restore") },
          ]}
        />
      </Field>
      {node.action.kind === "url" && (
        <Field className="mt-3" label={t("paywalls.builder.properties.url", "URL")}>
          <input
            value={node.action.url}
            onChange={(e) => set({ action: { kind: "url", url: e.currentTarget.value } })}
            placeholder="https://example.com/terms"
            className={INPUT_CLASS}
          />
        </Field>
      )}
    </Section>
  );
}

function PackageListBinding({ node }: { node: PackageListNode }) {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const set = (patch: Partial<PackageListNode>) => vm.updateNode<PackageListNode>(node.id, patch);
  const offeringPackageIds = vm.paywall?.offeringPackageIds ?? [];

  const toggle = (id: string) => {
    const has = node.packageIds.includes(id);
    const packageIds = has ? node.packageIds.filter((p) => p !== id) : [...node.packageIds, id];
    const defaultSelected =
      node.defaultSelected && !packageIds.includes(node.defaultSelected) ? undefined : node.defaultSelected;
    set({ packageIds, defaultSelected });
  };

  return (
    <>
      <Section title={t("paywalls.builder.properties.packages", "Packages")} defaultOpen>
        <div className="mb-2 text-[11px] text-rv-mute-500">
          {t(
            "paywalls.builder.properties.packagesHint",
            "Leave all unchecked to show every package in the offering.",
          )}
        </div>
        {offeringPackageIds.length === 0 && (
          <div className="text-[11px] text-rv-mute-500">
            {t("paywalls.builder.properties.packagesEmpty", "This offering has no packages yet.")}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {offeringPackageIds.map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
              <Checkbox checked={node.packageIds.includes(id)} onChange={() => toggle(id)} ariaLabel={id} />
              <span className="font-rv-mono text-[11px]">{id}</span>
            </label>
          ))}
        </div>
      </Section>
      <Section title={t("paywalls.builder.properties.selection", "Selection")}>
        <Field label={t("paywalls.builder.properties.defaultSelected", "Default selected")}>
          <NativeSelect
            value={node.defaultSelected ?? ""}
            onChange={(e) => set({ defaultSelected: e.currentTarget.value || undefined })}
          >
            <option value="">
              {t("paywalls.builder.properties.defaultSelectedNone", "First available")}
            </option>
            {(node.packageIds.length ? node.packageIds : offeringPackageIds).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </Section>
    </>
  );
}
