import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Kbd } from "./kbd";

export const searchInputVariants = cva(
  "flex items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500",
  {
    variants: {
      size: {
        sm: "h-7",
        md: "h-[30px]",
        lg: "h-9",
      },
    },
    defaultVariants: { size: "md" },
  },
);

type Native = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "onChange" | "value">;

export type SearchInputProps = Native &
  VariantProps<typeof searchInputVariants> & {
    value: string;
    onValueChange: (next: string) => void;
    /** Show a "/" hint chip on the right. */
    showSlashHint?: boolean;
    rootClassName?: string;
  };

/**
 * Search field used across pages. Search icon on the left, clear `×` button
 * appears once the input has content. Optional `/` keyboard hint on the
 * right that pages can wire up to a global focus shortcut.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onValueChange, size, showSlashHint, className, rootClassName, ...rest },
  ref,
) {
  return (
    <label className={cn(searchInputVariants({ size }), rootClassName)}>
      <Search size={12} className="text-rv-mute-500" />
      <input
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none",
          className,
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="Clear search"
          className="cursor-pointer text-rv-mute-500 transition hover:text-foreground"
        >
          <X size={12} />
        </button>
      )}
      {showSlashHint && !value && <Kbd>/</Kbd>}
    </label>
  );
});
