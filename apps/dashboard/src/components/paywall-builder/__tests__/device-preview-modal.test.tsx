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
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
