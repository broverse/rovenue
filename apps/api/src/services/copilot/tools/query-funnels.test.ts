import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// find_funnels tool — list scoped to the project, detail by id.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {},
    funnelRepo: { listByProject: vi.fn(), findById: vi.fn() },
    funnelVersionRepo: { findById: vi.fn() },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return { ...actual, drizzle: { ...actual.drizzle, ...drizzleMock } };
});

import { queryFunnelsTools } from "./query-funnels";

const CTX = {
  projectId: "prj_1",
  userId: "u_1",
  role: "ADMIN",
  threadId: "th_1",
  messageId: "msg_1",
};
const CALL_OPTIONS = { toolCallId: "call_1", messages: [] };

function funnelRow(id: string, projectId = "prj_1") {
  return {
    id,
    projectId,
    slug: `slug-${id}`,
    name: `Funnel ${id}`,
    status: "published",
    currentVersionId: null,
    defaultLocale: "en",
  };
}

describe("find_funnels", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists funnels in the project and never leaks another project's", async () => {
    const mine = [funnelRow("fn_1"), funnelRow("fn_2"), funnelRow("fn_3")];
    drizzleMock.funnelRepo.listByProject.mockResolvedValue(mine);
    const tools = queryFunnelsTools(CTX);

    const result = (await tools["find_funnels"].execute!(
      { limit: 50 },
      CALL_OPTIONS,
    )) as {
      funnels: Array<{ id: string }>;
    };

    expect(drizzleMock.funnelRepo.listByProject).toHaveBeenCalledWith(
      expect.anything(),
      "prj_1",
      // Status passthrough (undefined here) and the limit+1 has-more probe
      // are the load-bearing parts of the call — pin them exactly.
      { status: undefined, limit: 51 },
    );
    expect(result.funnels).toHaveLength(3);
    // pagesJson never ships: an agent needs something to act on, not a
    // response-cap-blowing blob.
    for (const f of result.funnels) {
      expect(f).not.toHaveProperty("pagesJson");
      expect(f).not.toHaveProperty("draftPagesJson");
    }
  });

  it("returns detail for one funnel when given an id", async () => {
    drizzleMock.funnelRepo.findById.mockResolvedValue({
      ...funnelRow("fn_1"),
      currentVersionId: "ver_9",
    });
    drizzleMock.funnelVersionRepo.findById.mockResolvedValue({
      pagesJson: [{}, {}, {}],
    });
    const tools = queryFunnelsTools(CTX);

    const result = (await tools["find_funnels"].execute!(
      { id: "fn_1", limit: 50 },
      CALL_OPTIONS,
    )) as { funnel: { id: string; pageCount: number; slug: string } };

    expect(result.funnel.id).toBe("fn_1");
    expect(result.funnel.slug).toBe("slug-fn_1");
    expect(result.funnel.pageCount).toBe(3);
  });

  it("returns null for a foreign id (IDOR precedent)", async () => {
    drizzleMock.funnelRepo.findById.mockResolvedValue(funnelRow("fn_x", "prj_2"));
    const tools = queryFunnelsTools(CTX);

    const result = await tools["find_funnels"].execute!(
      { id: "fn_x", limit: 50 },
      CALL_OPTIONS,
    );

    expect(result).toBeNull();
  });

  it("reports zero pages when nothing is published yet", async () => {
    drizzleMock.funnelRepo.findById.mockResolvedValue(funnelRow("fn_1"));
    const tools = queryFunnelsTools(CTX);

    const result = (await tools["find_funnels"].execute!(
      { id: "fn_1", limit: 50 },
      CALL_OPTIONS,
    )) as { funnel: { pageCount: number } };

    expect(result.funnel.pageCount).toBe(0);
    expect(drizzleMock.funnelVersionRepo.findById).not.toHaveBeenCalled();
  });
});
