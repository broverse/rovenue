import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { CopyButton } from "./copy-button";

type CodeBlockProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  /** Source to copy AND render. Use `children` instead if you want to */
  /** highlight or annotate parts of the snippet visually. */
  code?: string;
  /** Override the value placed on the clipboard when `children` is set. */
  copyValue?: string;
  language?: string;
  filename?: ReactNode;
  copyLabel?: ReactNode;
  copiedLabel?: ReactNode;
  /** Disable scroll + keep the snippet on a single line. */
  inline?: boolean;
  /** Render a subdued caption underneath the block. */
  caption?: ReactNode;
};

/**
 * Mono-font code surface with an optional toolbar (filename + language chip)
 * and a copy button anchored to the top-right. Use this anywhere we surface
 * developer-facing snippets or terminal commands.
 */
export function CodeBlock({
  code,
  copyValue,
  language,
  filename,
  copyLabel,
  copiedLabel,
  inline = false,
  caption,
  children,
  className,
  ...rest
}: CodeBlockProps) {
  const value = copyValue ?? code ?? "";
  const showHeader = Boolean(filename || language);

  return (
    <div className={cn("flex flex-col gap-1.5", className)} {...rest}>
      <div className="relative overflow-hidden rounded-md border border-rv-divider bg-rv-c2">
        {showHeader ? (
          <div className="flex items-center justify-between border-b border-rv-divider bg-rv-c1 px-3 py-1.5">
            <div className="flex items-center gap-2 text-[11px] text-rv-mute-600">
              {filename ? <span className="font-rv-mono">{filename}</span> : null}
              {language ? (
                <span className="rounded border border-rv-divider bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
                  {language}
                </span>
              ) : null}
            </div>
            <CopyButton
              size="xs"
              value={value}
              label={copyLabel}
              copiedLabel={copiedLabel}
            />
          </div>
        ) : (
          <div className="absolute right-2 top-2 z-10">
            <CopyButton
              size="xs"
              value={value}
              label={copyLabel}
              copiedLabel={copiedLabel}
            />
          </div>
        )}
        <pre
          className={cn(
            "px-3.5 py-3 font-rv-mono text-[12px] leading-relaxed text-foreground",
            inline ? "overflow-x-auto whitespace-nowrap" : "overflow-x-auto whitespace-pre",
          )}
        >
          {children ?? code}
        </pre>
      </div>
      {caption ? <div className="text-[11px] text-rv-mute-500">{caption}</div> : null}
    </div>
  );
}
