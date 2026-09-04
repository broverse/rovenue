import type { BuilderConfig } from "@rovenue/shared/paywall";
import {
  compose,
  countdownBanner,
  featureRows,
  footer,
  headline,
  heroImage,
  packages,
  purchaseCta,
  screenshotCarousel,
  socialProof,
  spacer,
  trialTimeline,
  videoHero,
} from "./template-kit";

// =============================================================
// The paywall template catalogue offered by the builder's "new paywall"
// flow. Each entry is a short composition of `template-kit` sections
// plus its own copy — never a hand-written node tree.
//
// Three constraints hold for EVERY entry, enforced over the whole
// catalogue by `templates.test.ts`:
//
//   1. No project data. No package ids, no `defaultSelected` — a
//      `packageList` carries `packageIds: []`, which means "every package
//      in the offering", so a template validates against ANY offering.
//      `FOREIGN_PACKAGE_ID` rejects anything else.
//   2. No asset URLs. Asset-CDN URLs are `{projectId}/{assetId}.{ext}`,
//      so a baked URL would point every project at one project's private
//      storage prefix. Media nodes ship `{ light: "" }`.
//   3. Every localization key a template references has copy in the
//      default locale — a template missing copy for a key it uses renders
//      blank and would otherwise ship silently.
//
// Because of 2, and because a template cannot know a project's real legal
// URLs, every template legitimately raises the three PLACEHOLDER issue
// codes below. They are publish-tier, never save-tier: a template applies
// and edits freely, and cannot be published until the author fills the
// placeholders in. That is the whole design, so the catalogue test
// asserts these codes are RAISED, not merely tolerated.
// =============================================================

/**
 * The only validator issue codes a template may raise.
 *
 * - `LOCALE_KEY_GAP` — a template ships copy in its default locale only;
 *   every other locale the author adds starts empty, which is a warning.
 * - `EMPTY_MEDIA_URL` — image/video/lottie placeholders (constraint 2).
 * - `EMPTY_ACTION_URL` — the footer's Terms and Privacy links, which no
 *   template can fill in on the project's behalf.
 *
 * Anything else means a template is doing something it must not.
 */
export const TEMPLATE_PLACEHOLDER_ISSUE_CODES = [
  "LOCALE_KEY_GAP",
  "EMPTY_MEDIA_URL",
  "EMPTY_ACTION_URL",
] as const;

export type TemplateCategory =
  | "minimal"
  | "featureLed"
  | "comparison"
  | "trialLed"
  | "urgency"
  | "mediaLed";

export interface PaywallTemplate {
  id: string;
  /** Display name. */
  name: string;
  /** Short badge shown on the gallery card — why an author would pick this one. */
  tag: string;
  category: TemplateCategory;
  /** One sentence describing the layout, shown under the name. */
  description: string;
  build: (defaultLocale: string) => BuilderConfig;
}

/** Declaration order IS display order in the gallery. */
export const TEMPLATE_CATEGORIES = [
  { id: "minimal", label: "Minimal" },
  { id: "featureLed", label: "Feature-led" },
  { id: "comparison", label: "Comparison" },
  { id: "trialLed", label: "Trial-led" },
  { id: "urgency", label: "Urgency" },
  { id: "mediaLed", label: "Media-led" },
] as const satisfies readonly { id: TemplateCategory; label: string }[];

// -------------------------------------------------------------
// Section-input constants. Every one of these is a floor or a shape the
// schema or the validator cares about — not a taste preference.
// -------------------------------------------------------------

/** Slides in a screenshot carousel. Two is the floor: an empty carousel
 *  raises publish-tier `CAROUSEL_EMPTY` and a single-page one raises the
 *  `CAROUSEL_SINGLE_PAGE` warning, so neither belongs in a template. */
const CAROUSEL_SLIDES = 3;

/** A one-day countdown, in seconds. `durationSeconds` is
 *  `z.number().positive()`, so a non-positive value fails the strict
 *  schema outright rather than degrading. */
const COUNTDOWN_ONE_DAY_SECONDS = 24 * 60 * 60;
/** A shorter, sharper countdown for the "closing now" framing. */
const COUNTDOWN_FIFTEEN_MINUTES_SECONDS = 15 * 60;

/** Star rating used by social-proof sections. The schema caps it at
 *  `SOCIAL_PROOF_MAX_RATING`; templates claim a believable 5. */
const SOCIAL_PROOF_RATING = 5;

/** Extra breathing room above a footer or below a hero, in px. */
const SECTION_GAP = 8;

/** The three footer links every template ships. Restore is required by
 *  the stores; Terms and Privacy carry empty URLs the author fills in. */
const FOOTER_COPY = {
  restore: "Restore Purchases",
  terms: "Terms of Service",
  privacy: "Privacy Policy",
} as const;

function standardFooter(id: string) {
  return footer({ id, ...FOOTER_COPY });
}

// -------------------------------------------------------------
// Minimal — one idea, one price, nothing to read.
// -------------------------------------------------------------

function buildHero(locale: string): BuilderConfig {
  return compose(locale, [
    heroImage({ id: "hero_img" }),
    headline({
      id: "hero_head",
      title: "Unlock everything",
      subtitle: "Get full access to every feature, no limits.",
    }),
    spacer({ id: "hero_gap", size: SECTION_GAP }),
    packages({ id: "hero_plans", layout: "row" }),
    purchaseCta({ id: "hero_cta", label: "Continue" }),
    standardFooter("hero_foot"),
  ]);
}

function buildMinimalCta(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "min_head",
      title: "Go Pro",
      subtitle: "Everything you need, in one plan.",
    }),
    packages({ id: "min_plans", layout: "column" }),
    purchaseCta({ id: "min_cta", label: "Get Pro" }),
    standardFooter("min_foot"),
  ]);
}

function buildSinglePlan(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "single_head",
      title: "One plan. Everything included.",
      subtitle: "No tiers to compare, no add-ons to buy.",
    }),
    packages({ id: "single_plans", layout: "column" }),
    purchaseCta({ id: "single_cta", label: "Subscribe" }),
    standardFooter("single_foot"),
  ]);
}

// -------------------------------------------------------------
// Feature-led — earn the price by listing what it buys.
// -------------------------------------------------------------

function buildFeatureChecklist(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "chk_head",
      title: "Everything in Pro",
      subtitle: "Here is exactly what you get.",
    }),
    featureRows({
      id: "chk_rows",
      rows: [
        "Unlimited projects",
        "Advanced analytics",
        "Priority support",
        "Export to any format",
        "No ads, ever",
      ],
    }),
    packages({ id: "chk_plans", layout: "column" }),
    purchaseCta({ id: "chk_cta", label: "Upgrade to Pro" }),
    standardFooter("chk_foot"),
  ]);
}

function buildBenefitStack(locale: string): BuilderConfig {
  return compose(locale, [
    heroImage({ id: "ben_img" }),
    headline({
      id: "ben_head",
      title: "Do more, in less time",
      subtitle: "Pro removes the limits you keep running into.",
    }),
    featureRows({
      id: "ben_rows",
      rows: [
        "Work offline, sync when you are back",
        "Share with your whole team",
        "Automate the repetitive parts",
      ],
    }),
    packages({ id: "ben_plans", layout: "row" }),
    purchaseCta({ id: "ben_cta", label: "Start using Pro" }),
    standardFooter("ben_foot"),
  ]);
}

function buildProVsFree(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "pvf_head",
      title: "What changes with Pro",
      subtitle: "Free gets you started. Pro gets you finished.",
    }),
    featureRows({
      id: "pvf_rows",
      rows: [
        "Unlimited history, instead of the last 7 days",
        "Full-resolution exports, instead of previews",
        "Every integration, instead of one",
        "Answers in hours, instead of days",
      ],
    }),
    packages({ id: "pvf_plans", layout: "column" }),
    purchaseCta({ id: "pvf_cta", label: "Go Pro" }),
    standardFooter("pvf_foot"),
  ]);
}

// -------------------------------------------------------------
// Comparison — several plans, side by side.
// -------------------------------------------------------------

function buildComparison(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "cmp_head",
      title: "Choose your plan",
      subtitle: "All plans include full access — pick what fits.",
    }),
    packages({ id: "cmp_plans", layout: "column" }),
    purchaseCta({ id: "cmp_cta", label: "Continue" }),
    standardFooter("cmp_foot"),
  ]);
}

function buildPlanGrid(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "grid_head",
      title: "Pick the plan that fits",
      subtitle: "Change or cancel whenever you like.",
    }),
    packages({ id: "grid_plans", layout: "row" }),
    featureRows({
      id: "grid_rows",
      rows: ["Every plan includes full access", "Cancel anytime", "Your data stays yours"],
    }),
    purchaseCta({ id: "grid_cta", label: "Continue" }),
    standardFooter("grid_foot"),
  ]);
}

function buildAnnualHighlight(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "ann_head",
      title: "Save more with a year",
      subtitle: "The annual plan works out cheaper every month.",
    }),
    packages({ id: "ann_plans", layout: "column" }),
    socialProof({
      id: "ann_proof",
      label: "Most subscribers choose annual.",
      rating: SOCIAL_PROOF_RATING,
    }),
    purchaseCta({ id: "ann_cta", label: "Choose annual" }),
    standardFooter("ann_foot"),
  ]);
}

// -------------------------------------------------------------
// Trial-led — the offer is the trial, not the price.
// -------------------------------------------------------------

function buildTrialSteps(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "steps_head",
      title: "Try Pro free",
      subtitle: "Here is how your trial works.",
    }),
    trialTimeline({
      id: "steps_time",
      steps: [
        { label: "Today", caption: "Full access to everything, free." },
        { label: "Day 5", caption: "We remind you before anything is charged." },
        { label: "Day 7", caption: "Your subscription starts, unless you cancel." },
      ],
    }),
    packages({ id: "steps_plans", layout: "column" }),
    purchaseCta({
      id: "steps_cta",
      label: "Continue",
      trialLabel: "Start my free trial",
    }),
    standardFooter("steps_foot"),
  ]);
}

function buildTrialReminder(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "rem_head",
      title: "Free for 7 days",
      subtitle: "We will remind you two days before your trial ends.",
    }),
    featureRows({
      id: "rem_rows",
      rows: ["No charge today", "Cancel in two taps", "Keep everything you made"],
    }),
    packages({ id: "rem_plans", layout: "column" }),
    purchaseCta({
      id: "rem_cta",
      label: "Subscribe",
      trialLabel: "Try free for 7 days",
    }),
    standardFooter("rem_foot"),
  ]);
}

function buildFreeTrialHero(locale: string): BuilderConfig {
  return compose(locale, [
    heroImage({ id: "fth_img" }),
    headline({
      id: "fth_head",
      title: "Start free. Decide later.",
      subtitle: "Use every Pro feature before you pay for any of them.",
    }),
    spacer({ id: "fth_gap", size: SECTION_GAP }),
    packages({ id: "fth_plans", layout: "row" }),
    purchaseCta({
      id: "fth_cta",
      label: "Continue",
      trialLabel: "Start free trial",
    }),
    standardFooter("fth_foot"),
  ]);
}

// -------------------------------------------------------------
// Urgency — a reason to decide now. Every countdown here is a
// duration, never a fixed date, so a template never ships expired.
// -------------------------------------------------------------

function buildLimitedOffer(locale: string): BuilderConfig {
  return compose(locale, [
    countdownBanner({
      id: "lim_clock",
      label: "Offer ends in",
      seconds: COUNTDOWN_ONE_DAY_SECONDS,
    }),
    headline({
      id: "lim_head",
      title: "Your welcome offer",
      subtitle: "New subscribers get their first period at a lower price.",
    }),
    packages({ id: "lim_plans", layout: "column" }),
    purchaseCta({ id: "lim_cta", label: "Claim offer" }),
    standardFooter("lim_foot"),
  ]);
}

function buildCountdownDeal(locale: string): BuilderConfig {
  return compose(locale, [
    countdownBanner({
      id: "cnt_clock",
      label: "This price is held for",
      seconds: COUNTDOWN_FIFTEEN_MINUTES_SECONDS,
    }),
    headline({
      id: "cnt_head",
      title: "One-time upgrade price",
      subtitle: "Stay on this screen to keep it.",
    }),
    packages({ id: "cnt_plans", layout: "row" }),
    purchaseCta({ id: "cnt_cta", label: "Upgrade now" }),
    standardFooter("cnt_foot"),
  ]);
}

function buildWinbackDiscount(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "win_head",
      title: "Come back to Pro",
      subtitle: "Everything you had, at a lower price than you left on.",
    }),
    featureRows({
      id: "win_rows",
      rows: ["Your projects are still here", "Nothing to set up again", "Cancel anytime"],
    }),
    countdownBanner({
      id: "win_clock",
      label: "Your return offer expires in",
      seconds: COUNTDOWN_ONE_DAY_SECONDS,
    }),
    packages({ id: "win_plans", layout: "column" }),
    purchaseCta({ id: "win_cta", label: "Reactivate Pro" }),
    standardFooter("win_foot"),
  ]);
}

// -------------------------------------------------------------
// Media-led — show the product instead of describing it.
// -------------------------------------------------------------

function buildScreenshotTour(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "tour_head",
      title: "See what Pro unlocks",
      subtitle: "Swipe through what changes.",
    }),
    screenshotCarousel({ id: "tour_car", slides: CAROUSEL_SLIDES }),
    packages({ id: "tour_plans", layout: "row" }),
    purchaseCta({ id: "tour_cta", label: "Unlock Pro" }),
    standardFooter("tour_foot"),
  ]);
}

function buildVideoIntro(locale: string): BuilderConfig {
  return compose(locale, [
    videoHero({ id: "vid_hero" }),
    headline({
      id: "vid_head",
      title: "Pro in sixty seconds",
      subtitle: "Watch what you get before you subscribe.",
    }),
    packages({ id: "vid_plans", layout: "column" }),
    purchaseCta({ id: "vid_cta", label: "Get Pro" }),
    standardFooter("vid_foot"),
  ]);
}

function buildTestimonialWall(locale: string): BuilderConfig {
  return compose(locale, [
    headline({
      id: "tst_head",
      title: "Loved by people like you",
      subtitle: "Here is why they upgraded.",
    }),
    socialProof({
      id: "tst_proof",
      label: "Rated by thousands of subscribers.",
      rating: SOCIAL_PROOF_RATING,
    }),
    featureRows({
      id: "tst_rows",
      rows: [
        "\"It paid for itself in a week.\"",
        "\"The export alone is worth it.\"",
        "\"I stopped looking for alternatives.\"",
      ],
    }),
    packages({ id: "tst_plans", layout: "column" }),
    purchaseCta({ id: "tst_cta", label: "Join them" }),
    standardFooter("tst_foot"),
  ]);
}

/**
 * Declaration order IS display order within a category.
 *
 * `hero` and `comparison` keep the ids the two retired presets used, so
 * any stored reference to either still resolves.
 */
export const TEMPLATES = [
  {
    id: "hero",
    name: "Hero",
    tag: "Highest converting",
    category: "minimal",
    description: "Full-bleed image, plan list, one clear purchase button.",
    build: buildHero,
  },
  {
    id: "minimalCta",
    name: "Bare minimum",
    tag: "Fastest to read",
    category: "minimal",
    description: "A title, the plans, and nothing else in the way.",
    build: buildMinimalCta,
  },
  {
    id: "singlePlan",
    name: "Single plan",
    tag: "One price",
    category: "minimal",
    description: "For apps that sell exactly one subscription.",
    build: buildSinglePlan,
  },
  {
    id: "featureChecklist",
    name: "Feature checklist",
    tag: "Most explicit",
    category: "featureLed",
    description: "A ticked list of everything the subscription includes.",
    build: buildFeatureChecklist,
  },
  {
    id: "benefitStack",
    name: "Benefit stack",
    tag: "Outcome-first",
    category: "featureLed",
    description: "Image, then the outcomes rather than the features.",
    build: buildBenefitStack,
  },
  {
    id: "proVsFree",
    name: "Pro vs Free",
    tag: "Shows the gap",
    category: "featureLed",
    description: "Each row says what free gives and what Pro gives instead.",
    build: buildProVsFree,
  },
  {
    id: "comparison",
    name: "Plan comparison",
    tag: "Feature-rich",
    category: "comparison",
    description: "Title, plan list and a caption for the fine print.",
    build: buildComparison,
  },
  {
    id: "planGrid",
    name: "Plan grid",
    tag: "Side by side",
    category: "comparison",
    description: "Plans in a row, with what every plan shares underneath.",
    build: buildPlanGrid,
  },
  {
    id: "annualHighlight",
    name: "Annual highlight",
    tag: "Pushes annual",
    category: "comparison",
    description: "Frames the yearly plan as the cheaper monthly price.",
    build: buildAnnualHighlight,
  },
  {
    id: "trialSteps",
    name: "Trial timeline",
    tag: "Removes trial anxiety",
    category: "trialLed",
    description: "A day-by-day timeline of what the free trial does.",
    build: buildTrialSteps,
  },
  {
    id: "trialReminder",
    name: "Trial with reminder",
    tag: "Reassuring",
    category: "trialLed",
    description: "Leads with the reminder before the charge.",
    build: buildTrialReminder,
  },
  {
    id: "freeTrialHero",
    name: "Free trial hero",
    tag: "Trial-first",
    category: "trialLed",
    description: "Image-led, with the trial as the whole offer.",
    build: buildFreeTrialHero,
  },
  {
    id: "limitedOffer",
    name: "Limited offer",
    tag: "Welcome pricing",
    category: "urgency",
    description: "A one-day countdown over an introductory price.",
    build: buildLimitedOffer,
  },
  {
    id: "countdownDeal",
    name: "Countdown deal",
    tag: "Decide now",
    category: "urgency",
    description: "A short countdown that holds the price while it runs.",
    build: buildCountdownDeal,
  },
  {
    id: "winbackDiscount",
    name: "Win-back",
    tag: "For lapsed users",
    category: "urgency",
    description: "Reminds a former subscriber what is still waiting.",
    build: buildWinbackDiscount,
  },
  {
    id: "screenshotTour",
    name: "Screenshot tour",
    tag: "Show, don't tell",
    category: "mediaLed",
    description: "A swipeable carousel of what the subscription unlocks.",
    build: buildScreenshotTour,
  },
  {
    id: "videoIntro",
    name: "Video intro",
    tag: "Highest intent",
    category: "mediaLed",
    description: "A short video above the plans.",
    build: buildVideoIntro,
  },
  {
    id: "testimonialWall",
    name: "Testimonials",
    tag: "Social proof",
    category: "mediaLed",
    description: "A star rating over quotes from subscribers.",
    build: buildTestimonialWall,
  },
] as const satisfies readonly PaywallTemplate[];

/** Template ids derived from the table, so adding one needs no type edit. */
export type TemplateId = (typeof TEMPLATES)[number]["id"];
