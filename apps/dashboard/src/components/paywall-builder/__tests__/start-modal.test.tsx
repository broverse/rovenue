import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import "../../../i18n/config";

// =============================================================
// StartModal tabs (P8 Task 6): Presets (pre-existing grid, byte-
// preserved) | From App Store | AI assist. Both new tabs apply
// through vm.applyExternalConfig under the same two-click data-loss
// confirm the presets use. rpc is mocked at the transport layer.
// =============================================================

const appStorePost = vi.hoisted(() => vi.fn());
const generatePost = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    rpc: {
      dashboard: {
        projects: {
          ":projectId": {
            paywalls: {
              "from-app-store": { $post: (...a: unknown[]) => appStorePost(...a) },
              ":id": { "paywall-generate": { $post: (...a: unknown[]) => generatePost(...a) } },
            },
          },
        },
      },
    },
    unwrap: async (p: Promise<Response> | Response) => {
      const res = await p;
      const body = (await res.json()) as { data?: unknown; error?: { code: string; message: string } };
      if (!res.ok) throw new actual.ApiError(body.error?.code ?? "HTTP_ERROR", body.error?.message ?? "", res.status);
      return body.data;
    },
  };
});

// RoviMissingConfig renders a tanstack-router <Link>, which needs a live
// router — stub it so this suite only pins the WIRING (the 412 branch
// swaps the form for the affordance), not the component's internals.
vi.mock("../../rovi/rovi-missing-config", () => ({
  RoviMissingConfig: () => <div>Rovi needs an API key</div>,
}));

import { StartModal } from "../start-modal";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { emptyBuilderConfig, type BuilderConfig } from "@rovenue/shared/paywall";

const GENERATED_CONFIG: BuilderConfig = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { gen_title: "Hi" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [{ type: "text", id: "gen_1", key: "gen_title", role: "title" }],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function detail(config: BuilderConfig): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    builderConfig: config,
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

async function renderModal(initial?: BuilderConfig) {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(detail(initial ?? emptyBuilderConfig("en")));
  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }
  const onClose = vi.fn();
  const utils = render(
    <ServiceProvider provide={[PaywallBuilderApi, PaywallBuilderViewModel]} props={{ projectId: "p_1", paywallId: "pw_1" }}>
      <Probe />
      <StartModal onClose={onClose} />
    </ServiceProvider>,
  );
  await act(async () => {
    await vm.load(() => {});
  });
  return { vm, onClose, ...utils };
}

beforeEach(() => {
  appStorePost.mockReset();
  generatePost.mockReset();
});

describe("StartModal tabs", () => {
  it("defaults to the Presets tab and keeps the preset grid", async () => {
    await renderModal();
    expect(screen.getByText("Blank canvas")).toBeInTheDocument();
  });

  it("switching tabs and back preserves the preset grid", async () => {
    await renderModal();
    fireEvent.click(screen.getByText("From App Store"));
    expect(screen.queryByText("Blank canvas")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Presets"));
    expect(screen.getByText("Blank canvas")).toBeInTheDocument();
  });
});

describe("From App Store tab", () => {
  it("imports, previews and applies the config on an empty tree", async () => {
    appStorePost.mockResolvedValue(
      jsonResponse({ data: { config: GENERATED_CONFIG, metadata: { name: "Super App", iconUrl: "https://x/i.png" } } }),
    );
    const { vm, onClose, container } = await renderModal();
    fireEvent.click(screen.getByText("From App Store"));
    fireEvent.change(container.querySelector('input[type="url"]')!, {
      target: { value: "https://apps.apple.com/tr/app/x/id123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Import"));
    });
    expect(screen.getByText("Super App")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Apply"));
    });
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["gen_1"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("arms a confirm before applying over a non-empty tree", async () => {
    appStorePost.mockResolvedValue(
      jsonResponse({ data: { config: GENERATED_CONFIG, metadata: { name: "Super App", iconUrl: "https://x/i.png" } } }),
    );
    const nonEmpty = emptyBuilderConfig("en");
    nonEmpty.root.children.push({ type: "spacer", id: "sp1" });
    const { vm } = await renderModal(nonEmpty);
    fireEvent.click(screen.getByText("From App Store"));
    fireEvent.change(document.querySelector('input[type="url"]')!, {
      target: { value: "https://apps.apple.com/tr/app/x/id123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Import"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Apply"));
    });
    // First click arms — nothing applied yet.
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["sp1"]);
    expect(screen.getByText(/replace your current design/i)).toBeInTheDocument();
    // Second click on the same Apply button applies.
    await act(async () => {
      fireEvent.click(screen.getByText("Apply"));
    });
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["gen_1"]);
  });

  it("renders the typed error for APP_NOT_FOUND", async () => {
    appStorePost.mockResolvedValue(
      jsonResponse({ error: { code: "APP_NOT_FOUND", message: "" } }, 422),
    );
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("From App Store"));
    fireEvent.change(container.querySelector('input[type="url"]')!, {
      target: { value: "https://apps.apple.com/tr/app/x/id123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Import"));
    });
    expect(screen.getByText(/no app found/i)).toBeInTheDocument();
  });

  it("renders the bad-URL copy for a 400 VALIDATION_ERROR", async () => {
    appStorePost.mockResolvedValue(
      jsonResponse({ error: { code: "VALIDATION_ERROR", message: "" } }, 400),
    );
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("From App Store"));
    fireEvent.change(container.querySelector('input[type="url"]')!, {
      target: { value: "https://not-an-app-store-link.example" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Import"));
    });
    expect(screen.getByText(/doesn't look like an App Store listing URL/i)).toBeInTheDocument();
  });

  it("renders the generic import-failed copy for a non-typed (500) failure", async () => {
    appStorePost.mockResolvedValue(jsonResponse({}, 500));
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("From App Store"));
    fireEvent.change(container.querySelector('input[type="url"]')!, {
      target: { value: "https://apps.apple.com/tr/app/x/id123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Import"));
    });
    expect(screen.getByText(/import failed — try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/doesn't look like an App Store listing URL/i)).not.toBeInTheDocument();
  });
});

describe("AI assist tab", () => {
  it("chips fill the prompt and Generate applies on an empty tree", async () => {
    generatePost.mockResolvedValue(jsonResponse({ data: { config: GENERATED_CONFIG } }));
    const { vm, container } = await renderModal();
    fireEvent.click(screen.getByText("AI assist"));
    const chip = container.querySelector("[data-chip]")!;
    fireEvent.click(chip);
    const textarea = container.querySelector("textarea")!;
    expect((textarea as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByText("Generate"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Apply"));
    });
    expect(vm.config.root.children.map((c) => c.id)).toEqual(["gen_1"]);
  });

  it("renders the missing-config affordance on ROVI_NOT_CONFIGURED", async () => {
    generatePost.mockResolvedValue(
      jsonResponse({ error: { code: "ROVI_NOT_CONFIGURED", message: "" } }, 412),
    );
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("AI assist"));
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "make a paywall" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Generate"));
    });
    expect(screen.getByText(/needs an API key|managed on Rovenue Cloud/i)).toBeInTheDocument();
  });

  it("renders the typed error for GENERATION_INVALID", async () => {
    generatePost.mockResolvedValue(
      jsonResponse({ error: { code: "GENERATION_INVALID", message: "" } }, 422),
    );
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("AI assist"));
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "make a paywall" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Generate"));
    });
    expect(screen.getByText(/couldn't generate/i)).toBeInTheDocument();
  });

  it("renders the dedicated quota message for ROVI_QUOTA_EXCEEDED, not the rephrase copy", async () => {
    generatePost.mockResolvedValue(
      jsonResponse({ error: { code: "ROVI_QUOTA_EXCEEDED", message: "" } }, 429),
    );
    const { container } = await renderModal();
    fireEvent.click(screen.getByText("AI assist"));
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "make a paywall" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Generate"));
    });
    expect(screen.getByText(/monthly quota is used up/i)).toBeInTheDocument();
    expect(screen.queryByText(/try rephrasing/i)).not.toBeInTheDocument();
  });
});
