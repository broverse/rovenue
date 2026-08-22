import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { Container, ServiceProvider } from "impair";
import { container as tsyringeContainer } from "tsyringe";
import "../../i18n/config";
import { server } from "../../../tests/msw/server";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../lib/services/funnel-api";

// =============================================================
// Funnel builder: Media URL browses the SAME asset library the paywall
// builder browses
// =============================================================
//
// The onboarding funnel's media field shipped as a bare URL text input,
// so the only way to point a page at an uploaded image was to leave the
// builder, open the asset library route, copy the URL, and come back.
// The Browse button opens `AssetLibraryModal` filtered to the page's
// own `mediaKind`, and picking there writes through the EXACT SAME
// `updatePage({ mediaUrl })` a keystroke does — a hand-typed external
// URL stays a first-class value.

vi.mock("../../lib/hooks/useProjectPaywalls", () => ({
  useProjectPaywalls: () => ({ data: { paywalls: [] } }),
}));

// Imported after the mock above so the mocked module is in place first.
const { PropertiesPanel } = await import("./properties-panel");

const BASE = "http://localhost:3000";
const PROJECT_ID = "p_1";
const MEDIA_PAGE_ID = "pg_media";

function fakeFunnel(): FunnelDetailDto {
  return {
    id: "f_1",
    projectId: PROJECT_ID,
    slug: "s",
    name: "Test funnel",
    status: "draft",
    currentVersionId: null,
    currentVersionNo: null,
    draftPages: [
      { id: MEDIA_PAGE_ID, type: "info", title: { en: "Welcome" }, mediaKind: "image" } as never,
    ],
    draftTheme: {} as never,
    draftSettings: {} as never,
    draftRules: {},
    draftDefaultNext: {},
    draftDiffersFromPublished: false,
    defaultLocale: "en",
    locales: ["en"],
    updatedAt: "",
    createdAt: "",
  };
}

async function makeLoadedVm() {
  const container = new Container(tsyringeContainer);
  const api: Partial<FunnelApi> = {
    get: async () => fakeFunnel(),
    patchDraft: async () => fakeFunnel(),
    publish: async () => ({ funnel: fakeFunnel(), versionNo: 1 }),
    duplicate: async () => fakeFunnel(),
  };
  container.register(FunnelApi, { useValue: api as FunnelApi });
  const vm = container.resolve(FunnelDraftViewModel, { projectId: PROJECT_ID, funnelId: "f_1" });
  await vm.load(() => {});
  vm.selectPage(MEDIA_PAGE_ID);
  return vm;
}

function renderPanel(vm: FunnelDraftViewModel) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ServiceProvider provide={[{ token: FunnelDraftViewModel, provider: { useValue: vm } }]}>
        <PropertiesPanel editLocale="en" defaultLocale="en" />
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

function mockAssets(assets: unknown[]) {
  server.use(
    http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/assets`, () =>
      HttpResponse.json({ data: { assets, usage: { usedBytes: 0, limitBytes: null } } }),
    ),
  );
}

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "a_1",
    projectId: PROJECT_ID,
    kind: "image",
    name: "hero",
    contentHash: "h".repeat(64),
    contentType: "image/webp",
    byteSize: 1024,
    width: 800,
    height: 600,
    sourceFormat: "png",
    sourceWidth: 800,
    sourceHeight: 600,
    policyVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    url: `${BASE}/cdn/${PROJECT_ID}/a_1.webp`,
    ...overrides,
  };
}

describe("PropertiesPanel — Media URL asset picker", () => {
  beforeEach(() => {
    // The panel's product dropdown fetches unconditionally; stubbed so
    // an unmatched-handler warning doesn't muddy this file's output.
    server.use(
      http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/products`, () =>
        HttpResponse.json({ data: [] }),
      ),
    );
  });

  it("writes the picked asset's URL into the page's mediaUrl", async () => {
    mockAssets([makeAsset({ name: "hero" })]);
    const vm = await makeLoadedVm();
    renderPanel(vm);

    fireEvent.click(screen.getByRole("button", { name: /browse assets/i }));
    fireEvent.click(await screen.findByText("hero"));

    await waitFor(() =>
      expect(vm.pages[0]!.mediaUrl).toBe(`${BASE}/cdn/${PROJECT_ID}/a_1.webp`),
    );
  });

  it("filters the library to the page's own media kind", async () => {
    mockAssets([
      makeAsset({ id: "img_1", kind: "image", name: "hero-image" }),
      makeAsset({ id: "vid_1", kind: "video", name: "hero-video" }),
    ]);
    const vm = await makeLoadedVm();
    renderPanel(vm);

    fireEvent.click(screen.getByRole("button", { name: /browse assets/i }));

    expect(await screen.findByText("hero-image")).toBeInTheDocument();
    expect(screen.queryByText("hero-video")).not.toBeInTheDocument();
  });

  it("leaves a hand-typed external URL working", async () => {
    mockAssets([]);
    const vm = await makeLoadedVm();
    renderPanel(vm);

    const input = screen.getByPlaceholderText(/cdn\.example\.com\/photo\.jpg/i);
    fireEvent.change(input, { target: { value: "https://cdn.example.com/hand-typed.png" } });
    await waitFor(() => expect(vm.pages[0]!.mediaUrl).toBe("https://cdn.example.com/hand-typed.png"));

    fireEvent.click(screen.getByRole("button", { name: /browse assets/i }));
    expect(await screen.findByText(/choose an asset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(vm.pages[0]!.mediaUrl).toBe("https://cdn.example.com/hand-typed.png");
  });
});
