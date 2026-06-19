import { createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Languages our developer-facing snippets use (SDK quickstart + hero
// healthcheck). Keep this list tight — each grammar adds to the lazily
// loaded highlighter. Add a language here before referencing it in a
// `<CodeBlock language=…>`; unknown languages fall back to plain text.
const LANGS = [
  "tsx",
  "typescript",
  "javascript",
  "bash",
  "swift",
  "kotlin",
  "json",
] as const;

// Dual theme: `defaultColor: false` emits `--shiki-light` / `--shiki-dark`
// CSS variables instead of hard colors, so a single highlight pass serves
// both modes. The `.dark` class next-themes sets on <html> selects which
// variable wins (see the `.rv-shiki` rules in index.css).
const THEMES = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

// The highlighter is expensive to construct (loads grammars + themes), so
// build it once and share the promise across every CodeBlock instance.
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [...LANGS],
      // JavaScript regex engine — no WASM to fetch/bundle. `forgiving`
      // keeps a grammar that hits an unsupported regex from throwing.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/**
 * Highlight `code` to dual-theme HTML. The caller injects the returned
 * markup; Shiki escapes the source, and we only ever pass our own static
 * snippets (never user input). Unregistered languages render as plain text
 * rather than throwing.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const language = (hl.getLoadedLanguages() as string[]).includes(lang)
    ? lang
    : "text";
  return hl.codeToHtml(code, {
    lang: language,
    themes: THEMES,
    defaultColor: false,
  });
}
