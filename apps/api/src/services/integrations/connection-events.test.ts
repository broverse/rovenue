// =============================================================
// connection-events.test.ts — unit tests for M4.4
// =============================================================

import { describe, expect, it, vi } from "vitest";
import {
  handleConnectionEnableTransition,
  type EnableTransitionArgs,
  type EnableTransitionDeps,
} from "./connection-events";

function makeDeps(): EnableTransitionDeps & {
  enqueueBackfillMock: ReturnType<typeof vi.fn>;
} {
  const enqueueBackfillMock = vi.fn(async () => ({ eventCount: 5 }));
  return {
    enqueueBackfill: enqueueBackfillMock,
    enqueueBackfillMock,
  };
}

const baseArgs: EnableTransitionArgs = {
  connectionId: "conn_1",
  projectId: "proj_1",
  providerId: "META_CAPI",
  wasEnabled: false,
  willBeEnabled: false,
};

describe("handleConnectionEnableTransition — M4.4", () => {
  it("false→true: triggers backfill and returns result", async () => {
    const deps = makeDeps();
    const result = await handleConnectionEnableTransition(
      { ...baseArgs, wasEnabled: false, willBeEnabled: true },
      deps,
    );

    expect(deps.enqueueBackfillMock).toHaveBeenCalledTimes(1);
    expect(deps.enqueueBackfillMock).toHaveBeenCalledWith({
      connectionId: "conn_1",
      projectId: "proj_1",
      providerId: "META_CAPI",
      windowDays: undefined,
    });
    expect(result).toEqual({ eventCount: 5 });
  });

  it("true→true (no-change): does not trigger backfill", async () => {
    const deps = makeDeps();
    const result = await handleConnectionEnableTransition(
      { ...baseArgs, wasEnabled: true, willBeEnabled: true },
      deps,
    );

    expect(deps.enqueueBackfillMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("true→false: does not trigger backfill", async () => {
    const deps = makeDeps();
    const result = await handleConnectionEnableTransition(
      { ...baseArgs, wasEnabled: true, willBeEnabled: false },
      deps,
    );

    expect(deps.enqueueBackfillMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
