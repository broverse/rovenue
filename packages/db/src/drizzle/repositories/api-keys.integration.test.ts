process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects } from "../schema";
import * as apiKeyRepo from "./api-keys";

// Browser origins are declared on the API key, which is what makes a key
// usable from a web page at all. The property these tests protect is that
// the field survives the READ path: the repository projects an explicit
// column list and maps rows by hand, so a column can exist in the table and
// still be invisible to every caller.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_ak_${RUN_ID}`;
const WEB_ORIGINS = ["https://app.customer.com", "http://localhost:3000"];

describe("apiKeyRepo allowedOrigins", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  beforeEach(async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `AK ${RUN_ID}` })
      .onConflictDoNothing();
  });

  it("defaults to an empty list, so an existing key is not browser-usable", async () => {
    const keyPublic = `pk_native_${RUN_ID}`;
    await apiKeyRepo.createApiKey(getDb(), {
      id: `key_native_${RUN_ID}`,
      projectId: PROJECT_ID,
      label: "native",
      keyPublic,
      keySecretHash: "hash",
      environment: "SANDBOX",
    });

    const loaded = await apiKeyRepo.findApiKeyByPublic(getDb(), keyPublic);
    expect(loaded?.allowedOrigins).toEqual([]);
  });

  it("round-trips an explicit origin list through findApiKeyByPublic", async () => {
    const keyPublic = `pk_web_${RUN_ID}`;
    await apiKeyRepo.createApiKey(getDb(), {
      id: `key_web_${RUN_ID}`,
      projectId: PROJECT_ID,
      label: "web",
      keyPublic,
      keySecretHash: "hash",
      environment: "SANDBOX",
      allowedOrigins: WEB_ORIGINS,
    });

    const loaded = await apiKeyRepo.findApiKeyByPublic(getDb(), keyPublic);
    expect(loaded?.allowedOrigins).toEqual(WEB_ORIGINS);
  });

  it("round-trips through findApiKeyById as well", async () => {
    // Both readers share one projection; asserting only the public-key path
    // would pass even if the other mapper dropped the field.
    const id = `key_byid_${RUN_ID}`;
    await apiKeyRepo.createApiKey(getDb(), {
      id,
      projectId: PROJECT_ID,
      label: "web-by-id",
      keyPublic: `pk_byid_${RUN_ID}`,
      keySecretHash: "hash",
      environment: "SANDBOX",
      allowedOrigins: WEB_ORIGINS,
    });

    const loaded = await apiKeyRepo.findApiKeyById(getDb(), id);
    expect(loaded?.allowedOrigins).toEqual(WEB_ORIGINS);
  });
});
