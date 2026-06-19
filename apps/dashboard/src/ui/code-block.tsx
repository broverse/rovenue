import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { CopyButton } from "./copy-button";
import { highlightCode } from "../lib/shiki";

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

  // Syntax-highlight string snippets (not custom `children`) when a language
  // is known. Highlighting is async (the Shiki highlighter loads grammars on
  // first use), so we render the plain monospace `<pre>` until — and if —
  // highlighted markup is ready, which also covers the load-failure path.
  const shouldHighlight = Boolean(code && language && !children && !inline);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldHighlight) {
      setHighlighted(null);
      return;
    }
    let active = true;
    highlightCode(code!, language!)
      .then((html) => {
        if (active) setHighlighted(html);
      })
      .catch(() => {
        if (active) setHighlighted(null);
      });
    return () => {
      active = false;
    };
  }, [shouldHighlight, code, language]);

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
        {highlighted ? (
          <div
            className="rv-shiki overflow-x-auto px-3.5 py-3 font-rv-mono text-[12px] leading-relaxed"
            // Shiki escapes the source; inputs are our own static snippets,
            // never user-provided. See src/lib/shiki.ts.
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <pre
            className={cn(
              "px-3.5 py-3 font-rv-mono text-[12px] leading-relaxed text-foreground",
              inline ? "overflow-x-auto whitespace-nowrap" : "overflow-x-auto whitespace-pre",
            )}
          >
            {children ?? code}
          </pre>
        )}
      </div>
      {caption ? <div className="text-[11px] text-rv-mute-500">{caption}</div> : null}
    </div>
  );
}
