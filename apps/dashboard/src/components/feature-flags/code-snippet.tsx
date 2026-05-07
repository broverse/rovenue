import { useMemo } from "react";
import type { FeatureFlag } from "./types";

type Props = {
  flag: FeatureFlag;
};

const KEYWORDS = new Set(["const", "if", "return", "true", "false"]);

/**
 * Tiny SDK call snippet, hand-tokenized so we can theme it without pulling
 * in a syntax-highlighter dependency.
 */
export function CodeSnippet({ flag }: Props) {
  const code = useMemo(() => buildSnippet(flag), [flag]);
  const tokens = useMemo(() => tokenize(code), [code]);

  return (
    <pre className="m-0 overflow-x-auto rounded-md border border-rv-divider bg-[#06060A] p-3.5 font-rv-mono text-[11px] leading-[1.55] text-rv-mute-700">
      <code>
        {tokens.map((tok, i) => {
          if (tok.kind === "comment") {
            return (
              <span key={i} className="text-rv-mute-500">
                {tok.text}
              </span>
            );
          }
          if (tok.kind === "string") {
            return (
              <span key={i} className="text-[#86efac]">
                {tok.text}
              </span>
            );
          }
          if (tok.kind === "keyword") {
            return (
              <span key={i} className="text-rv-accent-400">
                {tok.text}
              </span>
            );
          }
          if (tok.kind === "number") {
            return (
              <span key={i} className="text-[#fbbf24]">
                {tok.text}
              </span>
            );
          }
          return <span key={i}>{tok.text}</span>;
        })}
      </code>
    </pre>
  );
}

function buildSnippet(flag: FeatureFlag): string {
  switch (flag.type) {
    case "bool":
      return `const enabled = rovenue.flag('${flag.key}', { defaultValue: false });\nif (enabled) {\n  showNewPaywall();\n}`;
    case "string":
      return `const variant = rovenue.flag('${flag.key}', {\n  defaultValue: 'save_40',\n});\nrenderHeadline(variant);`;
    case "number":
      return `const limit = rovenue.flag('${flag.key}', { defaultValue: 1 });\nif (genCount >= limit) showPaywall();`;
    case "json":
      return `const theme = rovenue.flag('${flag.key}', {\n  defaultValue: { accent: '#3B82F6' },\n});\napplyTheme(theme);`;
  }
}

type Token = { kind: "comment" | "string" | "keyword" | "number" | "plain"; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      tokens.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      flush();
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: "comment", text: source.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      flush();
      const quote = ch;
      let end = i + 1;
      while (end < source.length && source[end] !== quote) end++;
      tokens.push({ kind: "string", text: source.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
      const word = source.slice(i, end);
      tokens.push({
        kind: KEYWORDS.has(word) ? "keyword" : "plain",
        text: word,
      });
      i = end;
      continue;
    }
    if (/\d/.test(ch)) {
      let end = i;
      while (end < source.length && /\d/.test(source[end])) end++;
      tokens.push({ kind: "number", text: source.slice(i, end) });
      i = end;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return tokens;
}
