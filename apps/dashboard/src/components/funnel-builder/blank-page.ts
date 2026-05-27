import { createId } from "@paralleldrive/cuid2";
import type { Page, PageType } from "./types";

function qid(prefix = "q"): string {
  return `${prefix}_${createId().slice(0, 6)}`;
}

export function blankPage(type: PageType): Page {
  const id = `pg_${createId().slice(0, 8)}`;
  switch (type) {
    case "single_choice":
    case "multi_choice":
      return {
        id,
        type,
        question_id: qid(),
        title: "New question",
        options: [
          { label: "Option A", value: "option_a" },
          { label: "Option B", value: "option_b" },
        ],
      };
    case "picture_choice":
      return {
        id,
        type,
        question_id: qid(),
        title: "Pick the one that fits",
        options: [
          { label: "Option A", value: "option_a", imageUrl: "" },
          { label: "Option B", value: "option_b", imageUrl: "" },
        ],
      };
    case "yes_no":
      return {
        id,
        type,
        question_id: qid(),
        title: "Sound good?",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
      };
    case "legal":
      return {
        id,
        type,
        question_id: qid("legal"),
        title: "Please review and accept",
        agreementLabel: "I agree to the terms",
        termsUrl: "",
      };
    case "checkbox":
      return {
        id,
        type,
        question_id: qid("agree"),
        title: "Acknowledge",
        agreementLabel: "I understand",
      };
    case "opinion_scale":
      return {
        id,
        type,
        question_id: qid("scale"),
        title: "How do you feel about this?",
        min: 1,
        max: 5,
      };
    case "rating":
      return { id, type, question_id: qid("rate"), title: "Rate your experience", min: 1, max: 5 };
    case "long_text":
      return {
        id,
        type,
        question_id: qid("text"),
        title: "Tell us more",
        placeholder: "Type your answer…",
      };
    case "short_text":
    case "text_input":
      return {
        id,
        type,
        question_id: qid("text"),
        title: "What's your name?",
        placeholder: "Type your answer…",
      };
    case "email":
      return {
        id,
        type,
        question_id: qid("email"),
        title: "What's your email?",
        placeholder: "you@example.com",
      };
    case "phone":
      return {
        id,
        type,
        question_id: qid("phone"),
        title: "What's your phone number?",
        placeholder: "+1 555 0000",
      };
    case "contact_info":
      return {
        id,
        type,
        question_id: qid("contact"),
        title: "Let's stay in touch",
        collectName: true,
        collectEmail: true,
        collectPhone: false,
      };
    case "number_input":
      return {
        id,
        type,
        question_id: qid("num"),
        title: "How many?",
        min: 0,
        max: 100,
        step: 1,
      };
    case "date_input":
      return { id, type, question_id: qid("date"), title: "Pick a date" };
    case "slider":
      return {
        id,
        type,
        question_id: qid("slide"),
        title: "Slide it",
        min: 0,
        max: 100,
        step: 1,
      };
    case "info":
      return { id, type, title: "Heads up", body: "Hi 👋" };
    case "loading":
      return { id, type, title: "Crunching numbers…", duration: 2500 };
    case "result":
      return { id, type, title: "Your plan", body: "…" };
    case "paywall":
      return { id, type, headline: "Unlock everything", benefits: ["Benefit"] };
    case "success":
      return { id, type, title: "You're in", body: "Open the app", cta: "Open app" };
    case "welcome":
      return {
        id,
        type,
        title: "Welcome",
        body: "Quick onboarding to get you started.",
        cta: "Get started",
      };
    case "statement":
      return {
        id,
        type,
        body: "Almost done — a quick note before we continue.",
        cta: "Continue",
      };
    case "feature":
      return {
        id,
        type,
        headline: "Why this works",
        features: ["Personalized in 2 minutes", "No card required", "Cancel anytime"],
        cta: "Continue",
      };
    case "end_screen":
      return {
        id,
        type,
        title: "Thanks!",
        body: "We'll be in touch shortly.",
      };
  }
}
