import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { queriesRoute } from "./queries";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_queriesroute_${RUN_ID}`;

function buildApp() {
  return new Hono().route("/projects/:projectId/queries", queriesRoute);
}

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `queriesroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!queriesroute";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `Queries User ${suffix}` },
  });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie) throw new Error(`no set-cookie for ${suffix}`);
  return { userId: signUp.user.id, cookie };
}

async function seedProjectWithMember(userId: string) {
  const db = getDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: `Queries Route Project ${RUN_ID}` });
  await db.insert(drizzle.schema.projectMembers).values({ projectId: PROJECT_ID, userId, role: "OWNER" });
}

describe("GET /projects/:projectId/queries/schema", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("is not shadowed by GET /:id", async () => {
    const { userId, cookie } = await createUserAndSession("a");
    await seedProjectWithMember(userId);
    const app = buildApp();

    const res = await app.request(`/projects/${PROJECT_ID}/queries/schema`, {
      headers: { cookie },
    });

    // The shadowing bug returns 404 "Query not found" because /:id
    // captured "schema". The static route must win regardless of how
    // schema introspection itself resolves (ClickHouse degrades in dev).
    expect(res.status).not.toBe(404);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Query not found");
  });
});
