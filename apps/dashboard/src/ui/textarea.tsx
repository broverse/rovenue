import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-[80px] w-full resize-y rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] leading-relaxed text-foreground transition placeholder:text-rv-mute-500 focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30",
          className,
        )}
        {...rest}
      />
    );
  },
);
