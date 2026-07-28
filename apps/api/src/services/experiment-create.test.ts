import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// experiment-create service — unit tests
// =============================================================
//
// Mocks the drizzle barrel the way
// copilot/intent-handlers.project-scope.test.ts does: merge the real
// `@rovenue/db` namespace with fake repo functions so the service's
// validation/orchestration logic runs for real while every DB call is
// a controllable stub.

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {},
    experimentRepo: {
      generateExperimentKey: vi.fn(),
      findExperimentByKey: vi.fn(),
      createExperiment: vi.fn(),
    },
    audienceRepo: {
      findAudienceInProject: vi.fn(),
      findDefaultAudience: vi.fn(),
      findMatchAllAudiences: vi.fn(),
      createAudience: vi.fn(),
    },
    paywallRepo: {
      findPaywallsByIds: vi.fn(),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});

import {
  createExperimentValidated,
  findOrCreateEveryoneAudience,
  EVERYONE_AUDIENCE_NAME,
  EXPERIMENT_KEY_MAX_ATTEMPTS,
  type CreateExperimentInput,
} from "./experiment-create";

const db = drizzleMock.db as never;

function flagInput(overrides: Partial<CreateExperimentInput> = {}): CreateExperimentInput {
  return {
    projectId: "prj_1",
    name: "My experiment",
    type: "FLAG",
    audienceId: "aud_1",
    variants: [
      { id: "v1", name: "Control", value: false, weight: 0.5 },
      { id: "v2", name: "Treatment", value: true, weight: 0.5 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.audienceRepo.findAudienceInProject.mockResolvedValue({ id: "aud_1" });
});

describe("createExperimentValidated", () => {
  it("inserts a DRAFT experiment with a server-assigned key", async () => {
    drizzleMock.experimentRepo.generateExperimentKey.mockReturnValue("exp_aaaaaaaa");
    drizzleMock.experimentRepo.findExperimentByKey.mockResolvedValue(null);
    drizzleMock.experimentRepo.createExperiment.mockImplementation(
      async (_db: unknown, input: Record<string, unknown>) => ({
        id: "exp_1",
        ...input,
      }),
    );

    const input = flagInput();
    const result = await createExperimentValidated(db, input);

    expect(drizzleMock.experimentRepo.createExperiment).toHaveBeenCalledTimes(1);
    expect(drizzleMock.experimentRepo.createExperiment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        projectId: "prj_1",
        key: "exp_aaaaaaaa",
        status: "DRAFT",
        variants: input.variants,
      }),
    );
    expect(result).toMatchObject({ id: "exp_1", key: "exp_aaaaaaaa", status: "DRAFT" });
  });

  it("rejects variants failing the shared schema (weights not summing to 1)", async () => {
    const input = flagInput({
      variants: [
        { id: "v1", name: "Control", value: false, weight: 0.5 },
        { id: "v2", name: "Treatment", value: true, weight: 0.6 },
      ],
    });

    await expect(createExperimentValidated(db, input)).rejects.toThrow();
    expect(drizzleMock.experimentRepo.createExperiment).not.toHaveBeenCalled();
    expect(drizzleMock.audienceRepo.findAudienceInProject).not.toHaveBeenCalled();
  });

  it("rejects an audience outside the project", async () => {
    drizzleMock.audienceRepo.findAudienceInProject.mockResolvedValue(null);

    const input = flagInput();
    await expect(createExperimentValidated(db, input)).rejects.toMatchObject({
      status: 400,
    });
    expect(drizzleMock.experimentRepo.createExperiment).not.toHaveBeenCalled();
  });

  it("rejects a PAYWALL variant whose paywallId is foreign", async () => {
    drizzleMock.paywallRepo.findPaywallsByIds.mockResolvedValue([{ id: "pw_1" }]);

    const input = flagInput({
      type: "PAYWALL",
      variants: [
        { id: "v1", name: "Control", value: { paywallId: "pw_1" }, weight: 0.5 },
        { id: "v2", name: "Treatment", value: { paywallId: "pw_foreign" }, weight: 0.5 },
      ],
    });

    await expect(createExperimentValidated(db, input)).rejects.toMatchObject({
      status: 400,
    });
    expect(drizzleMock.experimentRepo.createExperiment).not.toHaveBeenCalled();
  });

  it("regenerates the key when the precheck finds a collision", async () => {
    drizzleMock.experimentRepo.generateExperimentKey
      .mockReturnValueOnce("exp_collide1")
      .mockReturnValueOnce("exp_unique2");
    drizzleMock.experimentRepo.findExperimentByKey
      .mockResolvedValueOnce({ id: "exp_existing" })
      .mockResolvedValueOnce(null);
    drizzleMock.experimentRepo.createExperiment.mockResolvedValue({ id: "exp_2" });

    const input = flagInput();
    await createExperimentValidated(db, input);

    expect(drizzleMock.experimentRepo.findExperimentByKey).toHaveBeenCalledTimes(2);
    expect(drizzleMock.experimentRepo.createExperiment).toHaveBeenCalledTimes(1);
    expect(drizzleMock.experimentRepo.createExperiment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ key: "exp_unique2" }),
    );
  });

  it("gives up after EXPERIMENT_KEY_MAX_ATTEMPTS collisions", async () => {
    drizzleMock.experimentRepo.generateExperimentKey.mockReturnValue("exp_alwayscollide");
    drizzleMock.experimentRepo.findExperimentByKey.mockResolvedValue({ id: "exp_existing" });

    const input = flagInput();
    await expect(createExperimentValidated(db, input)).rejects.toThrow();
    expect(drizzleMock.experimentRepo.findExperimentByKey).toHaveBeenCalledTimes(
      EXPERIMENT_KEY_MAX_ATTEMPTS,
    );
    expect(drizzleMock.experimentRepo.createExperiment).not.toHaveBeenCalled();
  });
});

describe("findOrCreateEveryoneAudience", () => {
  it("prefers the isDefault audience", async () => {
    drizzleMock.audienceRepo.findDefaultAudience.mockResolvedValue({ id: "aud_default" });

    const result = await findOrCreateEveryoneAudience(db, "prj_1");

    expect(result).toEqual({ id: "aud_default" });
    expect(drizzleMock.audienceRepo.findMatchAllAudiences).not.toHaveBeenCalled();
    expect(drizzleMock.audienceRepo.createAudience).not.toHaveBeenCalled();
  });

  it("falls back to a rules-{} audience preferring the one named Everyone", async () => {
    drizzleMock.audienceRepo.findDefaultAudience.mockResolvedValue(null);
    drizzleMock.audienceRepo.findMatchAllAudiences.mockResolvedValue([
      { id: "aud_all", name: "All" },
      { id: "aud_everyone", name: "Everyone" },
    ]);

    const result = await findOrCreateEveryoneAudience(db, "prj_1");

    expect(result).toEqual({ id: "aud_everyone" });
    expect(drizzleMock.audienceRepo.createAudience).not.toHaveBeenCalled();
  });

  it("creates Everyone with rules {} when nothing matches", async () => {
    drizzleMock.audienceRepo.findDefaultAudience.mockResolvedValue(null);
    drizzleMock.audienceRepo.findMatchAllAudiences.mockResolvedValue([]);
    drizzleMock.audienceRepo.createAudience.mockResolvedValue({ id: "aud_new" });

    const result = await findOrCreateEveryoneAudience(db, "prj_1");

    expect(result).toEqual({ id: "aud_new" });
    expect(drizzleMock.audienceRepo.createAudience).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: EVERYONE_AUDIENCE_NAME, rules: {} }),
    );
  });
});
