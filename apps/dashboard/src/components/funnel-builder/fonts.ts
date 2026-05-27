// Font catalog used by the theme tab's Typography panel and consumed by
// PagePreview to actually render with the selected face. `family` is the
// CSS font-family stack stored in Theme.font; `google` is the upstream
// Google Fonts family name used to lazy-inject a stylesheet link the
// first time a face is selected. Faces without `google` are assumed to
// be system-resident.

export type FontCategory = "System" | "Sans Serif" | "Serif" | "Display" | "Monospace";

export type FontOption = {
  label: string;
  family: string;
  category: FontCategory;
  google?: string;
};

export const FONT_OPTIONS: ReadonlyArray<FontOption> = [
  {
    label: "System default",
    family: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    category: "System",
  },
  {
    label: "SF Pro",
    family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    category: "System",
  },

  { label: "Inter", family: "'Inter', system-ui, sans-serif", category: "Sans Serif", google: "Inter" },
  { label: "Geist", family: "'Geist', system-ui, sans-serif", category: "Sans Serif", google: "Geist" },
  { label: "Roboto", family: "'Roboto', system-ui, sans-serif", category: "Sans Serif", google: "Roboto" },
  { label: "Open Sans", family: "'Open Sans', system-ui, sans-serif", category: "Sans Serif", google: "Open Sans" },
  { label: "Poppins", family: "'Poppins', system-ui, sans-serif", category: "Sans Serif", google: "Poppins" },
  { label: "Montserrat", family: "'Montserrat', system-ui, sans-serif", category: "Sans Serif", google: "Montserrat" },
  { label: "Lato", family: "'Lato', system-ui, sans-serif", category: "Sans Serif", google: "Lato" },
  { label: "Nunito", family: "'Nunito', system-ui, sans-serif", category: "Sans Serif", google: "Nunito" },
  { label: "DM Sans", family: "'DM Sans', system-ui, sans-serif", category: "Sans Serif", google: "DM Sans" },
  { label: "Manrope", family: "'Manrope', system-ui, sans-serif", category: "Sans Serif", google: "Manrope" },
  { label: "Plus Jakarta Sans", family: "'Plus Jakarta Sans', system-ui, sans-serif", category: "Sans Serif", google: "Plus Jakarta Sans" },
  { label: "Work Sans", family: "'Work Sans', system-ui, sans-serif", category: "Sans Serif", google: "Work Sans" },
  { label: "Outfit", family: "'Outfit', system-ui, sans-serif", category: "Sans Serif", google: "Outfit" },
  { label: "Sora", family: "'Sora', system-ui, sans-serif", category: "Sans Serif", google: "Sora" },
  { label: "Figtree", family: "'Figtree', system-ui, sans-serif", category: "Sans Serif", google: "Figtree" },
  { label: "Space Grotesk", family: "'Space Grotesk', system-ui, sans-serif", category: "Sans Serif", google: "Space Grotesk" },
  { label: "IBM Plex Sans", family: "'IBM Plex Sans', system-ui, sans-serif", category: "Sans Serif", google: "IBM Plex Sans" },
  { label: "Onest", family: "'Onest', system-ui, sans-serif", category: "Sans Serif", google: "Onest" },

  { label: "Lora", family: "'Lora', Georgia, serif", category: "Serif", google: "Lora" },
  { label: "Merriweather", family: "'Merriweather', Georgia, serif", category: "Serif", google: "Merriweather" },
  { label: "Source Serif 4", family: "'Source Serif 4', Georgia, serif", category: "Serif", google: "Source Serif 4" },
  { label: "Fraunces", family: "'Fraunces', Georgia, serif", category: "Serif", google: "Fraunces" },

  { label: "Playfair Display", family: "'Playfair Display', Georgia, serif", category: "Display", google: "Playfair Display" },
  { label: "DM Serif Display", family: "'DM Serif Display', Georgia, serif", category: "Display", google: "DM Serif Display" },
  { label: "Bricolage Grotesque", family: "'Bricolage Grotesque', system-ui, sans-serif", category: "Display", google: "Bricolage Grotesque" },

  { label: "JetBrains Mono", family: "'JetBrains Mono', ui-monospace, monospace", category: "Monospace", google: "JetBrains Mono" },
  { label: "Fira Code", family: "'Fira Code', ui-monospace, monospace", category: "Monospace", google: "Fira Code" },
  { label: "IBM Plex Mono", family: "'IBM Plex Mono', ui-monospace, monospace", category: "Monospace", google: "IBM Plex Mono" },
  { label: "Geist Mono", family: "'Geist Mono', ui-monospace, monospace", category: "Monospace", google: "Geist Mono" },
];

export const CATEGORY_ORDER: ReadonlyArray<FontCategory> = [
  "System",
  "Sans Serif",
  "Serif",
  "Display",
  "Monospace",
];

export const DEFAULT_FONT_FAMILY = FONT_OPTIONS[2].family;

export function findFontOption(family: string | undefined): FontOption | undefined {
  if (!family) return undefined;
  return FONT_OPTIONS.find((o) => o.family === family);
}

const loaded = new Set<string>();

export function loadFontFamily(family: string | undefined): void {
  if (!family || typeof document === "undefined") return;
  const opt = findFontOption(family);
  if (!opt?.google || loaded.has(opt.google)) return;
  loaded.add(opt.google);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(opt.google).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}
