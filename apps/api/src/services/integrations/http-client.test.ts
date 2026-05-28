import { describe, expect, it, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "./http-client";

let agent: MockAgent | undefined;
afterEach(async () => {
  if (agent) {
    await agent.close();
    agent = undefined;
  }
});

describe("createUndiciHttpClient", () => {
  it("returns status + body verbatim", async () => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    agent
      .get("https://example.test")
      .intercept({ path: "/ping", method: "GET" })
      .reply(200, '{"pong":true}');
    const http = createUndiciHttpClient();
    const r = await http.request({ method: "GET", url: "https://example.test/ping" });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"pong":true}');
  });
});
