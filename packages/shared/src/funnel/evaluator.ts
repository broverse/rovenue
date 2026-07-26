import type { Clause, NextRule } from "./branching-schema";
import { ISO_DATE_RE } from "./branching-schema";

/**
 * A `contact_info` page's answer.
 *
 * A key is present for each field the page ASKS for, and only those. So the
 * key set records what was requested while the values record what was
 * given — which is what makes `isAnswered` decidable from the value alone,
 * without the page's collectName/collectEmail/collectPhone flags. The
 * runner knows those flags and the evaluator does not, so any definition
 * that needed them would give the two layers different answers.
 */
export type ContactAnswer = {
  name?: string;
  email?: string;
  phone?: string;
};

export type ContactField = keyof ContactAnswer;

/**
 * Which contact fields a page asks for, in render order.
 *
 * ONE definition, used by the renderer (which fields to show and emit) and
 * by the rule editor (which sub-fields to offer). Two copies of "which
 * fields does this page ask for" would let the editor offer a field the page
 * does not collect — the drift class this codebase keeps paying for.
 *
 * The flag asymmetry is existing product behaviour: name and email default
 * ON (`!== false`), phone defaults OFF.
 */
export function contactFieldsAsked(page: {
  collectName?: boolean;
  collectEmail?: boolean;
  collectPhone?: boolean;
}): ContactField[] {
  const out: ContactField[] = [];
  if (page.collectName !== false) out.push("name");
  if (page.collectEmail !== false) out.push("email");
  if (page.collectPhone) out.push("phone");
  return out;
}

export type AnswerValue = string | number | boolean | string[] | null | ContactAnswer;
export type AnswerMap = Map<string, AnswerValue>;

/**
 * The ONE definition of "answered", called by both the evaluator's
 * `is_answered` operator and the runner's `required` gate.
 *
 * It exists as a shared function rather than as the same expression written
 * twice: those two copies were aligned by hand, and a composite answer
 * breaks that alignment in a way neither copy would have caught — an object
 * with every field blank is not `null`, not `""`, and not an empty array.
 *
 * `0` and `false` are answers. A truthiness check would silently drop both.
 */
export function isAnswered(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((v) => typeof v === "string" && v.trim() !== "");
  }
  return true;
}

/**
 * `iso` shifted by `days`, as another ISO calendar date. Returns null when
 * `iso` is not a well-formed `YYYY-MM-DD`.
 *
 * This DOES parse a date, which the comparison operators deliberately never
 * do — and the distinction is worth keeping straight in both directions.
 * `before`/`after` compare two calendar dates, and text comparison is exact
 * there, so parsing would only add a time and a zone the value does not
 * have. Here the job is arithmetic: today minus N days cannot be computed
 * with string operations at all. `Date.UTC` is correct precisely because
 * both ends are UTC-anchored and no local zone enters it.
 *
 * So: do not make the comparisons parse, and do not try to subtract days
 * with string surgery. The month-end and leap-year cases live here, in one
 * place, tested once.
 */
export function shiftIsoDays(iso: string, days: number): string | null {
  if (!ISO_DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const shifted = new Date(ms);
  const yy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Minimal page shape the runtime evaluator needs. Matches the flat
// dashboard page (see pages-schema.ts) — only the routing fields are
// load-bearing here; everything else is opaque from the evaluator's
// perspective.
export interface EvalPage {
  id: string;
  type: string;
  next_rules?: NextRule[];
  default_next?: string | "paywall" | "end";
  // Vestigial — older callers / tests still pass a `config` bag from when
  // the schema was SDK-wrapped. The evaluator no longer reads it, but
  // accepting it keeps existing fixtures + dashboard's `toEvalPage`
  // helper working unchanged.
  config?: Record<string, unknown>;
}

export type PageGraph = Map<string, EvalPage>;

export type EvalResult =
  | { next: "page"; pageId: string }
  | { next: "paywall" }
  | { next: "end" };

interface EvalInput {
  page: EvalPage;
  pagesOrder: string[];
  answers: AnswerMap;
  pagesById: PageGraph;
  /**
   * Today's calendar date as ISO `YYYY-MM-DD`, for the relative date
   * operators. INJECTED rather than read from a clock in here, so this stays
   * pure and testable without freezing time — and so "which clock decided
   * this route" is a property of the caller, not a hidden global.
   *
   * Absent means the relative operators cannot compare, so they return
   * false. That is the behaviour a caller which forgot to pass it gets, and
   * a silent false routes to default_next, which is defined.
   */
  today?: string;
}

export function evaluateNext(input: EvalInput): EvalResult {
  const { page, answers, pagesOrder, pagesById, today } = input;
  const rules = page.next_rules ?? [];
  for (const rule of rules) {
    if (matches(rule.condition, answers, today)) {
      return resolveGoto(rule.goto, page.id, pagesOrder, pagesById);
    }
  }
  if (page.default_next !== undefined) {
    return resolveGoto(page.default_next, page.id, pagesOrder, pagesById);
  }
  return resolveGoto("sequential", page.id, pagesOrder, pagesById);
}

// Resolve the literal "paywall" goto to an actual page id. The literal form
// carries no page id; a funnel may legally contain multiple paywall pages.
// To keep routing deterministic (same funnel always routes the same way), we
// pick the first paywall page in page order. Authors who want a specific paywall
// should target it by id instead of using the literal.
function firstPaywallId(
  pagesOrder: string[],
  pagesById: PageGraph,
): string | null {
  for (const id of pagesOrder) {
    if (pagesById.get(id)?.type === "paywall") return id;
  }
  return null;
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
  pagesById: PageGraph,
): EvalResult {
  if (goto === "paywall") {
    // The literal goto names no page. Resolve it to the funnel's paywall
    // page so the session's currentPageId can actually move there; the
    // id-less form survives only for a funnel with no paywall page,
    // which the publish validator already rejects.
    const paywallId = firstPaywallId(pagesOrder, pagesById);
    return paywallId ? { next: "page", pageId: paywallId } : { next: "paywall" };
  }
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    // A paywall page is a page like any other — it has an id and the
    // client needs it to render the paywall.
    return { next: "page", pageId: pagesOrder[idx + 1] };
  }
  return { next: "page", pageId: goto };
}

function matches(
  condition: { op: "all" | "any"; clauses: Clause[] },
  answers: AnswerMap,
  today?: string,
): boolean {
  if (condition.op === "all") {
    return condition.clauses.every((c) => evalClause(c, answers, today));
  }
  return condition.clauses.some((c) => evalClause(c, answers, today));
}

/**
 * The set of `contact_info` sub-fields a clause may address. Kept beside the
 * ContactAnswer type so the two cannot drift.
 */
const CONTACT_FIELDS: ReadonlySet<string> = new Set(["name", "email", "phone"]);

/**
 * Resolve a clause's `question_id` to an answer, supporting
 * `<question_id>.<field>` for a contact_info sub-field.
 *
 * Splits on the first dot. A page's own question_id cannot contain one —
 * qid() builds ids from a base36 cuid2 slice, and pages-schema rejects a
 * stored id carrying a dot — so the text before it is always the whole base.
 *
 * Recorded from mutation-checking: first-dot vs last-dot is observationally
 * EQUIVALENT here, because valid field names are single words and base ids
 * have no dots. Switching to lastIndexOf reds no test. first is kept for
 * readability, not because behaviour depends on it — do not add a test
 * claiming to pin the difference.
 *
 * Anything that cannot resolve returns undefined, i.e. unanswered: an
 * unknown field name, a base that is not a composite, a base that does not
 * exist, or a second dot. The object check is what stops a MISSING base from
 * throwing (`undefined["email"]`), which is what mutation-checking showed it
 * actually carries — indexing a string merely yields undefined.
 */
function resolveAnswer(questionId: string, answers: AnswerMap): AnswerValue | undefined {
  const dot = questionId.indexOf(".");
  if (dot === -1) return answers.get(questionId);

  const base = questionId.slice(0, dot);
  const field = questionId.slice(dot + 1);
  if (!CONTACT_FIELDS.has(field)) return undefined;

  const value = answers.get(base);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as ContactAnswer)[field as keyof ContactAnswer];
}

function evalClause(clause: Clause, answers: AnswerMap, today?: string): boolean {
  const a = resolveAnswer(clause.question_id, answers);

  // One definition of "answered", shared with the runner's own gate — see
  // isAnswered. The evaluator and the client each computing it was two
  // definitions one hop apart.
  const answered = isAnswered(a);

  // A multi_choice answer is a string[]. Comparing it with a scalar
  // operator is a type mismatch, not a question with an answer — so the
  // scalar operators below refuse it in BOTH directions rather than
  // letting `neq`/`not_in` come back true by accident and route the
  // visitor somewhere nobody chose. Arrays have `contains` /
  // `not_contains` instead.
  const isArray = Array.isArray(a);

  switch (clause.op) {
    case "is_answered":
      return answered;
    case "is_not_answered":
      return !answered;
    case "eq":
      return !isArray && a === clause.value;
    case "neq":
      // NOTE: an UNANSWERED question still fires here, deliberately.
      // "they did not say x, including by skipping" is meaningful;
      // narrowing it would also make is_not_answered redundant.
      return !isArray && a !== clause.value;
    case "gt":
      return typeof a === "number" && typeof clause.value === "number" && a > clause.value;
    case "gte":
      return typeof a === "number" && typeof clause.value === "number" && a >= clause.value;
    case "lt":
      return typeof a === "number" && typeof clause.value === "number" && a < clause.value;
    case "lte":
      return typeof a === "number" && typeof clause.value === "number" && a <= clause.value;
    case "between": {
      if (typeof a !== "number" || !Array.isArray(clause.value) || clause.value.length !== 2) {
        return false;
      }
      const [min, max] = clause.value as [number, number];
      return a >= min && a <= max;
    }
    case "in":
      return !isArray && Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in":
      return !isArray && Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains":
      return isArray && typeof clause.value === "string" && (a as string[]).includes(clause.value);
    case "not_contains":
      return isArray && typeof clause.value === "string" && !(a as string[]).includes(clause.value);
    // ---- date operators ----
    //
    // Lexicographic comparison IS chronological comparison for zero-padded
    // YYYY-MM-DD, so these need no date parsing — and must not do any.
    // Parsing would attach a time and a zone to a value that has neither
    // (`new Date("2026-03-01")` is midnight UTC, i.e. the previous day west
    // of Greenwich).
    //
    // The guard is what makes that equivalence safe rather than merely
    // convenient: an unpadded "2026-1-5" sorts AFTER "2026-01-10" as text
    // while being EARLIER as a date. Either side failing the pattern means
    // the operator cannot compare, so it returns false rather than
    // answering true by accident.
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      if (
        typeof a !== "string" ||
        typeof clause.value !== "string" ||
        !ISO_DATE_RE.test(a) ||
        !ISO_DATE_RE.test(clause.value)
      ) {
        return false;
      }
      const other = clause.value;
      if (clause.op === "before") return a < other;
      if (clause.op === "after") return a > other;
      if (clause.op === "on_or_before") return a <= other;
      if (clause.op === "on_or_after") return a >= other;
      // `on_or_after` is spelled out rather than left as the fall-through so
      // that a FIFTH date operator added to the case labels above cannot
      // silently inherit `>=` semantics. Reaching here means an operator
      // arrived that nobody taught this block to compare, and the rule this
      // whole area is built on says such an operator returns false rather
      // than answering true by accident.
      return false;
    }
    // ---- relative date operators ----
    //
    // The operand is a COUNT OF DAYS, and `today` comes from the caller.
    // Both are validated before any comparison: an operator that cannot
    // compare returns false rather than answering true by accident.
    //
    // Inclusive at both ends for within_last_days, strictly older for
    // more_than_days_ago — so the two partition the past with no overlap
    // and no gap. A FUTURE date matches neither, deliberately.
    case "within_last_days":
    case "more_than_days_ago": {
      if (
        typeof a !== "string" ||
        !ISO_DATE_RE.test(a) ||
        typeof clause.value !== "number" ||
        !Number.isInteger(clause.value) ||
        clause.value < 0 ||
        // Redundant at RUNTIME — shiftIsoDays(undefined) fails its pattern
        // test and returns null, which the next line already turns into
        // false, so removing this line reds no test. It stays for TYPE
        // NARROWING: without it `today` is `string | undefined` here and the
        // call below needs a cast, which would mean leaning on `undefined`
        // being coerced to the string "undefined". The contract ("absent
        // means false") is tested; this line is how it is expressed without
        // a cast.
        today === undefined
      ) {
        return false;
      }
      const cutoff = shiftIsoDays(today, -clause.value);
      if (cutoff === null || !ISO_DATE_RE.test(today)) return false;
      if (clause.op === "within_last_days") return a >= cutoff && a <= today;
      return a < cutoff;
    }
    default:
      return false;
  }
}
