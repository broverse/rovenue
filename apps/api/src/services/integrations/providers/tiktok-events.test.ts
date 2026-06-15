import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { tiktokEventsProvider } from "./tiktok-events";
import { hashPii } from "../hash-pii";
import type {
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderPayload,
  ProviderCredentials,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import { createUndiciHttpClient } from "../http-client";

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
    outboxEventId: "ob2",
    projectId: "proj1",
    eventType: "revenue.event.recorded",
    occurredAt: "2024-01-15T10:00:00.000Z",
    revenueEventKind: "RENEWAL",
    amount: "19.99",
    currency: "USD",
    identityContext: { email: "u@x.com", phone: "15550001111" },
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

const makeCreds = (overrides: Partial<ProviderCredentials> = {}): ProviderCredentials => ({
  access_token: "tok",
  pixel_code: "CXX",
  ...overrides,
});

// ---------------------------------------------------------------------------
// M1.7 — mapEvent tests
// ---------------------------------------------------------------------------

describe("tiktokEventsProvider.mapEvent", () => {
  it("RENEWAL → Subscribe with hashed email + phone", () => {
    const result = tiktokEventsProvider.mapEvent(
      makeEnvelope(),
      makeConfig(),
      makeCreds(),
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    const body = payload.body as {
      event_source: string;
      event_source_id: string;
      data: Array<{
        event: string;
        user: { email: string; phone: string };
        properties: { value: number };
      }>;
    };
    expect(body.event_source).toBe("web");
    expect(body.event_source_id).toBe("CXX");
    expect(body.data[0].user.email).toBe(hashPii("u@x.com"));
    expect(body.data[0].user.phone).toBe(hashPii("15550001111"));
    expect(body.data[0].properties.value).toBe(19.99);
  });

  it("CREDIT_PURCHASE → CompletePayment", () => {
    const envelope = makeEnvelope({ revenueEventKind: "CREDIT_PURCHASE" });
    const result = tiktokEventsProvider.mapEvent(
      envelope,
      makeConfig(),
      makeCreds(),
    );
    expect(result).not.toHaveProperty("skip");
    const payload = result as ProviderPayload;
    expect(payload.providerEvent).toBe("CompletePayment");
  });

  it("skips when identityContext is empty", () => {
    const envelope = makeEnvelope({ identityContext: {} });
    const result = tiktokEventsProvider.mapEvent(
      envelope,
      makeConfig(),
      makeCreds(),
    );
    expect(result).toEqual({ skip: true, reason: "no_user_data" });
  });

  it("throws when outboxEventId is empty (idempotency boundary missing)", () => {
    // event_id is the SOLE provider-side dedup key; an empty one would
    // silently degrade dedup, so mapEvent must fail loudly into the
    // retry/dead-letter path rather than build a payload.
    expect(() =>
      tiktokEventsProvider.mapEvent(
        makeEnvelope({ outboxEventId: "" }),
        makeConfig(),
        makeCreds(),
      ),
    ).toThrow(/non-empty outboxEventId/);
  });

  it("a normal envelope still sets event_id from outboxEventId", () => {
    const result = tiktokEventsProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-ok-2" }),
      makeConfig(),
      makeCreds(),
    );
    expect(result).not.toHaveProperty("skip");
    const body = (result as ProviderPayload).body as {
      data: Array<{ event_id: string }>;
    };
    expect(body.data[0]!.event_id).toBe("ob-ok-2");
  });
});

// ---------------------------------------------------------------------------
// M1.8 — deliver tests
// ---------------------------------------------------------------------------

describe("tiktokEventsProvider.deliver", () => {
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
    providerEvent: "Subscribe",
    body: { event_source: "web", event_source_id: "CXX", data: [] },
  };

  it("POSTs to /event/track/ with Access-Token header", async () => {
    let observedTokenHeader: string | undefined;
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: "/open_api/v1.3/event/track/", method: "POST" })
      .reply((opts) => {
        // undici may pass headers as a flat string[] array or as a Record
        const h = opts.headers;
        if (Array.isArray(h)) {
          // flat array: [key, val, key, val, ...]
          for (let i = 0; i < h.length; i += 2) {
            if (String(h[i]).toLowerCase() === "access-token") {
              observedTokenHeader = String(h[i + 1]);
            }
          }
        } else if (h && typeof h === "object") {
          // object: lowercase keys
          observedTokenHeader =
            (h as Record<string, string>)["access-token"] ??
            (h as Record<string, string>)["Access-Token"];
        }
        return { statusCode: 200, data: '{"code":0}' };
      });
    const http = createUndiciHttpClient();
    await tiktokEventsProvider.deliver(dummyPayload, { access_token: "tok", pixel_code: "CXX" }, http);
    expect(observedTokenHeader).toBe("tok");
  });

  it("429 → retriable true", async () => {
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: "/open_api/v1.3/event/track/", method: "POST" })
      .reply(429, '{"code":40100}');
    const http = createUndiciHttpClient();
    const result = await tiktokEventsProvider.deliver(
      dummyPayload,
      { access_token: "tok", pixel_code: "CXX" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
  });

  it("400 → retriable false", async () => {
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: "/open_api/v1.3/event/track/", method: "POST" })
      .reply(400, '{"code":40000}');
    const http = createUndiciHttpClient();
    const result = await tiktokEventsProvider.deliver(
      dummyPayload,
      { access_token: "tok", pixel_code: "CXX" },
      http,
    );
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it("outgoing body carries data[].event_id === outboxEventId (TikTok dedupe key)", async () => {
    // Build the real payload via mapEvent so the envelope.outboxEventId →
    // body.data[].event_id wiring is exercised, then assert the bytes sent
    // to TikTok's Events API carry that dedup key.
    const mapped = tiktokEventsProvider.mapEvent(
      makeEnvelope({ outboxEventId: "ob-dedupe-456" }),
      makeConfig(),
      makeCreds(),
    );
    expect(mapped).not.toHaveProperty("skip");
    const payload = mapped as ProviderPayload;

    let observedBody: string | undefined;
    agent
      .get("https://business-api.tiktok.com")
      .intercept({ path: "/open_api/v1.3/event/track/", method: "POST" })
      .reply((opts) => {
        observedBody = opts.body as string;
        return { statusCode: 200, data: '{"code":0}' };
      });

    const http = createUndiciHttpClient();
    await tiktokEventsProvider.deliver(payload, makeCreds(), http);

    const sent = JSON.parse(observedBody ?? "{}") as {
      data: Array<{ event_id: string }>;
    };
    expect(sent.data[0]!.event_id).toBe("ob-dedupe-456");
  });
});
