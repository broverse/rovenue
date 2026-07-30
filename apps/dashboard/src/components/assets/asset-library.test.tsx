import { useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThemeUrl } from "@rovenue/shared/paywall";
import "../../i18n/config";
import { server } from "../../../tests/msw/server";
import { AssetLibrary } from "./asset-library";
import { AssetPickerDialog } from "./asset-picker-dialog";
import { ThemeUrlField } from "../paywall-builder/inspector/fields";
import type { Asset } from "../../lib/hooks/useAssets";

// =============================================================
// Task 11 — dashboard asset library and paywall builder picker
// =============================================================
//
// Three things this pins, straight from the task brief:
//
// 1. The delete warning's copy is load-bearing. `GET .../assets/:id/usage`
//    only ever reports PUBLISHED paywalls (a draft-only reference is
//    invisible to it), so the warning MUST say "published paywalls" —
//    never bare "paywalls" — in BOTH the zero and non-zero case. The
//    "says 'published paywalls', not 'paywalls'" test below is the one
//    this repo's standing lesson calls out: it must go RED if the word
//    "published" is dropped from the copy (verified by hand, see the
//    task report).
//
// 2. Upload progress must be a real, determinate percentage — not an
//    indeterminate spinner. `useUploadAsset` drives an `XMLHttpRequest`
//    by hand specifically so `upload.onprogress` can report real bytes;
//    the upload tests below use a hand-rolled `MockXHR` (not MSW) so the
//    test can fire a *partial* progress event and assert the UI reflects
//    it mid-flight, something an all-or-nothing mocked response can't
//    exercise.
//
// 3. The picker never replaces the URL text input — it sits BESIDE it.
//    "leaves a hand-typed external URL working" renders `ThemeUrlField`
//    (the actual field the paywall builder inspector uses) directly and
//    proves a typed value survives opening and cancelling the picker.

const BASE = "http://localhost:3000";
const PROJECT_ID = "p_1";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a_1",
    projectId: PROJECT_ID,
    kind: "image",
    name: "hero",
    contentHash: "h".repeat(64),
    contentType: "image/webp",
    byteSize: 2 * 1024 * 1024,
    width: 800,
    height: 600,
    sourceFormat: "png",
    sourceWidth: 1600,
    sourceHeight: 1200,
    policyVersion: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    url: `${BASE}/cdn/${PROJECT_ID}/a_1.webp`,
    ...overrides,
  };
}

function mockAssets(assets: Asset[], usage: { usedBytes: number; limitBytes: number | null }) {
  server.use(
    http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/assets`, () =>
      HttpResponse.json({ data: { assets, usage } }),
    ),
  );
}

function mockUsage(assetId: string, publishedPaywalls: { id: string; name: string }[]) {
  server.use(
    http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/assets/${assetId}/usage`, () =>
      HttpResponse.json({ data: { publishedPaywalls } }),
    ),
  );
}

// =============================================================
// MockXHR — drives the upload path by hand instead of through MSW.
// MSW resolves a mocked response as one atomic event; it can't fire a
// PARTIAL `upload.onprogress` mid-transfer the way a real multi-chunk
// upload does, and that partial signal is exactly what "determinate,
// not a spinner" needs a test to exercise.
// =============================================================

class MockXHR {
  static instances: MockXHR[] = [];
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockXHR.instances.push(this);
  }
  open(_method: string, _url: string) {}
  setRequestHeader(_k: string, _v: string) {}
  send(_body: unknown) {}

  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respondSuccess(asset: Asset) {
    this.status = 201;
    this.responseText = JSON.stringify({ data: asset });
    this.onload?.();
  }
  respondError(status: number, code: string, message: string) {
    this.status = status;
    this.responseText = JSON.stringify({ error: { code, message } });
    this.onload?.();
  }
}

function latestXhr(): MockXHR {
  const xhr = MockXHR.instances.at(-1);
  if (!xhr) throw new Error("no XHR was constructed");
  return xhr;
}

function selectFile(input: HTMLElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("AssetLibrary", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders each asset with its kind, dimensions and size", async () => {
    mockAssets([makeAsset({ name: "hero", kind: "image", width: 800, height: 600, byteSize: 2 * 1024 * 1024 })], {
      usedBytes: 0,
      limitBytes: null,
    });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    expect(await screen.findByText("hero")).toBeInTheDocument();
    // One assertion on the row's combined kind/dimensions/size text —
    // scoped this way (rather than three separate substring matches)
    // because "Image" alone also matches the "Upload image" trigger
    // button elsewhere on the page.
    expect(screen.getByText(/Image · 800\s*×\s*600 · 2\.0 MB/)).toBeInTheDocument();
  });

  it("shows storage used against the tier limit", async () => {
    mockAssets([], { usedBytes: 5 * 1024 * 1024, limitBytes: 10 * 1024 * 1024 });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    expect(await screen.findByText(/5\.0 MB of 10\.0 MB used/i)).toBeInTheDocument();
  });

  it("shows 'unlimited' rather than a bar when limitBytes is null", async () => {
    mockAssets([], { usedBytes: 1024, limitBytes: null });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    expect(await screen.findByText(/unlimited storage/i)).toBeInTheDocument();
    // A bar with no denominator is meaningless — none should render.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("reports upload progress rather than a bare spinner", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    const input = await screen.findByTestId("asset-upload-input-image");
    const file = new File(["x".repeat(10)], "photo.png", { type: "image/png" });
    await act(async () => {
      selectFile(input, file);
    });

    const xhr = latestXhr();
    await act(async () => {
      xhr.emitProgress(42, 100);
    });

    // Determinate: a real percentage, not an indeterminate spinner.
    expect(await screen.findByText(/42%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");

    await act(async () => {
      xhr.respondSuccess(makeAsset({ id: "new", name: "photo" }));
    });
    await waitFor(() => expect(screen.queryByText(/uploading/i)).not.toBeInTheDocument());
  });

  it("surfaces a typed upload error to the user", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    const input = await screen.findByTestId("asset-upload-input-image");

    async function triggerError(code: string, message: string) {
      const file = new File(["x"], "photo.png", { type: "image/png" });
      await act(async () => {
        selectFile(input, file);
      });
      await act(async () => {
        latestXhr().respondError(code === "ASSET_QUOTA_EXCEEDED" ? 402 : 400, code, message);
      });
    }

    await triggerError("ASSET_FILE_TOO_LARGE", "too big");
    const tooLarge = await screen.findByText(/too large/i);
    expect(tooLarge).toBeInTheDocument();

    await triggerError("ASSET_FORMAT_UNSUPPORTED", "bad bytes");
    const unsupported = await screen.findByText(/supported .* format/i);
    expect(unsupported).toBeInTheDocument();
    expect(unsupported.textContent).not.toBe(tooLarge.textContent);

    await triggerError("ASSET_QUOTA_EXCEEDED", "no room");
    const quota = await screen.findByText(/storage limit/i);
    expect(quota).toBeInTheDocument();
    expect(quota.textContent).not.toBe(unsupported.textContent);
  });

  it("warns with the published-paywall count before deleting", async () => {
    mockAssets([makeAsset({ id: "a_used" })], { usedBytes: 0, limitBytes: null });
    mockUsage("a_used", [{ id: "pw_1", name: "Main paywall" }]);
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    expect(
      await screen.findByText(/1 published paywall uses this asset: Main paywall/i),
    ).toBeInTheDocument();
  });

  it("says 'published paywalls', not 'paywalls', in the warning", async () => {
    mockAssets([makeAsset({ id: "a_unused" })], { usedBytes: 0, limitBytes: null });
    mockUsage("a_unused", []);
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    // The boundary the brief calls out: the index only ever covers
    // PUBLISHED versions, so the zero-case copy must say "published
    // paywalls" — never bare "paywalls" — or a reader takes "0 paywalls"
    // as "nothing depends on this" and deletes an asset a draft needs.
    expect(await screen.findByText(/0 published paywalls/i)).toBeInTheDocument();
  });
});

describe("AssetPickerDialog", () => {
  it("lists only assets matching the field's kind", async () => {
    mockAssets(
      [
        makeAsset({ id: "img_1", kind: "image", name: "hero-image" }),
        makeAsset({ id: "vid_1", kind: "video", name: "hero-video" }),
      ],
      { usedBytes: 0, limitBytes: null },
    );
    wrap(
      <AssetPickerDialog
        projectId={PROJECT_ID}
        kind="video"
        open
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(await screen.findByText("hero-video")).toBeInTheDocument();
    expect(screen.queryByText("hero-image")).not.toBeInTheDocument();
  });

  it("returns the asset's public URL on select", async () => {
    const asset = makeAsset({ id: "vid_1", kind: "video", name: "hero-video", url: `${BASE}/cdn/vid_1.mp4` });
    mockAssets([asset], { usedBytes: 0, limitBytes: null });
    const onSelect = vi.fn();
    wrap(
      <AssetPickerDialog projectId={PROJECT_ID} kind="video" open onClose={() => undefined} onSelect={onSelect} />,
    );

    fireEvent.click(await screen.findByText("hero-video"));
    expect(onSelect).toHaveBeenCalledWith(asset.url);
  });

  it("leaves a hand-typed external URL working", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });

    // A controlled harness — mirrors how content-tab.tsx actually wires
    // ThemeUrlField (`value`/`onChange` round-tripping through the VM) —
    // so a typed keystroke is reflected back into the DOM the way it is
    // for a real author, not swallowed by a no-op onChange.
    function Harness() {
      const [value, setValue] = useState<ThemeUrl | undefined>(undefined);
      return (
        <ThemeUrlField
          labelLight="URL (light)"
          labelDark="URL (dark)"
          value={value}
          onChange={setValue}
          kind="image"
          projectId={PROJECT_ID}
        />
      );
    }
    wrap(<Harness />);

    const [light] = screen.getAllByRole("textbox");
    fireEvent.change(light!, { target: { value: "https://cdn.example.com/hand-typed.png" } });
    expect((light as HTMLInputElement).value).toBe("https://cdn.example.com/hand-typed.png");

    // Opening (and cancelling) the asset picker must not clobber the
    // hand-typed value — uploading is an alternative, never a
    // replacement, for a plain URL string.
    const [browseLight] = screen.getAllByRole("button", { name: /browse assets/i });
    fireEvent.click(browseLight!);
    expect(await screen.findByText(/choose an asset/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect((light as HTMLInputElement).value).toBe("https://cdn.example.com/hand-typed.png");
  });
});

// =============================================================
// End-to-end (within jsdom): upload through AssetLibrary, confirm the
// SAME asset is subsequently selectable in AssetPickerDialog. This is
// the actual claim task-11-brief makes about the two components —
// proven here by sharing one QueryClient (and therefore one
// `["assets", projectId]` cache entry) across both, the same way a
// real settings-tab upload and a real builder-inspector picker would
// share it in the app (React Query is a module-level singleton client
// there too). The GET handler is re-armed with the "post-upload" list
// right after the mock upload resolves, standing in for the real
// server now having the row — `useUploadAsset`'s `onSuccess` then
// invalidates the shared query and the picker's own `useAssets` call
// picks up the refetch with no wiring specific to this test.
// =============================================================

describe("AssetLibrary + AssetPickerDialog — shared query cache", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an asset uploaded through the library is immediately selectable in the picker", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    const onSelect = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <AssetLibrary projectId={PROJECT_ID} />
        <AssetPickerDialog
          projectId={PROJECT_ID}
          kind="image"
          open
          onClose={() => undefined}
          onSelect={onSelect}
        />
      </QueryClientProvider>,
    );

    // Nothing uploaded yet — the picker starts empty.
    expect(await screen.findByText(/no image assets uploaded yet/i)).toBeInTheDocument();

    const input = await screen.findByTestId("asset-upload-input-image");
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await act(async () => {
      selectFile(input, file);
    });

    const uploaded = makeAsset({
      id: "new_1",
      kind: "image",
      name: "photo",
      url: `${BASE}/cdn/${PROJECT_ID}/new_1.webp`,
    });
    await act(async () => {
      latestXhr().respondSuccess(uploaded);
      // Stand in for the server now having the row, ahead of the
      // invalidated query's refetch (see the describe-block comment).
      mockAssets([uploaded], { usedBytes: uploaded.byteSize, limitBytes: null });
    });

    // The picker's row is a <button> whose accessible name is its own
    // text — scoped this way because AssetLibrary's own list also
    // renders "photo" (in a <div>, not a <button>), so a bare
    // `getByText` would be ambiguous between the two components.
    const pickerRow = await screen.findByRole("button", { name: /photo/i });
    fireEvent.click(pickerRow);
    expect(onSelect).toHaveBeenCalledWith(uploaded.url);
  });
});
