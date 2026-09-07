import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./approval-card";
import { RoviProvider } from "../rovi-provider";
import { useRovi } from "../../../lib/hooks/useRovi";

// =============================================================
// P8 §6.15 Task 5 — the Rovi->builder bridge, from ApprovalCard's side.
//
// As of Task 5, `action_paywall_editTree`'s intent handler PERSISTS the
// approved op server-side itself — it is no longer a dry run the client
// applies. So on an executed intent, ApprovalCard just NOTIFIES
// `RoviProvider.dispatchPaywallPatch`, SCOPED to the edit's own
// `paywallId`, that the draft changed; there is no op payload to forward.
// When no listener is registered for that exact paywall, it shows the
// "open the builder" fallback with a re-apply (re-notify) affordance
// instead of silently dropping the change, or worse, notifying whichever
// OTHER paywall's builder happens to be mounted (spec §3.3 — every
// paywall's root node id is literally "root", so an unscoped edit is
// valid-looking on any paywall).
// ai-bridge.test.tsx covers the OTHER end (builder-shell registering the
// listener under its own paywallId, unregistering on unmount, and
// re-fetching the persisted draft once notified).
// =============================================================

const executeMutateAsync = vi.fn();
const rejectMutateAsync = vi.fn();

vi.mock("../../../lib/hooks/useRoviIntents", () => ({
  useRoviIntents: () => ({
    execute: { mutateAsync: executeMutateAsync, isPending: false },
    reject: { mutateAsync: rejectMutateAsync },
  }),
}));

beforeEach(() => {
  executeMutateAsync.mockReset();
  rejectMutateAsync.mockReset();
});

// The handler's execute result shape (Task 5): `{ paywallId, draftRevision }`
// — never an op the client would re-apply.
const editTreeResult = { paywallId: "pw_1", draftRevision: 1 };

function editTreeIntent() {
  return {
    intentId: "int_1",
    toolName: "action_paywall_editTree",
    requiresRole: "EDITOR",
    preview: { title: "Add spacer", fields: [] },
    expiresAt: new Date().toISOString(),
  };
}

function nonTreeIntent() {
  return {
    intentId: "int_2",
    toolName: "action_subscribers_grant",
    requiresRole: "ADMIN",
    preview: { title: "Grant credits", fields: [] },
    expiresAt: new Date().toISOString(),
  };
}

/** Mounted alongside `ApprovalCard` inside the SAME `RoviProvider` to
 *  register a patch listener for `paywallId` while `active`, unregistering
 *  when it flips to `false` — mirrors what builder-shell.tsx does on
 *  mount/unmount, registered under ITS OWN open paywall's id. The listener
 *  takes no payload (Task 5): it's a "your draft changed, go refetch"
 *  signal, not an op to apply. */
function Registrar({
  paywallId,
  listener,
  active,
}: {
  paywallId: string;
  listener: () => void;
  active: boolean;
}) {
  const { registerPaywallPatchListener } = useRovi();
  useEffect(() => {
    if (!active) return;
    return registerPaywallPatchListener(paywallId, listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paywallId]);
  return null;
}

describe("ApprovalCard", () => {
  it("renders Cancel and Approve & Run for a fresh intent", () => {
    render(
      <RoviProvider>
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & Run" })).toBeInTheDocument();
  });

  it("still shows the plain 'Approved and executed.' terminal state for non-editTree intents", async () => {
    executeMutateAsync.mockResolvedValue({ ok: true });
    render(
      <RoviProvider>
        <ApprovalCard intent={nonTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Approved and executed.");
  });

  it("notifies the listener registered for the SAME paywallId once the intent executes, without an op payload", async () => {
    executeMutateAsync.mockResolvedValue(editTreeResult);
    const listener = vi.fn();

    render(
      <RoviProvider>
        <Registrar paywallId="pw_1" listener={listener} active />
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Applied to the builder.");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith();
  });

  it("refuses and shows the fallback when the mounted builder is for a DIFFERENT paywall (cross-paywall guard)", async () => {
    // The edit is for pw_1, but the only mounted builder is for pw_2 —
    // e.g. approved before navigating, or approved after navigating away.
    // Without paywall scoping this would silently notify pw_2's builder
    // to refetch a draft that isn't its own (its root id is also
    // literally "root", so an unscoped edit looks valid there too).
    executeMutateAsync.mockResolvedValue(editTreeResult);
    const listenerForOtherPaywall = vi.fn();

    render(
      <RoviProvider>
        <Registrar paywallId="pw_2" listener={listenerForOtherPaywall} active />
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open this paywall's builder to apply this change.");
    expect(listenerForOtherPaywall).not.toHaveBeenCalled();
  });

  it("shows the fallback card with a re-apply button when no listener is registered", async () => {
    executeMutateAsync.mockResolvedValue(editTreeResult);

    render(
      <RoviProvider>
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open this paywall's builder to apply this change.");
    expect(screen.getByRole("button", { name: "Re-apply" })).toBeInTheDocument();
  });

  it("re-apply re-notifies once a same-paywall listener is registered, moving out of the fallback state", async () => {
    executeMutateAsync.mockResolvedValue(editTreeResult);
    const listener = vi.fn();

    function Harness({ active }: { active: boolean }) {
      return (
        <RoviProvider>
          <Registrar paywallId="pw_1" listener={listener} active={active} />
          <ApprovalCard intent={editTreeIntent()} />
        </RoviProvider>
      );
    }

    const { rerender } = render(<Harness active={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));
    await screen.findByText("Open this paywall's builder to apply this change.");
    expect(listener).not.toHaveBeenCalled();

    act(() => {
      rerender(<Harness active />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));

    await screen.findByText("Applied to the builder.");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("re-apply still refuses if the newly-registered listener is for a different paywall", async () => {
    executeMutateAsync.mockResolvedValue(editTreeResult);
    const listenerForOtherPaywall = vi.fn();

    function Harness({ active }: { active: boolean }) {
      return (
        <RoviProvider>
          <Registrar paywallId="pw_2" listener={listenerForOtherPaywall} active={active} />
          <ApprovalCard intent={editTreeIntent()} />
        </RoviProvider>
      );
    }

    const { rerender } = render(<Harness active={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));
    await screen.findByText("Open this paywall's builder to apply this change.");

    act(() => {
      rerender(<Harness active />); // the NEWLY-mounted builder is still pw_2, not pw_1
    });

    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));

    expect(screen.getByText("Open this paywall's builder to apply this change.")).toBeInTheDocument();
    expect(listenerForOtherPaywall).not.toHaveBeenCalled();
  });

  it("does not notify a listener that unregistered before approval", async () => {
    executeMutateAsync.mockResolvedValue(editTreeResult);
    const listener = vi.fn();

    function Harness({ active }: { active: boolean }) {
      return (
        <RoviProvider>
          <Registrar paywallId="pw_1" listener={listener} active={active} />
          <ApprovalCard intent={editTreeIntent()} />
        </RoviProvider>
      );
    }

    const { rerender } = render(<Harness active />);
    act(() => {
      rerender(<Harness active={false} />); // unregister before approval
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open this paywall's builder to apply this change.");
    expect(listener).not.toHaveBeenCalled();
  });
});
