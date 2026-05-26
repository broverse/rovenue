import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

// =============================================================
// Lightweight click-away dropdown menu
// =============================================================
//
// Built without Radix so we don't drag a popper engine into the
// bundle for a thin surface. Caller owns the trigger via the
// `trigger` render prop. Closes on outside click, Escape, and
// after any item click.

export interface MenuProps {
  trigger: (open: boolean) => ReactNode;
  align?: "start" | "end";
  className?: string;
  children: (close: () => void) => ReactNode;
}

export function Menu({
  trigger,
  align = "end",
  className,
  children,
}: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleMouse = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouse);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouse);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={ref} className="relative inline-flex">
      <div onClick={() => setOpen((o) => !o)} className="inline-flex">
        {trigger(open)}
      </div>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-20 mt-1 min-w-[180px] rounded-md border border-rv-divider bg-rv-c1 p-1 shadow-lg",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  tone?: "default" | "danger";
};

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  function MenuItem(
    { icon, tone = "default", className, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition disabled:cursor-not-allowed disabled:opacity-50",
          tone === "danger"
            ? "text-rv-danger hover:bg-rv-danger/10"
            : "text-rv-mute-800 hover:bg-rv-c2 hover:text-foreground",
          className,
        )}
        {...rest}
      >
        {icon ? <span className="text-rv-mute-500">{icon}</span> : null}
        <span className="flex-1">{children}</span>
      </button>
    );
  },
);

export function MenuSeparator() {
  return <div className="my-1 h-px bg-rv-divider" />;
}

/**
 * Three-dot icon button trigger — convenience export so callers
 * don't have to wire `<Button variant="light" size="icon">` by hand
 * each time.
 */
export const MenuTriggerButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { ariaLabel: string }
>(function MenuTriggerButton({ ariaLabel, children, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      variant="light"
      size="icon"
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </Button>
  );
});
