import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PaywallTreeOp } from "@rovenue/shared/paywall";
import { ApprovalCard } from "./approval-card";
import { RoviProvider } from "../rovi-provider";
import { useRovi } from "../../../lib/hooks/useRovi";

// =============================================================
// P8 §6.15 Task 5 — the Rovi->builder bridge, from ApprovalCard's side:
// on an executed `action_paywall_editTree` intent it forwards the op
// through `RoviProvider.dispatchPaywallPatch`; when no listener is
// registered (or the registered one refuses the op), it shows the
// "open the builder" fallback with a re-apply affordance instead of
// silently dropping the change (spec §3.3). ai-bridge.test.tsx covers
// the OTHER end (builder-shell registering/unregistering the listener).
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

const op: PaywallTreeOp = {
  kind: "insert",
  parentId: "root",
  index: 0,
  subtree: { type: "spacer", id: "sp1", size: 8 },
};

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
 *  register a patch listener while `active`, unregistering when it flips
 *  to `false` — mirrors what builder-shell.tsx does on mount/unmount. */
function Registrar({
  listener,
  active,
}: {
  listener: (op: PaywallTreeOp) => boolean;
  active: boolean;
}) {
  const { registerPaywallPatchListener } = useRovi();
  useEffect(() => {
    if (!active) return;
    return registerPaywallPatchListener(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
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

  it("forwards an executed action_paywall_editTree result to the registered listener", async () => {
    executeMutateAsync.mockResolvedValue({ op, paywallId: "pw_1" });
    const listener = vi.fn().mockReturnValue(true);

    render(
      <RoviProvider>
        <Registrar listener={listener} active />
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Applied to the builder.");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(op);
  });

  it("shows the fallback card with a re-apply button when no listener is registered", async () => {
    executeMutateAsync.mockResolvedValue({ op, paywallId: "pw_1" });

    render(
      <RoviProvider>
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open the paywall builder to apply this change.");
    expect(screen.getByRole("button", { name: "Re-apply" })).toBeInTheDocument();
  });

  it("renders the fallback state when the registered listener refuses the op", async () => {
    executeMutateAsync.mockResolvedValue({ op, paywallId: "pw_1" });
    const listener = vi.fn().mockReturnValue(false);

    render(
      <RoviProvider>
        <Registrar listener={listener} active />
        <ApprovalCard intent={editTreeIntent()} />
      </RoviProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open the paywall builder to apply this change.");
    expect(listener).toHaveBeenCalledWith(op);
  });

  it("re-apply retries the op once a listener is registered, moving out of the fallback state", async () => {
    executeMutateAsync.mockResolvedValue({ op, paywallId: "pw_1" });
    const listener = vi.fn().mockReturnValue(true);

    function Harness({ active }: { active: boolean }) {
      return (
        <RoviProvider>
          <Registrar listener={listener} active={active} />
          <ApprovalCard intent={editTreeIntent()} />
        </RoviProvider>
      );
    }

    const { rerender } = render(<Harness active={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));
    await screen.findByText("Open the paywall builder to apply this change.");
    expect(listener).not.toHaveBeenCalled();

    act(() => {
      rerender(<Harness active />);
    });

    fireEvent.click(screen.getByRole("button", { name: "Re-apply" }));

    await screen.findByText("Applied to the builder.");
    expect(listener).toHaveBeenCalledWith(op);
  });

  it("does not deliver the patch to a listener that unregistered before approval", async () => {
    executeMutateAsync.mockResolvedValue({ op, paywallId: "pw_1" });
    const listener = vi.fn().mockReturnValue(true);

    function Harness({ active }: { active: boolean }) {
      return (
        <RoviProvider>
          <Registrar listener={listener} active={active} />
          <ApprovalCard intent={editTreeIntent()} />
        </RoviProvider>
      );
    }

    const { rerender } = render(<Harness active />);
    act(() => {
      rerender(<Harness active={false} />); // unregister before approval
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve & Run" }));

    await screen.findByText("Open the paywall builder to apply this change.");
    expect(listener).not.toHaveBeenCalled();
  });
});
