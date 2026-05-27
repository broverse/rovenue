import { injectable, inject, state, derived, onInit, Props } from "impair";
import {
  evaluateNext,
  type AnswerMap,
  type EvalPage,
  type NextRule,
} from "@rovenue/shared/funnel";
import type { Page } from "../types";
import { toEvalPage } from "../types";

export interface PreviewProps {
  pages: Page[];
  rules: Record<string, NextRule[]>;
  defaultNext: Record<string, string | null>;
  startId: string | null;
}

@injectable()
export class FunnelPreviewViewModel {
  @state currentPageId: string | null = null;
  @state answers: AnswerMap = new Map();
  @state finished = false;
  @state reachedPaywall = false;

  constructor(@inject(Props) private props: PreviewProps) {}

  @onInit
  init() {
    this.currentPageId = this.props.startId ?? this.props.pages[0]?.id ?? null;
  }

  @derived get currentPage(): Page | null {
    return this.currentPageId
      ? (this.props.pages.find((p) => p.id === this.currentPageId) ?? null)
      : null;
  }

  reset() {
    this.currentPageId = this.props.startId ?? this.props.pages[0]?.id ?? null;
    this.answers = new Map();
    this.finished = false;
    this.reachedPaywall = false;
  }

  answerAndAdvance(questionId: string | null, answer: unknown) {
    if (questionId) {
      const next = new Map(this.answers);
      next.set(questionId, answer as never);
      this.answers = next;
    }
    const cur = this.currentPage;
    if (!cur) return;
    const pagesOrder = this.props.pages.map((p) => p.id);
    const pagesById = new Map<string, EvalPage>(
      this.props.pages.map((p) => [
        p.id,
        toEvalPage(p, this.props.rules[p.id], this.props.defaultNext[p.id] ?? undefined) as EvalPage,
      ]),
    );
    const result = evaluateNext({
      page: toEvalPage(
        cur,
        this.props.rules[cur.id],
        this.props.defaultNext[cur.id] ?? undefined,
      ) as EvalPage,
      pagesOrder,
      answers: this.answers,
      pagesById,
    });
    if (result.next === "end") {
      this.finished = true;
      this.currentPageId = null;
      return;
    }
    if (result.next === "paywall") {
      this.reachedPaywall = true;
      const paywall = this.props.pages.find((p) => p.type === "paywall");
      this.currentPageId = paywall?.id ?? null;
      this.finished = !paywall;
      return;
    }
    this.currentPageId = result.pageId;
  }
}
