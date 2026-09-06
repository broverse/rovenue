process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  resolveOrCreateSubscriber,
  resolveSubscriberForWrite,
} from "./resolve-or-create-subscriber";

// =============================================================
// `sdkInstalledAt` is SDK-create-path truth
// =============================================================
//
// The column is the denominator behind the `rev_per_install` chart, and
// its whole value depends on two invariants that only a real database
// can prove: it is stamped on the SDK's create path, and it is NEVER
// written anywhere else — not by the importer (which calls the lower
// level `resolveSubscriberForWrite` directly), and not on the conflict
// path of a repeat call.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_inst_${RUN_ID}`;

describe("sdkInstalledAt is SDK-create-path truth", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("sets up the project", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `INST ${RUN_ID}` });
  });

  it("stamps sdkInstalledAt when the SDK creates the subscriber", async () => {
    const { subscriber: s } = await resolveOrCreateSubscriber(
      PROJECT_ID,
      `rv_sdk_${RUN_ID}`,
      "ios",
    );
    expect(s.sdkInstalledAt).toBeInstanceOf(Date);
  });

  it("stamps it even when the façade sent no platform header", async () => {
    // The SDK path itself is the install signal — a façade that omits
    // `X-Rovenue-Platform` still installed the app. This is why the
    // column exists rather than the reader keying off the `platform`
    // attribute.
    const { subscriber: s } = await resolveOrCreateSubscriber(PROJECT_ID, `rv_np_${RUN_ID}`);
    expect(s.sdkInstalledAt).toBeInstanceOf(Date);
  });

  it("leaves sdkInstalledAt NULL on a non-SDK create path", async () => {
    const { subscriber } = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import_${RUN_ID}`,
    );
    expect(subscriber.sdkInstalledAt).toBeNull();
  });

  it("never re-stamps an existing row", async () => {
    const { subscriber: first } = await resolveOrCreateSubscriber(
      PROJECT_ID,
      `rv_twice_${RUN_ID}`,
      "ios",
    );
    const { subscriber: again } = await resolveOrCreateSubscriber(
      PROJECT_ID,
      `rv_twice_${RUN_ID}`,
      "android",
    );
    expect(again.sdkInstalledAt?.getTime()).toBe(
      first.sdkInstalledAt?.getTime(),
    );
  });

  it("does not stamp a row a later importer call touches", async () => {
    const { subscriber } = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import2_${RUN_ID}`,
    );
    expect(subscriber.sdkInstalledAt).toBeNull();
    const touched = await resolveSubscriberForWrite(
      PROJECT_ID,
      `rv_import2_${RUN_ID}`,
    );
    expect(touched.subscriber.sdkInstalledAt).toBeNull();
  });
});
