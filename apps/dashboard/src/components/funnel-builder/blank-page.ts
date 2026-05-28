import { createId } from "@paralleldrive/cuid2";
import type { LocaleCode, Localized } from "@rovenue/shared/i18n";
import type { Page, PageType } from "./types";

function qid(prefix = "q"): string {
  return `${prefix}_${createId().slice(0, 6)}`;
}

const L = <T,>(locale: LocaleCode, v: T): Localized<T> => ({ [locale]: v });

export function blankPage(type: PageType, defaultLocale: LocaleCode): Page {
  const id = `pg_${createId().slice(0, 8)}`;
  const dl = defaultLocale;
  switch (type) {
    case "single_choice":
    case "multi_choice":
      return {
        id,
        type,
        question_id: qid(),
        title: L(dl, "New question"),
        options: [
          { label: L(dl, "Option A"), value: "option_a" },
          { label: L(dl, "Option B"), value: "option_b" },
        ],
      };
    case "picture_choice":
      return {
        id,
        type,
        question_id: qid(),
        title: L(dl, "Pick the one that fits"),
        options: [
          { label: L(dl, "Option A"), value: "option_a", imageUrl: "" },
          { label: L(dl, "Option B"), value: "option_b", imageUrl: "" },
        ],
      };
    case "yes_no":
      return {
        id,
        type,
        question_id: qid(),
        title: L(dl, "Sound good?"),
        options: [
          { label: L(dl, "Yes"), value: "yes" },
          { label: L(dl, "No"), value: "no" },
        ],
      };
    case "legal":
      return {
        id,
        type,
        question_id: qid("legal"),
        title: L(dl, "Please review and accept"),
        agreementLabel: L(dl, "I agree to the terms"),
        termsUrl: "",
      };
    case "checkbox":
      return {
        id,
        type,
        question_id: qid("agree"),
        title: L(dl, "Acknowledge"),
        agreementLabel: L(dl, "I understand"),
      };
    case "opinion_scale":
      return {
        id,
        type,
        question_id: qid("scale"),
        title: L(dl, "How do you feel about this?"),
        min: 1,
        max: 5,
      };
    case "rating":
      return { id, type, question_id: qid("rate"), title: L(dl, "Rate your experience"), min: 1, max: 5 };
    case "long_text":
      return {
        id,
        type,
        question_id: qid("text"),
        title: L(dl, "Tell us more"),
        placeholder: L(dl, "Type your answer…"),
      };
    case "short_text":
    case "text_input":
      return {
        id,
        type,
        question_id: qid("text"),
        title: L(dl, "What's your name?"),
        placeholder: L(dl, "Type your answer…"),
      };
    case "email":
      return {
        id,
        type,
        question_id: qid("email"),
        title: L(dl, "What's your email?"),
        placeholder: L(dl, "you@example.com"),
      };
    case "phone":
      return {
        id,
        type,
        question_id: qid("phone"),
        title: L(dl, "What's your phone number?"),
        placeholder: L(dl, "+1 555 0000"),
      };
    case "contact_info":
      return {
        id,
        type,
        question_id: qid("contact"),
        title: L(dl, "Let's stay in touch"),
        collectName: true,
        collectEmail: true,
        collectPhone: false,
      };
    case "number_input":
      return {
        id,
        type,
        question_id: qid("num"),
        title: L(dl, "How many?"),
        min: 0,
        max: 100,
        step: 1,
      };
    case "date_input":
      return { id, type, question_id: qid("date"), title: L(dl, "Pick a date") };
    case "slider":
      return {
        id,
        type,
        question_id: qid("slide"),
        title: L(dl, "Slide it"),
        min: 0,
        max: 100,
        step: 1,
      };
    case "info":
      return { id, type, title: L(dl, "Heads up"), body: L(dl, "Hi 👋") };
    case "loading":
      return { id, type, title: L(dl, "Crunching numbers…"), duration: 2500 };
    case "result":
      return { id, type, title: L(dl, "Your plan"), body: L(dl, "…") };
    case "paywall":
      return { id, type, headline: L(dl, "Unlock everything"), benefits: L(dl, ["Benefit"]) };
    case "success":
      return { id, type, title: L(dl, "You're in"), body: L(dl, "Open the app"), cta: L(dl, "Open app") };
    case "welcome":
      return {
        id,
        type,
        title: L(dl, "Welcome"),
        body: L(dl, "Quick onboarding to get you started."),
        cta: L(dl, "Get started"),
      };
    case "statement":
      return {
        id,
        type,
        body: L(dl, "Almost done — a quick note before we continue."),
        cta: L(dl, "Continue"),
      };
    case "feature":
      return {
        id,
        type,
        headline: L(dl, "Why this works"),
        features: L(dl, ["Personalized in 2 minutes", "No card required", "Cancel anytime"]),
        cta: L(dl, "Continue"),
      };
    case "end_screen":
      return {
        id,
        type,
        title: L(dl, "Thanks!"),
        body: L(dl, "We'll be in touch shortly."),
      };
  }
}
