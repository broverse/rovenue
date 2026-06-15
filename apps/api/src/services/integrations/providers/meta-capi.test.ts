import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { createUndiciHttpClient } from "../http-client";
import { metaCapiProvider } from "./meta-capi";
import { hashPii } from "../hash-pii";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_EVENTS: RovenueEventKey[] = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
];

function makeEnvelope(
  overrides: Partial<RovenueEventEnvelope> = {},
): RovenueEventEnvelope {
  return {
    outboxEventId: "ob1",
    projectId: "proj1",
    eventType: "revenue.event.recorded",
    occurredAt: "2024-01-15T10:00:00.000Z",
    revenueEventKind: "RENEWAL",
    amount: "9.99",
    currency: "USD",
    identityContext: { email: "u@x.com" },
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  return {
    connectionId: "conn1",
    projectId: "proj1",
    enabledEvents: ALL_EVENTS,
    eventMapping: {},
    actionSource: "website",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// M1.5 — mapEvent tests
// ---------------------------------------------------------------------------

describe("metaCapiProvider.mapEvent", () => {
  it("maps RENEWAL → Purchase with hashed email", () => {
    const result = metaCapiProvider.mapEvent(makeEnvelope(), makeConfig(), {});
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: { em: string[] };
        custom_data: { value: number };
      }>;
    };
    expect(body.data[0].event_name).toBe("Purchase");
    expect(body.data[0].event_id).toBe("ob1");
    expect(body.data[0].user_data.em[0]).toBe(hashPii("u@x.com"));
    expect(body.data[0].custom_data.value).toBe(9.99);
  });

  it("skips when not in enabled_events", () => {
    const config = makeConfig({ enabledEvents: ["revenue.INITIAL"] });
    const result = metaCapiProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).toEqual({ skip: true, reason: "filtered_by_event_scope" });
  });

  it("skips when identityContext is empty", () => {
    const envelope = makeEnvelope({ identityContext: {} });
    const result = metaCapiProvider.mapEvent(envelope, makeConfig(), {});
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("test_event_code is forwarded into body", () => {
    const config = makeConfig({ testEventCode: "TEST123" });
    const result = metaCapiProvider.mapEvent(makeEnvelope(), config, {});
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as Record<string, unknown>;
    expect(body.test_event_code).toBe("TEST123");
  });

  it("throws when outboxEventId is empty (idempotency boundary missing)", () => {
    // event_id is the SOLE provider-side dedup key; an empty one would
    // silently degrade dedup, so mapEvent must fail loudly into the
    // retry/dead-letter path rather than build a payload.
    expect(() =>
      metaCapiProvider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        {},
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("a normal envelope still sets event_id from outboxEventId", () => {
    const result = metaCapiProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-ok-1" }),
      makeConfig(),
      {},
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as {
      data: Array<{ event_id: string }>;
    };
    expect(body.data[0]!.event_id).toBe("ob-ok-1");
  });
});

// ---------------------------------------------------------------------------
// M1.6 — validateCredentials + deliver tests
// ---------------------------------------------------------------------------

describe("metaCapiProvider.validateCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("200 → ok", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px123/, method: "GET" })
      .reply(200, '{"id":"px123"}');
    const http = createUndiciHttpClient();
    const result = await metaCapiProvider.validateCredentials(
      { access_token: "tok", pixel_id: "px123" },
      http,
    );
    expect(result).toEqual({ ok: true });
  });

  it("400 → !ok", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/v18\.0\/px_bad/, method: "GET" })
      .reply(400, '{"error":"bad"}');
    const http = createUndiciHttpClient();
    const result = await metaCapiProvider.validateCredentials(
      { access_token: "tok", pixel_id: "px_bad" },
      http,
    );
    expect(result.ok).toBe(false);
  });
});

describe("metaCapiProvider.deliver", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  const dummyPayload: ProviderPayload = {
    eventKey: "revenue.RENEWAL",
    providerEvent: "Purchase",
    body: { data: [] },
  };

  it("200 → ok + retriable:false", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/events/, method: "POST" })
      .reply(200, '{"events_received":1}');
    const http = createUndiciHttpClient();
    const result = await metaCapiProvider.deliver(
      dummyPayload,
      { access_token: "tok", pixel_id: "px1" },
      http,
    );
    expect(result.ok).toBe(true);
    expect(result.retriable).toBe(false);
  });

  it("401 → !ok + retriable:false", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/events/, method: "POST" })
      .reply(401, '{"error":"unauthorized"}');
    const http = createUndiciHttpClient();
    const result = await metaCapiProvider.deliver(
      dummyPayload,
      { access_token: "bad", pixel_id: "px1" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("500 → !ok + retriable:true", async () => {
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/events/, method: "POST" })
      .reply(500, '{"error":"server_error"}');
    const http = createUndiciHttpClient();
    const result = await metaCapiProvider.deliver(
      dummyPayload,
      { access_token: "tok", pixel_id: "px1" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("outgoing body carries data[].event_id === outboxEventId (server-side dedupe key)", async () => {
    // Build the real payload via mapEvent so we exercise the actual wiring
    // from envelope.outboxEventId → body.data[].event_id, then assert the
    // bytes that hit Meta's Conversions API contain that dedup key.
    const mapped = metaCapiProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-dedupe-123" }),
      makeConfig(),
      {},
    );
    expect(mapped).not.toHaveProperty("skip");
    const payload = mapped as ProviderPayload;

    let observedBody: string | undefined;
    agent
      .get("https://graph.facebook.com")
      .intercept({ path: /\/events/, method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: '{"events_received":1}' };
      });

    const http = createUndiciHttpClient();
    await metaCapiProvider.deliver(payload, { access_token: "tok", pixel_id: "px1" }, http);

    const sent = JSON.parse(observedBody ?? "{}") as {
      data: Array<{ event_id: string }>;
    };
    expect(sent.data[0]!.event_id).toBe("ob-dedupe-123");
  });
});
