import type { LucideIcon } from "lucide-react";
import {
  Calendar,
  Circle,
  Hash,
  Hourglass,
  Info,
  Lock,
  PartyPopper,
  SlidersHorizontal,
  Sparkles,
  SquareCheck,
  Star,
  Type as TypeIcon,
} from "lucide-react";

export type PageType =
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
  | "success";

export type PageTone = "" | "result" | "paywall" | "success";

export type PageTypeMeta = {
  label: string;
  icon: LucideIcon;
  tone: PageTone;
};

export const PAGE_TYPES: Record<PageType, PageTypeMeta> = {
  single_choice: { label: "Single choice", icon: Circle, tone: "" },
  multi_choice: { label: "Multi choice", icon: SquareCheck, tone: "" },
  text_input: { label: "Text input", icon: TypeIcon, tone: "" },
  number_input: { label: "Number input", icon: Hash, tone: "" },
  date_input: { label: "Date", icon: Calendar, tone: "" },
  slider: { label: "Slider", icon: SlidersHorizontal, tone: "" },
  rating: { label: "Rating", icon: Star, tone: "" },
  info: { label: "Info screen", icon: Info, tone: "" },
  loading: { label: "Loading", icon: Hourglass, tone: "" },
  result: { label: "Personalized result", icon: Sparkles, tone: "result" },
  paywall: { label: "Paywall", icon: Lock, tone: "paywall" },
  success: { label: "Success", icon: PartyPopper, tone: "success" },
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
};

export const PAGE_GROUPS: ReadonlyArray<{ label: string; types: PageType[] }> = [
  {
    label: "Question",
    types: [
      "single_choice",
      "multi_choice",
      "text_input",
      "number_input",
      "date_input",
      "slider",
      "rating",
    ],
  },
  { label: "Content", types: ["info", "loading", "result"] },
  { label: "Conversion", types: ["paywall", "success"] },
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

export type Option = { label: string; value: string };

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
};

export type Theme = {
  primary: string;
  accent: string;
  bg: string;
  text: string;
  font: string;
  logoUrl: string;
  logoLetter: string;
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
  { id: "sessions", label: "Sessions", hint: "Live runs" },
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
