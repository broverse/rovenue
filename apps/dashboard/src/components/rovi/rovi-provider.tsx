import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaywallTreeOp } from "@rovenue/shared/paywall";

/**
 * What the currently-open page wants Rovi to know about. Threaded into
 * `useRoviChat`'s request body as `context.focusedEntityId` (see spec
 * §3.1) — `paywallId` identifies the open paywall builder, `focusedEntityId`
 * tracks the selected node within it so the model can ground a proposed
 * edit against the exact node the author is looking at.
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
   * Rovi → builder bridge (spec §3.3). The builder VM registers a listener
   * while mounted; `ApprovalCard` forwards an executed
   * `action_paywall_editTree` result through `dispatchPaywallPatch`. Only
   * the most recently registered listener is live — the builder route is
   * keyed per paywall so at most one builder is ever mounted at a time.
   */
  registerPaywallPatchListener: (fn: (op: PaywallTreeOp) => boolean) => () => void;
  /** Invokes the registered listener, if any. Returns `false` (never throws)
   *  when no builder is mounted to receive the patch. */
  dispatchPaywallPatch: (op: PaywallTreeOp) => boolean;
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
  const patchListenerRef = useRef<((op: PaywallTreeOp) => boolean) | null>(null);

  const registerPaywallPatchListener = useCallback(
    (fn: (op: PaywallTreeOp) => boolean) => {
      patchListenerRef.current = fn;
      return () => {
        if (patchListenerRef.current === fn) patchListenerRef.current = null;
      };
    },
    [],
  );

  const dispatchPaywallPatch = useCallback((op: PaywallTreeOp) => {
    const listener = patchListenerRef.current;
    if (!listener) return false;
    return listener(op);
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
