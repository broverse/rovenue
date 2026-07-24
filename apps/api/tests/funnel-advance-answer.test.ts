import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /public/funnel-sessions/:sessionId/advance — answer rides along
// =============================================================
//
// Server-side branching is evaluated from the server's OWN answers table
// (`evalClause` does `answers.get(clause.question_id)` in
// packages/shared/src/funnel/evaluator.ts). Before this change the runner
// never recorded answers at all, so every funnel fell through on
// `default_next`.
//
// The obvious client design — call /answers, then call /advance — was
// rejected: it leaves the ordering enforced by convention only. A client
// that advances before recording branches on the PREVIOUS answer, silently,
// and only on the first transition through each page. Writing the answer
// before reading the answer map, inside this one handler, removes the
// ordering entirely.
//
// Every case here asserts on the repository mock as well as the status —
// a status-only assertion would pass identically whether the write
// happened, happened too late, or never happened at all.

const findSessionById = vi.hoisted(() => vi.fn());
const findVersionById = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn());
const listBySessionMock = vi.hoisted(() => vi.fn());
const setCurrentPageMock = vi.hoisted(() => vi.fn());
const outboxInsertMock = vi.hoisted(() => vi.fn());

// The answer "table" is a stateful store the upsert mock writes into and
// listBySession reads back from — so the branching test proves the write
// really lands before evaluation reads it, rather than the test hand-
// wiring the two together per case.
const answerRows = vi.hoisted(
  () => [] as Array<{ questionId: string; answerJson: { value: unknown } }>,
);

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      funnelSessionRepo: {
        findById: findSessionById,
        setCurrentPage: setCurrentPageMock,
      },
      funnelVersionRepo: { findById: findVersionById },
      funnelAnswerRepo: { upsert: upsertMock, listBySession: listBySessionMock },
      outboxRepo: { insert: outboxInsertMock },
    },
  };
});

// Redis is not running in this test environment — same in-memory stub as
// funnel-host-lookup.test.ts. The rate-limit middleware fails open (falls
// back to the in-process insurance limiter) if a pipeline method it needs
// is missing, so a bare get/set/del stub is enough.
const redisStore = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/lib/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  },
}));

// A page whose next_rules route to "pg_yes" when question "q1" equals
// "yes", and whose default_next is "pg_no".
const PAGE_WITH_RULE = {
  id: "pg_1",
  type: "question",
  next_rules: [
    {
      id: "r1",
      condition: {
        op: "all",
        clauses: [{ question_id: "q1", op: "eq", value: "yes" }],
      },
      goto: "pg_yes",
    },
  ],
  default_next: "pg_no",
};

describe("POST /public/funnel-sessions/:sessionId/advance — answer", () => {
  beforeEach(() => {
    vi.resetModules();
    redisStore.clear();
    answerRows.length = 0;

    findSessionById.mockReset().mockResolvedValue({
      id: "session-id",
      state: "in_progress",
      funnelId: "funnel-id",
      funnelVersionId: "version-id",
      projectId: "project-id",
      currentPageId: "pg_1",
    });
    findVersionById.mockReset().mockResolvedValue({
      id: "version-id",
      pagesJson: [PAGE_WITH_RULE],
    });
    upsertMock.mockReset().mockImplementation(async (_db, row) => {
      answerRows.push({ questionId: row.questionId, answerJson: row.answerJson });
      return { id: "answer_1", ...row };
    });
    // A SNAPSHOT copy, not the live array reference. If listBySession
    // returned `answerRows` itself, a write that happened AFTER this call
    // but BEFORE `.map()` runs on the result would still be visible
    // (same mutable array, mutated in place) — silently defeating the
    // mutation-check below, which depends on "read" and "write" being
    // truly ordered relative to each other.
    listBySessionMock.mockReset().mockImplementation(async () => [...answerRows]);
    setCurrentPageMock.mockReset().mockResolvedValue(undefined);
    outboxInsertMock.mockReset().mockResolvedValue(undefined);
  });

  async function advance(body: Record<string, unknown>, sessionId = "session-id") {
    const { createApp } = await import("../src/app");
    const app = createApp();
    return app.request(`/public/funnel-sessions/${sessionId}/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("records the answer before evaluating, so a rule keyed on it matches", async () => {
    const res = await advance({
      from_page_id: "pg_1",
      answer: { question_id: "q1", answer: "yes" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { page_id: string } };
    // The whole point: the answer sent WITH this call steered this call.
    expect(body.data.page_id).toBe("pg_yes");
    // Pinned on the repo mock too, not just the response: this is the
    // write that made the branch match.
    expect(upsertMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        sessionId: "session-id",
        pageId: "pg_1",
        questionId: "q1",
        answerJson: { value: "yes" },
      },
    );
  });

  it("still advances with no answer, exactly as before", async () => {
    const res = await advance({ from_page_id: "pg_1" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { page_id: string } };
    // No "yes" answer was ever recorded, so the rule doesn't match and
    // evaluation falls through to default_next.
    expect(body.data.page_id).toBe("pg_no");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects an answer payload over 16 KB", async () => {
    // Each string is within the per-string 2000-char schema cap and the
    // array is within the 100-item cap, so this clears field-level
    // validation — only the aggregate 16 KB serialised-size check catches
    // it. Same construction as the /answers 413 test (funnels.test.ts).
    const bigString = "a".repeat(2000);
    const oversized = Array.from({ length: 10 }, () => bigString);

    const res = await advance({
      from_page_id: "pg_1",
      answer: { question_id: "q1", answer: oversized },
    });

    expect(res.status).toBe(413);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects an answer when the session is closed", async () => {
    findSessionById.mockResolvedValue({
      id: "session-id",
      state: "completed",
      funnelId: "funnel-id",
      funnelVersionId: "version-id",
      projectId: "project-id",
      currentPageId: "pg_1",
    });

    const res = await advance({
      from_page_id: "pg_1",
      answer: { question_id: "q1", answer: "yes" },
    });

    expect(res.status).toBe(409);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
