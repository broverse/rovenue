import type { ReactNode } from "react";

type StepHeadProps = {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
};

export function StepHead({ eyebrow, title, description }: StepHeadProps) {
  return (
    <div className="mb-7">
      <div className="mb-1.5 font-rv-mono text-[11px] uppercase tracking-wider text-rv-accent-400">
        {eyebrow}
      </div>
      <h1 className="mb-1.5 text-[26px] font-semibold leading-tight tracking-tight text-foreground">
        {title}
      </h1>
      <p className="text-[14px] leading-relaxed text-rv-mute-500">{description}</p>
    </div>
  );
}
