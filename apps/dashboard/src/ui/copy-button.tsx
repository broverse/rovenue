import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";

type Size = "xs" | "sm";

export type CopyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onCopy"> & {
  value: string;
  size?: Size;
  iconSize?: number;
  label?: ReactNode;
  copiedLabel?: ReactNode;
  onCopied?: (value: string) => void;
};

const SIZE_CLASS: Record<Size, string> = {
  xs: "h-6 px-1.5 text-[11px]",
  sm: "h-7 px-2 text-[12px]",
};

/**
 * Copy-to-clipboard button. Shows a check + "Copied" affordance for ~1.4s
 * after a successful write. Falls back silently when clipboard access fails.
 */
export function CopyButton({
  value,
  size = "sm",
  iconSize = 12,
  label,
  copiedLabel,
  className,
  onCopied,
  type = "button",
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.(value);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Permissions or non-secure context — fall back to no-op.
    }
  }, [onCopied, value]);

  const Icon = copied ? Check : Copy;
  return (
    <button
      type={type}
      onClick={handleCopy}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded border border-rv-divider bg-rv-c2 font-medium text-rv-mute-700 transition hover:border-rv-divider-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500",
        copied && "text-rv-success hover:text-rv-success",
        SIZE_CLASS[size],
        className,
      )}
      aria-live="polite"
      {...rest}
    >
      <Icon size={iconSize} />
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}
