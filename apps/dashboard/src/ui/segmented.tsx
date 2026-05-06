import { cva, type VariantProps } from "class-variance-authority";
import { RadioGroup } from "@base-ui-components/react/radio-group";
import { Radio } from "@base-ui-components/react/radio";
import { cn } from "../lib/cn";

export const segmentedItemVariants = cva(
  "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-rv-c2 data-[checked]:bg-rv-c4 data-[checked]:text-foreground text-rv-mute-600 hover:text-foreground",
  {
    variants: {
      // Reserved for future tonal variants of the segmented control.
      tone: {
        default: "",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

export type SegmentedProps<T extends string> = VariantProps<typeof segmentedItemVariants> & {
  options: ReadonlyArray<T>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  className?: string;
};

/**
 * Radio-style segmented control — Base UI RadioGroup under the hood, so
 * arrow keys / Home / End / focus-visible are handled for free.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  tone,
  className,
}: SegmentedProps<T>) {
  return (
    <RadioGroup
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className={cn(
        "inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5",
        className,
      )}
    >
      {options.map((opt) => (
        <Radio.Root key={opt} value={opt} className={segmentedItemVariants({ tone })}>
          {opt}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
