import { describe, expect, test } from "vitest";
import { shouldWakeStream } from "./config-stream";

const PROJECT = "prj_1";
const OTHER_PROJECT = "prj_2";
const ME = "sub_me";

describe("shouldWakeStream", () => {
  test("project-wide message wakes every stream in the project", () => {
    expect(shouldWakeStream({ projectId: PROJECT }, PROJECT, ME)).toBe(true);
  });

  test("project-wide message for another project wakes nothing", () => {
    expect(shouldWakeStream({ projectId: OTHER_PROJECT }, PROJECT, ME)).toBe(false);
  });

  test("targeted message wakes the named subscriber", () => {
    expect(
      shouldWakeStream({ projectId: PROJECT, subscriberIds: [ME] }, PROJECT, ME),
    ).toBe(true);
  });

  test("targeted message does NOT wake an unnamed subscriber", () => {
    // The whole point: an attribute write for one subscriber must not
    // cause every other stream in the project to re-evaluate.
    expect(
      shouldWakeStream(
        { projectId: PROJECT, subscriberIds: ["sub_someone_else"] },
        PROJECT,
        ME,
      ),
    ).toBe(false);
  });

  test("a stream that has not resolved an id yet falls back to waking", () => {
    // Before the initial evaluation completes we cannot know whether we
    // are targeted. Waking is a wasted evaluation; not waking would drop
    // a real update. Prefer the wasted work.
    expect(
      shouldWakeStream({ projectId: PROJECT, subscriberIds: [ME] }, PROJECT, null),
    ).toBe(true);
  });

  test("project scoping wins over subscriber matching", () => {
    expect(
      shouldWakeStream(
        { projectId: OTHER_PROJECT, subscriberIds: [ME] },
        PROJECT,
        ME,
      ),
    ).toBe(false);
  });
});
