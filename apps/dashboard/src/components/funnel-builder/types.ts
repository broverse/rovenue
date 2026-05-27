import type { LucideIcon } from "lucide-react";
import {
  AlignLeft,
  Calendar,
  CheckSquare,
  Circle,
  CircleDot,
  Contact,
  CreditCard,
  Flag,
  Gauge,
  Hand,
  Hash,
  Hourglass,
  Image as ImageIcon,
  Info,
  Mail,
  MessageSquare,
  PartyPopper,
  Phone,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareCheck,
  Star,
  Type as TypeIcon,
} from "lucide-react";

export type PageType =
  // Original primitives
  | "single_choice"
  | "multi_choice"
  | "text_input"
  | "number_input"
  | "date_input"
  | "slider"
  | "rating"
  | "info"
  | "loading"
  | "result"
  | "paywall"
  | "success"
  // Contact info
  | "contact_info"
  | "email"
  | "phone"
  // Choice extras
  | "picture_choice"
  | "yes_no"
  | "legal"
  | "checkbox"
  // Rating & ranking
  | "opinion_scale"
  // Text & video
  | "long_text"
  | "short_text"
  // Conversion / framing
  | "welcome"
  | "statement"
  | "feature"
  | "end_screen";

export type PageTone = "" | "result" | "paywall" | "success";

export type PageTypeMeta = {
  label: string;
  icon: LucideIcon;
  tone: PageTone;
};

export const PAGE_TYPES: Record<PageType, PageTypeMeta> = {
  single_choice: { label: "Single choice", icon: Circle, tone: "" },
  multi_choice: { label: "Multiple choice", icon: SquareCheck, tone: "" },
  text_input: { label: "Text input", icon: TypeIcon, tone: "" },
  number_input: { label: "Number input", icon: Hash, tone: "" },
  date_input: { label: "Date", icon: Calendar, tone: "" },
  slider: { label: "Slider", icon: SlidersHorizontal, tone: "" },
  rating: { label: "Rating", icon: Star, tone: "" },
  info: { label: "Info screen", icon: Info, tone: "" },
  loading: { label: "Loading", icon: Hourglass, tone: "" },
  result: { label: "Personalized result", icon: Sparkles, tone: "result" },
  paywall: { label: "Payment screen", icon: CreditCard, tone: "paywall" },
  success: { label: "Success", icon: PartyPopper, tone: "success" },

  contact_info: { label: "Contact info", icon: Contact, tone: "" },
  email: { label: "Email", icon: Mail, tone: "" },
  phone: { label: "Phone number", icon: Phone, tone: "" },

  picture_choice: { label: "Picture choice", icon: ImageIcon, tone: "" },
  yes_no: { label: "Yes/No", icon: CircleDot, tone: "" },
  legal: { label: "Legal", icon: ShieldCheck, tone: "" },
  checkbox: { label: "Checkbox", icon: CheckSquare, tone: "" },

  opinion_scale: { label: "Opinion scale", icon: Gauge, tone: "" },

  long_text: { label: "Long text", icon: AlignLeft, tone: "" },
  short_text: { label: "Short text", icon: TypeIcon, tone: "" },

  welcome: { label: "Welcome screen", icon: Hand, tone: "" },
  statement: { label: "Statement screen", icon: MessageSquare, tone: "" },
  feature: { label: "Feature screen", icon: Sparkles, tone: "" },
  end_screen: { label: "End screen", icon: Flag, tone: "success" },
};

export const PAGE_TYPE_DESC: Record<PageType, string> = {
  single_choice: "Pick one",
  multi_choice: "Pick many",
  text_input: "Free text",
  number_input: "Numeric",
  date_input: "Calendar",
  slider: "Range",
  rating: "Stars 1–5",
  info: "Static screen",
  loading: "Fake wait",
  result: "Personalized",
  paywall: "Stripe checkout",
  success: "Final hand-off",

  contact_info: "Name · email · phone",
  email: "Email address",
  phone: "Phone number",

  picture_choice: "Choice with images",
  yes_no: "Binary answer",
  legal: "Accept terms",
  checkbox: "Single checkbox",

  opinion_scale: "1–5 scale",

  long_text: "Multi-line",
  short_text: "Single-line",

  welcome: "Splash + start",
  statement: "Message + continue",
  feature: "Feature showcase",
  end_screen: "Goodbye screen",
};

export const PAGE_GROUPS: ReadonlyArray<{ label: string; types: PageType[] }> = [
  {
    label: "Page elements",
    types: ["welcome", "statement", "feature", "info", "loading", "result", "paywall", "end_screen", "success"],
  },
  {
    label: "Contact info",
    types: ["contact_info", "email", "phone"],
  },
  {
    label: "Choice",
    types: ["multi_choice", "single_choice", "picture_choice", "yes_no", "legal", "checkbox"],
  },
  {
    label: "Rating & ranking",
    types: ["opinion_scale", "rating"],
  },
  {
    label: "Text & Video",
    types: ["long_text", "short_text"],
  },
  {
    label: "Other",
    types: ["date_input", "number_input", "slider"],
  },
];

export type Operator =
  | "equals"
  | "not_equals"
  | ">"
  | ">="
  | "<"
  | "<="
  | "between"
  | "is_one_of"
  | "not_one_of"
  | "contains"
  | "is_answered"
  | "not_answered";

export const OPERATORS: ReadonlyArray<{ v: Operator; l: string }> = [
  { v: "equals", l: "equals" },
  { v: "not_equals", l: "≠" },
  { v: ">", l: ">" },
  { v: ">=", l: "≥" },
  { v: "<", l: "<" },
  { v: "<=", l: "≤" },
  { v: "between", l: "between" },
  { v: "is_one_of", l: "is one of" },
  { v: "not_one_of", l: "is not one of" },
  { v: "contains", l: "contains" },
  { v: "is_answered", l: "is answered" },
  { v: "not_answered", l: "is not answered" },
];

export type RuleClause = {
  qid: string;
  op: Operator;
  value: string | number | Array<string | number>;
};

export type Rule = {
  id: string;
  combinator: "all" | "any";
  clauses: RuleClause[];
  goto: string;
};

export type Option = { label: string; value: string; imageUrl?: string };

export type Page = {
  id: string;
  type: PageType;
  question_id?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  cta?: string;
  required?: boolean;
  branchCount?: number;
  validation_errors?: number;
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  format?: string;
  max_selections?: number;
  duration?: number;
  steps?: string[];
  headline?: string;
  productId?: string;
  trial?: number;
  benefits?: string[];
  // Optional media displayed above the question on the preview.
  // Driven by the Text / Image / Video segmented control in the sidebar.
  mediaKind?: "none" | "image" | "video";
  mediaUrl?: string;
  // Inputs
  placeholder?: string;
  // contact_info — which sub-fields are required
  collectName?: boolean;
  collectEmail?: boolean;
  collectPhone?: boolean;
  // legal — agreement label + link
  agreementLabel?: string;
  termsUrl?: string;
  // feature — a list of feature lines (headline already on .headline)
  features?: string[];
  // statement — the body text already lives on .body

  // ----- Per-page design overrides -----
  /** Full-bleed background behind the page content. Overrides theme.bg. */
  background?: PageBackground;
  /** Optional sticky footer that lives below the primary CTA button. */
  footer?: PageFooter;
  /** Show the progress indicator on this page. Defaults to false. */
  showProgress?: boolean;
  /** Show the back button on this page. Defaults to false. */
  showBack?: boolean;
  /** Override the theme default border-radius for this page. */
  radius?: number;
};

export type PageBackground = {
  kind: "none" | "color" | "image" | "video";
  /** color hex, or absolute URL for image/video */
  value: string;
  /** 0..1 — overlay applied on top of the background, multiplied with the bg colour */
  opacity: number;
};

export type PageFooter = {
  enabled: boolean;
  bgColor?: string;
  borderColor?: string;
  borderWidth?: number;
  // Background color of the primary CTA button inside the footer band.
  // Falls back to `theme.primary` when blank.
  buttonColor?: string;
};

export type ProgressStyle = "solid" | "segmented" | "dashed" | "rounded";
export type BackIcon = "chevron" | "arrow";

export type Theme = {
  primary: string;
  accent: string;
  bg: string;
  text: string;
  font: string;
  logoUrl: string;
  logoLetter: string;
  /** Visual variant for the per-page progress indicator. */
  progressStyle: ProgressStyle;
  /** Active (filled) color for progress. Falls back to `primary` when empty. */
  progressActive: string;
  /** Inactive (track) color for progress. */
  progressInactive: string;
  /** Which glyph to use for the per-page back button. */
  backIcon: BackIcon;
  /** Default border-radius (in px) for CTA, choice tiles, inputs, media. */
  radius: number;
};

export type Settings = {
  iosUrl: string;
  androidUrl: string;
  universalLinkDomain: string;
  deepLinkScheme: string;
  devMode: boolean;
};

export type Funnel = {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  version: number;
  draftDiffersFromPublished: boolean;
  theme: Theme;
  settings: Settings;
  pages: Page[];
  rules: Record<string, Rule[]>;
  default_next: Record<string, string | null>;
};

export type ValidationIssue = {
  kind: "error" | "warning";
  where: string;
  title: string;
  desc: string;
  fix: string;
};

export type Version = {
  num: number;
  when: string;
  date: string;
  who: string;
  pages: number;
  isCurrent?: boolean;
  notes: string;
};

export type Session = {
  id: string;
  started: string;
  last: string;
  state: "in_progress" | "paid" | "abandoned" | "completed";
  currentPage: string;
  utm: string;
  answers: number;
  paid: string | null;
};

export type TabId = "content" | "workflow" | "theme" | "settings" | "sessions" | "share";

export const TABS: ReadonlyArray<{ id: TabId; label: string; hint: string; pip?: boolean }> = [
  { id: "content", label: "Content", hint: "Build pages & flow" },
  { id: "workflow", label: "Workflow", hint: "Branching & rules", pip: true },
  { id: "theme", label: "Theme", hint: "Brand & colors" },
  { id: "settings", label: "Settings", hint: "Store URLs, hand-off" },
  { id: "sessions", label: "Analytics", hint: "Live runs & metrics" },
  { id: "share", label: "Share", hint: "URL, QR, snippets" },
];

/** Convert dashboard's flat Page into the shared validator/evaluator shape. */
export function toEvalPage(
  p: Page,
  rules?: unknown[],
  defaultNext?: string,
): {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: unknown[];
  default_next?: string;
} {
  return {
    id: p.id,
    type: p.type,
    config: {
      question_id: p.question_id,
      title: p.title,
      subtitle: p.subtitle,
      headline: p.headline,
      body_markdown: p.body,
      body: p.body,
      options: p.options,
      min: p.min,
      max: p.max,
      step: p.step,
      suffix: p.suffix,
      duration_ms: p.duration,
      steps: p.steps,
      product_id: p.productId,
      bullets: p.benefits,
      open_app_label: p.cta,
    },
    next_rules: rules,
    default_next: defaultNext,
  };
}
