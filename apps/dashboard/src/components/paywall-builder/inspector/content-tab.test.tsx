import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { component, ServiceProvider, useService } from "impair";
import "../../../i18n/config";
import { ContentTab } from "./content-tab";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { findNode } from "../tree-ops";
import { emptyBuilderConfig, type BuilderConfig, type FooterLinksNode } from "@rovenue/shared/paywall";

// =============================================================
// ContentTab — footerLinks. The schema requires `links.min(1)`
// (schema.ts's `footerLinksNodeSchema`), but nothing in the builder
// enforced that floor: an author could delete the seeded link (or the
// last remaining one) straight down to `links: []`, an invalid config
// that `updateNode` commits with no schema check and no in-builder
// signal — the author only found out at save/publish. This pins that the
// Content editor's remove control refuses to go below one link.
// =============================================================

function fakeConfig(): BuilderConfig {
  const config = emptyBuilderConfig("en");
  config.root.children.push({
    type: "footerLinks",
    id: "fl1",
    links: [{ labelKey: "k_fl_1", action: { kind: "restore" } }],
  } as FooterLinksNode);
  config.root.children.push({
    type: "footerLinks",
    id: "fl2",
    links: [
      { labelKey: "k_fl2_1", action: { kind: "restore" } },
      { labelKey: "k_fl2_2", action: { kind: "close" } },
    ],
  } as FooterLinksNode);
  return config;
}

function fakeDetail(): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main paywall",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    draftRevision: 0,
    builderConfig: fakeConfig(),
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

/** Looks up the live node by id on every render, so it tracks `vm.config` edits. */
const Harness = component(({ id }: { id: string }) => {
  const vm = useService(PaywallBuilderViewModel);
  const node = findNode(vm.config.root, id);
  if (!node) return null;
  return <ContentTab node={node} />;
});

/** Mounts ContentTab inside real DI, loaded from a fake config, and hands back the live VM. */
async function renderHarness(id: string) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(fakeDetail());

  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }

  const utils = render(
    <ServiceProvider
      provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
      props={{ projectId: "p_1", paywallId: "pw_1" }}
    >
      <Probe />
      <Harness id={id} />
    </ServiceProvider>,
  );

  await act(async () => {
    await vm.load(() => {});
  });

  return { vm, ...utils };
}

describe("ContentTab — footerLinks link-list floor", () => {
  it("disables remove on the sole remaining link, and clicking it leaves links untouched", async () => {
    const { vm } = await renderHarness("fl1");
    const removeButton = screen.getByRole("button", { name: /remove/i });
    expect(removeButton).toBeDisabled();

    fireEvent.click(removeButton);

    const node = findNode(vm.config.root, "fl1") as FooterLinksNode;
    expect(node.links).toHaveLength(1);
  });

  it("still allows removing a link when more than one remains", async () => {
    const { vm } = await renderHarness("fl2");
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    expect(removeButtons[0]).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(removeButtons[0]!);
    });

    const node = findNode(vm.config.root, "fl2") as FooterLinksNode;
    expect(node.links).toHaveLength(1);
  });
});
