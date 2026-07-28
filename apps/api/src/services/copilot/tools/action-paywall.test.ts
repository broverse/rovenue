import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaywallTreeOp } from "@rovenue/shared/paywall";

// =============================================================
// action_paywall_editTree tool (P8 AI-FAB, §6.15)
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {},
    copilotIntentRepo: {
      createIntent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
        id: "intent_1",
        preview: input.preview,
        expiresAt: new Date("2026-07-28T00:00:00Z"),
      })),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return { ...actual, drizzle: { ...actual.drizzle, ...drizzleMock } };
});

import { actionPaywallTools, buildEditTreePreview } from "./action-paywall";

const CTX = {
  projectId: "prj_1",
  userId: "u_1",
  role: "ADMIN",
  threadId: "th_1",
  messageId: "msg_1",
};

const CALL_OPTIONS = { toolCallId: "call_1", messages: [] };

describe("buildEditTreePreview", () => {
  it("insert: title summarizes the subtree, fields are kind/target/position", () => {
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 2,
      subtree: {
        type: "timeline",
        id: "tl_1",
        rows: [{ labelKey: "k1" }, { labelKey: "k2" }, { labelKey: "k3" }],
      },
    };
    expect(buildEditTreePreview(op)).toEqual({
      title: "Add timeline (3 steps)",
      fields: [
        { label: "Kind", after: "insert" },
        { label: "Target", after: "root" },
        { label: "Position", after: 2 },
      ],
    });
  });

  it("insert: a container subtree describes item count instead of steps", () => {
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "stack", id: "s_1", axis: "v", children: [{ type: "spacer", id: "sp_1", size: 4 }] },
    };
    expect(buildEditTreePreview(op).title).toBe("Add stack (1 items)");
  });

  it("replace: target is the replaced node id, position is '-'", () => {
    const op: PaywallTreeOp = {
      kind: "replace",
      nodeId: "n_1",
      subtree: { type: "spacer", id: "n_1", size: 8 },
    };
    expect(buildEditTreePreview(op)).toEqual({
      title: "Replace n_1 with spacer",
      fields: [
        { label: "Kind", after: "replace" },
        { label: "Target", after: "n_1" },
        { label: "Position", after: "-" },
      ],
    });
  });

  it("remove: target is the removed node id", () => {
    const op: PaywallTreeOp = { kind: "remove", nodeId: "n_2" };
    expect(buildEditTreePreview(op)).toEqual({
      title: "Remove node n_2",
      fields: [
        { label: "Kind", after: "remove" },
        { label: "Target", after: "n_2" },
        { label: "Position", after: "-" },
      ],
    });
  });

  it("updateProps: title counts patched fields", () => {
    const op: PaywallTreeOp = {
      kind: "updateProps",
      nodeId: "n_3",
      patch: { color: { light: "#fff" }, align: "center" },
    };
    expect(buildEditTreePreview(op)).toEqual({
      title: "Update n_3 (2 fields)",
      fields: [
        { label: "Kind", after: "updateProps" },
        { label: "Target", after: "n_3" },
        { label: "Position", after: "-" },
      ],
    });
  });

  it("setLocalizations: target is the locale, title counts entries", () => {
    const op: PaywallTreeOp = {
      kind: "setLocalizations",
      locale: "tr",
      entries: { title_key: "Pro'ya Geç" },
    };
    expect(buildEditTreePreview(op)).toEqual({
      title: "Update 1 string for locale tr",
      fields: [
        { label: "Kind", after: "setLocalizations" },
        { label: "Target", after: "tr" },
        { label: "Position", after: "-" },
      ],
    });
  });
});

describe("actionPaywallTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly action_paywall_editTree", () => {
    const tools = actionPaywallTools(CTX);
    expect(Object.keys(tools)).toEqual(["action_paywall_editTree"]);
  });

  it("creates a pending intent scoped to ctx, requiring DEVELOPER, with the coerced preview", async () => {
    const tools = actionPaywallTools(CTX);
    const op: PaywallTreeOp = { kind: "remove", nodeId: "n_1" };
    const input = { paywallId: "pw_1", op };

    const result = await tools["action_paywall_editTree"].execute!(input, CALL_OPTIONS);

    expect(drizzleMock.copilotIntentRepo.createIntent).toHaveBeenCalledTimes(1);
    expect(drizzleMock.copilotIntentRepo.createIntent).toHaveBeenCalledWith(
      drizzleMock.db,
      expect.objectContaining({
        projectId: "prj_1",
        userId: "u_1",
        threadId: "th_1",
        messageId: "msg_1",
        toolName: "action_paywall_editTree",
        payload: input,
        requiresRole: "DEVELOPER",
        preview: buildEditTreePreview(op),
      }),
    );
    expect(result).toMatchObject({
      toolName: "action_paywall_editTree",
      requiresRole: "DEVELOPER",
      preview: buildEditTreePreview(op),
    });
  });
});
