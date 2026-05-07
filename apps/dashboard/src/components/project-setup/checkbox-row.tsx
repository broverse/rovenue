import type { ReactNode } from "react";
import { Checkbox } from "../../ui/checkbox";

type CheckboxRowProps = {
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  description?: ReactNode;
};

export function CheckboxRow({
  checked,
  onChange,
  title,
  description,
}: CheckboxRowProps) {
  return (
    <label className="flex items-start gap-2.5 py-2.5">
      <span className="mt-0.5">
        <Checkbox checked={checked} onChange={onChange} />
      </span>
      <span>
        <span className="block text-[13px] text-foreground">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-rv-mute-500">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
