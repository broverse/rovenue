import { createId } from "@paralleldrive/cuid2";
import type { Page, PageType } from "./types";

export function blankPage(type: PageType): Page {
  const id = `pg_${createId().slice(0, 8)}`;
  switch (type) {
    case "single_choice":
    case "multi_choice":
      return {
        id,
        type,
        question_id: `q_${createId().slice(0, 6)}`,
        title: "New question",
        options: [{ label: "Option A", value: "option_a" }],
      };
    case "text_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Tell us…" };
    case "number_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "How many?", min: 0, max: 100, step: 1 };
    case "date_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Pick a date" };
    case "slider":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Slide it", min: 0, max: 100, step: 1 };
    case "rating":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Rate it" };
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
  }
}
