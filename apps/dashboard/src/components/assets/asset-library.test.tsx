import { useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ASSET_MAX_BYTES,
  ASSET_STORAGE_CRITICAL_RATIO,
  ASSET_STORAGE_WARN_RATIO,
} from "@rovenue/shared";
import type { ThemeUrl } from "@rovenue/shared/paywall";
import "../../i18n/config";
import { server } from "../../../tests/msw/server";

// The upgrade CTA is cloud-only (`billingEnabled`, lib/host-mode.ts) and
// the test build leaves VITE_HOST_MODE unset, which resolves to
// self-hosted — so the branch worth asserting would never render. Forced
// on here; lib/host-mode.test.ts owns the derivation itself, and the
// guard is the same one-line pattern billing.tsx and payment-methods.tsx
// already use.
vi.mock("../../lib/host-mode", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  billingEnabled: true,
}));
import { AssetLibrary } from "./asset-library";
import { AssetLibraryModal } from "./asset-library-modal";
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

/**
 * Deliberately NO router in context.
 *
 * The over-quota notice links to billing, and that link must stay a
 * plain `<a href>`: `AssetLibrary` now renders inside `AssetLibraryModal`,
 * which both builders open from a `Dialog.Portal` in subtrees that carry
 * no router (see `overrides.test.tsx` and
 * `funnel-builder/properties-panel.media-picker.test.tsx`, neither of
 * which mounts one). A TanStack `<Link>` there throws on a null router.
 *
 * Rendering every test in this file without a router is what keeps that
 * true — reintroduce `<Link>` and the whole suite goes red rather than
 * only the two real callers' suites.
 */
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

  it("rejects an oversize file locally rather than uploading it first", async () => {
    // Regression: the server DOES reject this (a per-kind `bodyLimit`),
    // but it answers off the Content-Length header before reading the
    // body, so the response races the still-in-flight upload and the
    // browser surfaces it as a bare `error` event with no status — which
    // the dashboard could only report as "network error". The author has
    // to get the real reason, and without spending the upload.
    mockAssets([], { usedBytes: 0, limitBytes: null });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    const input = await screen.findByTestId("asset-upload-input-image");
    const file = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: ASSET_MAX_BYTES.image + 1 });
    await act(async () => {
      selectFile(input, file);
    });

    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
    expect(MockXHR.instances).toHaveLength(0);
  });

  it("warns before the cap is reached, without blocking uploads", async () => {
    const limitBytes = 1000;
    mockAssets([], {
      usedBytes: Math.ceil(limitBytes * ASSET_STORAGE_WARN_RATIO),
      limitBytes,
    });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    expect(await screen.findByRole("status")).toHaveTextContent(/running low/i);
    // Still under the cap: the author can keep working.
    expect(screen.getByRole("button", { name: /upload image/i })).toBeEnabled();
  });

  it("names the room left once storage is critical, and still lets an upload through", async () => {
    // The band between the critical ratio and the cap used to render the
    // full danger-red box while saying the warn band's sentence and
    // leaving upload enabled — three signals telling an author three
    // different things. Red is now the colour of "refused" alone, and
    // the band earns its own copy: the one figure someone about to pick
    // a file needs is how much room is actually left. It is NOT blocked
    // here — 5 KB of headroom still takes a 4 KB file, and the server
    // checks images AFTER normalisation shrinks them, so a raw-size
    // block in the browser would refuse uploads that would have fit.
    const limitBytes = 100 * 1024;
    mockAssets([], {
      usedBytes: Math.ceil(limitBytes * ASSET_STORAGE_CRITICAL_RATIO),
      limitBytes,
    });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/5\.0 KB left/);
    expect(notice).not.toHaveTextContent(/running low/i);
    expect(screen.getByRole("button", { name: /upload image/i })).toBeEnabled();
  });

  it("blocks uploading once the cap is reached and offers the way out", async () => {
    mockAssets([], { usedBytes: 1000, limitBytes: 1000 });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    // Exactly at the cap, not over it: the server's reservation refuses
    // anything that would take the total past the limit, so nothing more
    // fits and a live upload button could only produce a 402.
    expect(await screen.findByRole("status")).toHaveTextContent(/storage is full/i);
    expect(screen.getByRole("button", { name: /upload image/i })).toBeDisabled();
    expect(screen.getByRole("link", { name: /upgrade/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/settings/billing`,
    );
  });

  it("says nothing about storage on an unlimited project", async () => {
    mockAssets([], { usedBytes: 10 ** 9, limitBytes: null });
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    expect(await screen.findByText(/unlimited storage/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload image/i })).toBeEnabled();
  });

  it("never reports a FAILED usage check as zero paywalls", async () => {
    // The zero-case copy is reassuring by design, and `useAssetUsage`
    // returning nothing looks identical whether the answer was "none"
    // or the request never landed. Rendering the reassuring sentence for
    // a failed check tells an author nothing depends on an asset that
    // live paywalls may well serve — and delete is irreversible, with
    // this dialog as its only guard. It now also fires from inside both
    // builders' Browse modals, so the failure path is a common one.
    mockAssets([makeAsset({ id: "a_x" })], { usedBytes: 0, limitBytes: null });
    server.use(
      http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/assets/a_x/usage`, () =>
        HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
      ),
    );
    wrap(<AssetLibrary projectId={PROJECT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/couldn't check/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 published paywalls/i)).not.toBeInTheDocument();
    // Fails closed: an unverified delete is not offered at all.
    expect(screen.getByRole("button", { name: /delete asset/i })).toBeDisabled();
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


// =============================================================
// AssetLibraryModal — the SAME AssetLibrary, in a dialog
// =============================================================
//
// There is no second "picker" component any more. A field's Browse
// button opens the library itself with `kind` set, which turns on two
// things and nothing else: the grid filters to that kind, and each tile
// becomes selectable. Upload and delete are NOT modal-mode extras
// bolted on — they are the library's own affordances, reachable
// wherever the library is, which is the whole point of making it a
// modal (an author who opens Browse and finds the image missing must be
// able to add it right there instead of leaving the builder).
//
// Restricting the upload triggers to `kind` is deliberate: an image
// field that let you upload a video would list an asset it then
// refuses to show.

describe("AssetLibraryModal", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists only assets matching the field's kind", async () => {
    mockAssets(
      [
        makeAsset({ id: "img_1", kind: "image", name: "hero-image" }),
        makeAsset({ id: "vid_1", kind: "video", name: "hero-video" }),
      ],
      { usedBytes: 0, limitBytes: null },
    );
    wrap(
      <AssetLibraryModal
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
      <AssetLibraryModal projectId={PROJECT_ID} kind="video" open onClose={() => undefined} onSelect={onSelect} />,
    );

    fireEvent.click(await screen.findByText("hero-video"));
    expect(onSelect).toHaveBeenCalledWith(asset.url);
  });

  it("offers an upload trigger for the field's kind and no other", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    wrap(
      <AssetLibraryModal
        projectId={PROJECT_ID}
        kind="image"
        open
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );

    expect(await screen.findByTestId("asset-upload-input-image")).toBeInTheDocument();
    expect(screen.queryByTestId("asset-upload-input-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("asset-upload-input-lottie")).not.toBeInTheDocument();
  });

  it("makes an asset uploaded from inside the modal immediately selectable", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    const onSelect = vi.fn();
    wrap(
      <AssetLibraryModal projectId={PROJECT_ID} kind="image" open onClose={() => undefined} onSelect={onSelect} />,
    );

    const input = await screen.findByTestId("asset-upload-input-image");
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await act(async () => {
      selectFile(input, file);
    });

    const uploaded = makeAsset({ id: "new_1", kind: "image", name: "photo", url: `${BASE}/cdn/new_1.webp` });
    await act(async () => {
      latestXhr().respondSuccess(uploaded);
      // Stands in for the server now having the row, ahead of the
      // invalidated query's refetch.
      mockAssets([uploaded], { usedBytes: uploaded.byteSize, limitBytes: null });
    });

    fireEvent.click(await screen.findByText("photo"));
    expect(onSelect).toHaveBeenCalledWith(uploaded.url);
  });

  it("marks the asset the field is currently pointed at", async () => {
    // `listPublishedUsage` cannot see drafts, so the delete warning is
    // blind to the very node the author is editing: without this marker
    // the obvious move — Browse, spot the image, delete the duplicate —
    // can silently 404 the field it was opened from.
    const inUse = makeAsset({ id: "a_used", name: "current-hero" });
    const other = makeAsset({ id: "a_other", name: "other-hero", url: `${BASE}/cdn/other.webp` });
    mockAssets([inUse, other], { usedBytes: 0, limitBytes: null });
    wrap(
      <AssetLibraryModal
        projectId={PROJECT_ID}
        kind="image"
        currentUrl={inUse.url}
        open
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );

    const usedTile = await screen.findByRole("button", { name: /current-hero/i });
    expect(within(usedTile).getByText(/in use/i)).toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: /other-hero/i })).queryByText(/in use/i),
    ).not.toBeInTheDocument();
  });

  it("warns with the published-paywall count before deleting from inside the modal", async () => {
    mockAssets([makeAsset({ id: "a_used", kind: "image", name: "hero" })], { usedBytes: 0, limitBytes: null });
    mockUsage("a_used", [{ id: "pw_1", name: "Main paywall" }]);
    wrap(
      <AssetLibraryModal
        projectId={PROJECT_ID}
        kind="image"
        open
        onClose={() => undefined}
        onSelect={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));

    expect(
      await screen.findByText(/1 published paywall uses this asset: Main paywall/i),
    ).toBeInTheDocument();
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

    // `findAll`, not `getAll`: `wrap` mounts a router, whose first render
    // resolves a tick after render() returns.
    const [light] = await screen.findAllByRole("textbox");
    fireEvent.change(light!, { target: { value: "https://cdn.example.com/hand-typed.png" } });
    expect((light as HTMLInputElement).value).toBe("https://cdn.example.com/hand-typed.png");

    // Opening (and cancelling) the asset library must not clobber the
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
// End-to-end (within jsdom): upload on the full-screen library route,
// confirm the SAME asset is subsequently selectable in a builder's
// modal. Proven by sharing one QueryClient (and therefore one
// `["assets", projectId]` cache entry) across both, the same way the
// real route and the real builder share React Query's module-level
// singleton client. The GET handler is re-armed with the "post-upload"
// list right after the mock upload resolves, standing in for the real
// server now having the row — `useUploadAsset`'s `onSuccess` then
// invalidates the shared query and the modal's own `useAssets` call
// picks up the refetch with no wiring specific to this test.
// =============================================================

describe("AssetLibrary + AssetLibraryModal — shared query cache", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an asset uploaded on the library route is immediately selectable in the modal", async () => {
    mockAssets([], { usedBytes: 0, limitBytes: null });
    const onSelect = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <AssetLibrary projectId={PROJECT_ID} />
        <AssetLibraryModal
          projectId={PROJECT_ID}
          kind="image"
          open
          onClose={() => undefined}
          onSelect={onSelect}
        />
      </QueryClientProvider>,
    );

    // Nothing uploaded yet — the modal starts empty.
    expect(await screen.findByText(/no image assets yet/i)).toBeInTheDocument();

    const [input] = await screen.findAllByTestId("asset-upload-input-image");
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await act(async () => {
      selectFile(input!, file);
    });

    const uploaded = makeAsset({
      id: "new_1",
      kind: "image",
      name: "photo",
      url: `${BASE}/cdn/${PROJECT_ID}/new_1.webp`,
    });
    await act(async () => {
      latestXhr().respondSuccess(uploaded);
      mockAssets([uploaded], { usedBytes: uploaded.byteSize, limitBytes: null });
    });

    // The modal's tile is a <button> whose accessible name is its own
    // text — scoped this way because AssetLibrary's own grid also
    // renders "photo" (in a <div>, not a <button>), so a bare
    // `getByText` would be ambiguous between the two components.
    const tile = await screen.findByRole("button", { name: /photo/i });
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(uploaded.url);
  });
});
