import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

export type RoviContextValue = {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
  currentThreadId: string | null;
  setCurrentThreadId: (id: string | null) => void;
};

export const RoviContext = createContext<RoviContextValue | null>(null);

const STORAGE_KEY = "rovi:open";

export function RoviProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);

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
    () => ({ open, toggle, setOpen, currentThreadId, setCurrentThreadId }),
    [open, toggle, setOpen, currentThreadId],
  );

  return <RoviContext.Provider value={value}>{children}</RoviContext.Provider>;
}
