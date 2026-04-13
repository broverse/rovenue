import { describe, it, expect } from "vitest";
import { app } from "../src/app";
import { API_VERSION } from "../src/routes/health";

describe("GET /health", () => {
  it("returns ok status and version wrapped in { data }", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { status: "ok"; version: string };
    };

    expect(body).toEqual({
      data: { status: "ok", version: API_VERSION },
    });
  });

  it("returns 404 with error envelope for unknown route", async () => {
    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
