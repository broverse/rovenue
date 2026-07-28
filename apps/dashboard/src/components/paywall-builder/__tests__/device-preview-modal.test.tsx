import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServiceProvider, useService } from "impair";
import "../../../i18n/config";

// =============================================================
// P9 Task 7 — DevicePreviewModal: mints a preview session on open (Task 2's
// POST .../preview-sessions), renders the QR from `qrPayload`, shows a
// copyable token + expiry countdown, and "End session" both DELETEs the
// session and flips `vm.previewSessionActive` back to false. rpc is mocked
// at the transport layer (mirrors start-modal.test.tsx); `qrcode` is
// mocked too — its real canvas renderer needs a browser/node canvas
// backend jsdom doesn't provide.
//
// Final-review fix (finding I1): dismissing the modal (backdrop / header X)
// must NOT revoke the session — only "End session" may. The session is
// hoisted onto the VM (`previewSession`/`previewSessionActive`) precisely so
// it survives the modal unmounting; reopening while it's still live must
// reuse it (no second mint), and reopening after it has expired must mint a
// fresh one. The suite below pins all four of those, plus that an edit made
// AFTER a dismiss (session still live, modal gone) still reaches the
// PREVIEW_FLUSH_DEBOUNCE_MS fast-flush — the scenario the old
// always-revoke-on-close behavior made unreachable in practice.
// =============================================================

const createPost = vi.hoisted(() => vi.fn());
const revokeDelete = vi.hoisted(() => vi.fn());
const qrToDataURL = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return {
    ...actual,
    rpc: {
      dashboard: {
        projects: {
          ":projectId": {
            paywalls: {
              ":id": {
                "preview-sessions": {
                  $post: (...a: unknown[]) => createPost(...a),
                  ":sid": { $delete: (...a: unknown[]) => revokeDelete(...a) },
                },
              },
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

vi.mock("qrcode", () => ({
  default: { toDataURL: (...a: unknown[]) => qrToDataURL(...a) },
}));

import { DevicePreviewModal } from "../device-preview-modal";
import { PaywallBuilderApi, type PaywallBuilderDetailDto } from "../../../lib/services/paywall-builder-api";
import { PaywallBuilderViewModel } from "../vm/paywall-builder.vm";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function detail(): PaywallBuilderDetailDto {
  return {
    id: "pw_1",
    projectId: "p_1",
    identifier: "main",
    name: "Main",
    offeringId: "off_1",
    isActive: true,
    configFormatVersion: 2,
    builderConfig: emptyBuilderConfig("en"),
    defaultLocale: "en",
    offeringPackageIds: [],
    updatedAt: "",
    createdAt: "",
    status: "draft",
    publishedVersionId: null,
  };
}

const SESSION = {
  sessionId: "pvs_1",
  token: "tok_abc123",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  previewUrl: "https://api.example.com/v1/preview/paywalls/tok_abc123",
  qrPayload: "https://api.example.com/v1/preview/paywalls/tok_abc123",
};

async function renderModal() {
  vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(detail());
  let vm!: PaywallBuilderViewModel;
  function Probe() {
    vm = useService(PaywallBuilderViewModel);
    return null;
  }
  const onClose = vi.fn();
  const utils = render(
    <ServiceProvider provide={[PaywallBuilderApi, PaywallBuilderViewModel]} props={{ projectId: "p_1", paywallId: "pw_1" }}>
      <Probe />
      <DevicePreviewModal onClose={onClose} />
    </ServiceProvider>,
  );
  await act(async () => {
    await vm.load(() => {});
  });
  return { vm, onClose, ...utils };
}

beforeEach(() => {
  createPost.mockReset();
  revokeDelete.mockReset();
  qrToDataURL.mockReset();
  qrToDataURL.mockResolvedValue("data:image/png;base64,AAAA");
});

describe("DevicePreviewModal", () => {
  it("mints a preview session on open and shows a QR image + token", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    const { vm } = await renderModal();

    expect(createPost).toHaveBeenCalledWith(
      { param: { projectId: "p_1", id: "pw_1" } },
      expect.anything(),
    );

    await waitFor(() => {
      expect(screen.getByAltText(/qr code/i)).toBeInTheDocument();
    });
    expect(screen.getByText(SESSION.token)).toBeInTheDocument();
    expect(vm.previewSessionActive).toBe(true);
  });

  it("renders an expiry countdown", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    await renderModal();

    await waitFor(() => {
      expect(screen.getByText(/expires in/i)).toBeInTheDocument();
    });
  });

  it("shows a 'coming soon' caption on the React Native tab", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    await renderModal();
    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());

    fireEvent.click(screen.getByText("React Native"));

    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it("shows a mint-failure message when the session fails to create", async () => {
    createPost.mockResolvedValue(jsonResponse({ error: { code: "INTERNAL", message: "boom" } }, 500));
    const { vm } = await renderModal();

    await waitFor(() => {
      expect(screen.getByText(/could not start a preview session/i)).toBeInTheDocument();
    });
    expect(vm.previewSessionActive).toBe(false);
  });

  it("'End session' DELETEs the session and flips previewSessionActive back to false", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    revokeDelete.mockResolvedValue(jsonResponse({ data: { revoked: true } }));
    const { vm, onClose } = await renderModal();

    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());
    expect(vm.previewSessionActive).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByText("End session"));
    });

    expect(revokeDelete).toHaveBeenCalledWith(
      { param: { projectId: "p_1", id: "pw_1", sid: SESSION.sessionId } },
      expect.anything(),
    );
    expect(vm.previewSessionActive).toBe(false);
    expect(vm.previewSession).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closing via the header X does NOT revoke the session — previewSessionActive stays true", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    const { vm, onClose } = await renderModal();

    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());
    expect(vm.previewSessionActive).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTitle("Close"));
    });

    expect(revokeDelete).not.toHaveBeenCalled();
    expect(vm.previewSessionActive).toBe(true);
    expect(vm.previewSession).toEqual(SESSION);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closing via the backdrop does NOT revoke the session — previewSessionActive stays true", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    const { vm, onClose, container } = await renderModal();

    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());
    expect(vm.previewSessionActive).toBe(true);

    await act(async () => {
      fireEvent.click(container.firstChild as HTMLElement);
    });

    expect(revokeDelete).not.toHaveBeenCalled();
    expect(vm.previewSessionActive).toBe(true);
    expect(vm.previewSession).toEqual(SESSION);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reopening the modal while a live session exists reuses it — no second mint, same token", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(detail());

    let vm!: PaywallBuilderViewModel;
    function Probe() {
      vm = useService(PaywallBuilderViewModel);
      return null;
    }
    function Harness({ open }: { open: boolean }) {
      return (
        <ServiceProvider
          provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
          props={{ projectId: "p_1", paywallId: "pw_1" }}
        >
          <Probe />
          {open && <DevicePreviewModal onClose={() => {}} />}
        </ServiceProvider>
      );
    }

    const { rerender } = render(<Harness open={true} />);
    await act(async () => {
      await vm.load(() => {});
    });
    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());
    expect(createPost).toHaveBeenCalledTimes(1);

    // Dismiss: the modal unmounts, the VM (and its session) does not.
    rerender(<Harness open={false} />);
    expect(screen.queryByText(SESSION.token)).not.toBeInTheDocument();
    expect(vm.previewSessionActive).toBe(true);

    // Reopen: same session, no second mint.
    rerender(<Harness open={true} />);
    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());

    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it("reopening after the live session has expired mints a fresh one instead of reusing it", async () => {
    const FIXED_EXPIRES_AT = "2026-01-01T00:00:00.000Z";
    const firstSession = { ...SESSION, sessionId: "pvs_first", token: "tok_first", expiresAt: FIXED_EXPIRES_AT };
    const secondSession = { ...SESSION, sessionId: "pvs_second", token: "tok_second" };
    createPost
      .mockResolvedValueOnce(jsonResponse({ data: firstSession }))
      .mockResolvedValueOnce(jsonResponse({ data: secondSession }));
    vi.spyOn(PaywallBuilderApi.prototype, "get").mockResolvedValue(detail());

    const dateNowSpy = vi.spyOn(Date, "now");
    // Before FIXED_EXPIRES_AT: the first session is still live.
    dateNowSpy.mockReturnValue(new Date(FIXED_EXPIRES_AT).getTime() - 60_000);

    let vm!: PaywallBuilderViewModel;
    function Probe() {
      vm = useService(PaywallBuilderViewModel);
      return null;
    }
    function Harness({ open }: { open: boolean }) {
      return (
        <ServiceProvider
          provide={[PaywallBuilderApi, PaywallBuilderViewModel]}
          props={{ projectId: "p_1", paywallId: "pw_1" }}
        >
          <Probe />
          {open && <DevicePreviewModal onClose={() => {}} />}
        </ServiceProvider>
      );
    }

    try {
      const { rerender } = render(<Harness open={true} />);
      await act(async () => {
        await vm.load(() => {});
      });
      await waitFor(() => expect(screen.getByText("tok_first")).toBeInTheDocument());
      expect(createPost).toHaveBeenCalledTimes(1);

      rerender(<Harness open={false} />);

      // Jump past FIXED_EXPIRES_AT.
      dateNowSpy.mockReturnValue(new Date(FIXED_EXPIRES_AT).getTime() + 60_000);

      rerender(<Harness open={true} />);
      await waitFor(() => expect(screen.getByText("tok_second")).toBeInTheDocument());

      expect(createPost).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("an edit made after a dismiss (session still live) still fast-flushes via the debounce — the fast-flush-is-dead-code defect", async () => {
    createPost.mockResolvedValue(jsonResponse({ data: SESSION }));
    const patchBuilderConfig = vi
      .spyOn(PaywallBuilderApi.prototype, "patchBuilderConfig")
      .mockResolvedValue(detail());
    const { vm } = await renderModal();

    await waitFor(() => expect(screen.getByText(SESSION.token)).toBeInTheDocument());

    // Dismiss via the header X — per the fix, the session (and the fast-
    // flush flag) stays live.
    await act(async () => {
      fireEvent.click(screen.getByTitle("Close"));
    });
    expect(vm.previewSessionActive).toBe(true);
    expect(patchBuilderConfig).not.toHaveBeenCalled();

    // Fake timers ONLY from here: no further RTL `waitFor`/DOM polling is
    // needed below, just a direct VM mutation and a plain assertion after
    // advancing the debounce window, so there is no clash with `waitFor`'s
    // own (real-timer) polling used above.
    vi.useFakeTimers();
    try {
      const id = vm.addNode("text", "root");
      expect(id).not.toBeNull();
      expect(vm.isDirty).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);

      expect(patchBuilderConfig).toHaveBeenCalledTimes(1);
      expect(vm.isDirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
