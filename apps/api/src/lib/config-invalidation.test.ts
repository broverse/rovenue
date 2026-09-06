import { beforeEach, describe, expect, test, vi } from "vitest";

const { redisMock } = vi.hoisted(() => ({
  redisMock: { publish: vi.fn(async () => 1) },
}));

vi.mock("./redis", () => ({ redis: redisMock }));

import {
  CONFIG_INVALIDATE_CHANNEL,
  parseConfigInvalidation,
  publishConfigInvalidation,
  publishSubscriberInvalidation,
} from "./config-invalidation";

const PROJECT_ID = "prj_1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishConfigInvalidation", () => {
  test("publishes a project-wide message with no subscriberIds", async () => {
    await publishConfigInvalidation(PROJECT_ID);

    expect(redisMock.publish).toHaveBeenCalledWith(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId: PROJECT_ID }),
    );
  });
});

describe("publishSubscriberInvalidation", () => {
  test("publishes only the named subscribers", async () => {
    await publishSubscriberInvalidation(PROJECT_ID, ["sub_1", "sub_2"]);

    expect(redisMock.publish).toHaveBeenCalledWith(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId: PROJECT_ID, subscriberIds: ["sub_1", "sub_2"] }),
    );
  });

  test("publishes nothing for an empty list", async () => {
    await publishSubscriberInvalidation(PROJECT_ID, []);

    // An empty list is not "invalidate everyone" — a caller with nothing
    // to say must not accidentally wake a whole project.
    expect(redisMock.publish).not.toHaveBeenCalled();
  });

  test("swallows a publish failure", async () => {
    redisMock.publish.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      publishSubscriberInvalidation(PROJECT_ID, ["sub_1"]),
    ).resolves.toBeUndefined();
  });
});

describe("parseConfigInvalidation", () => {
  test("parses a project-wide message", () => {
    expect(parseConfigInvalidation(JSON.stringify({ projectId: PROJECT_ID })))
      .toEqual({ projectId: PROJECT_ID });
  });

  test("parses a per-subscriber message", () => {
    expect(
      parseConfigInvalidation(
        JSON.stringify({ projectId: PROJECT_ID, subscriberIds: ["sub_1"] }),
      ),
    ).toEqual({ projectId: PROJECT_ID, subscriberIds: ["sub_1"] });
  });

  test("drops a malformed subscriberIds rather than treating it as targeted", () => {
    // Falling back to project-wide over-invalidates, which is safe.
    // Treating garbage as a target list would silently drop pushes.
    expect(
      parseConfigInvalidation(
        JSON.stringify({ projectId: PROJECT_ID, subscriberIds: "sub_1" }),
      ),
    ).toEqual({ projectId: PROJECT_ID });
  });

  test("returns null for unparseable input", () => {
    expect(parseConfigInvalidation("not json")).toBeNull();
    expect(parseConfigInvalidation(JSON.stringify({}))).toBeNull();
  });
});
