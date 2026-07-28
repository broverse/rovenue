import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaywallTreeOp } from "@rovenue/shared/paywall";

/**
 * What the currently-open page wants Rovi to know about. Threaded into
 * `useRoviChat`'s request body as `context.paywallId`/`context.focusedEntityId`
 * (see spec §3.1) — `paywallId` identifies the open paywall builder itself
 * (what the backend's paywall-context block is keyed on — see
 * `system-prompt.ts`'s `paywallBlock`); `focusedEntityId` tracks the
 * selected NODE within it, mentioned as an extra sentence in that same
 * block so the model can ground a proposed edit against the exact node the
 * author is looking at. The two are deliberately separate fields — a node
 * id is never a valid `paywallId`.
 */
export type RoviChatContext = {
  paywallId?: string;
  focusedEntityId?: string;
};

export type RoviContextValue = {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
  currentThreadId: string | null;
  setCurrentThreadId: (id: string | null) => void;
  chatContext: RoviChatContext;
  setChatContext: (ctx: RoviChatContext) => void;
  /**
   * Rovi → builder bridge (spec §3.3), PAYWALL-SCOPED. The builder VM
   * registers a listener keyed to the paywall it's editing while mounted;
   * `ApprovalCard` forwards an executed `action_paywall_editTree` result
   * through `dispatchPaywallPatch`, passing the op's OWN `paywallId` (from
   * the intent execute result, never the currently-open route/thread) —
   * `dispatchPaywallPatch` only invokes the listener when it matches.
   * Without this check, navigating to a different paywall's builder after
   * approving an op for paywall A (or approving while B is already open)
   * would silently apply A's op to B: every paywall's root node id is
   * literally `"root"`, so an "insert under root" op is valid — and wrong —
   * for any paywall. Only the most recently registered listener is live —
   * the builder route is keyed per paywall so at most one builder is ever
   * mounted at a time.
   */
  registerPaywallPatchListener: (paywallId: string, fn: (op: PaywallTreeOp) => boolean) => () => void;
  /** Invokes the registered listener ONLY when its registered `paywallId`
   *  matches. Returns `false` (never throws) when no builder is mounted, or
   *  the mounted builder is for a different paywall than the op targets. */
  dispatchPaywallPatch: (op: PaywallTreeOp, paywallId: string) => boolean;
};

export const RoviContext = createContext<RoviContextValue | null>(null);

const STORAGE_KEY = "rovi:open";

export function RoviProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [chatContext, setChatContextState] = useState<RoviChatContext>({});
  const setChatContext = useCallback((ctx: RoviChatContext) => {
    setChatContextState(ctx);
  }, []);

  // A ref, not state: the listener is a callback the builder VM owns, not
  // something the panel re-renders on. Only the most recently registered
  // listener wins — see `registerPaywallPatchListener`'s doc comment above.
  // Keyed by `paywallId` so a patch destined for a different (or
  // no-longer-open) paywall is refused rather than silently misapplied.
  const patchListenerRef = useRef<{ paywallId: string; fn: (op: PaywallTreeOp) => boolean } | null>(
    null,
  );

  const registerPaywallPatchListener = useCallback(
    (paywallId: string, fn: (op: PaywallTreeOp) => boolean) => {
      const entry = { paywallId, fn };
      patchListenerRef.current = entry;
      return () => {
        if (patchListenerRef.current === entry) patchListenerRef.current = null;
      };
    },
    [],
  );

  const dispatchPaywallPatch = useCallback((op: PaywallTreeOp, paywallId: string) => {
    const entry = patchListenerRef.current;
    if (!entry || entry.paywallId !== paywallId) return false;
    return entry.fn(op);
  }, []);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    }
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘ . (period) — toggle
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        toggle();
      }
      // Esc — close
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, open, setOpen]);

  const value = useMemo<RoviContextValue>(
    () => ({
      open,
      toggle,
      setOpen,
      currentThreadId,
      setCurrentThreadId,
      chatContext,
      setChatContext,
      registerPaywallPatchListener,
      dispatchPaywallPatch,
    }),
    [
      open,
      toggle,
      setOpen,
      currentThreadId,
      chatContext,
      setChatContext,
      registerPaywallPatchListener,
      dispatchPaywallPatch,
    ],
  );

  return <RoviContext.Provider value={value}>{children}</RoviContext.Provider>;
}
