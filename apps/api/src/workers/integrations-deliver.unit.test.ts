import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runDeliverStep,
  ensureIntegrationsDeliverWorker,
  type DeliverStepDeps,
} from "./integrations-deliver";
import type { IntegrationsDeliverJob } from "../queues/integrations";
import type { IntegrationConnection, IntegrationDelivery } from "@rovenue/db";

// =============================================================
// Shared fixtures
// =============================================================

const envelope: IntegrationsDeliverJob["envelope"] = {
  outboxEventId: "ob1",
  projectId: "p1",
  eventType: "revenue.event.recorded",
  occurredAt: new Date().toISOString(),
};

const makeJob = (overrides?: Partial<IntegrationsDeliverJob>): IntegrationsDeliverJob => ({
  connectionId: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  envelope,
  ...overrides,
});

const makeConn = (overrides?: Partial<IntegrationConnection>): IntegrationConnection => ({
  id: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  displayName: "Test",
  credentialsCipher: "encrypted",
  credentialsHint: "hint",
  enabledEvents: ["revenue.event.recorded"],
  eventMapping: {},
  actionSource: "app",
  testEventCode: null,
  isEnabled: true,
  lastValidatedAt: null,
  lastError: null,
  lastBackfillAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as IntegrationConnection);

const makeDelivery = (id: string): IntegrationDelivery => ({
  id,
  connectionId: "c1",
  projectId: "p1",
  providerId: "META_CAPI",
  outboxEventId: "ob1",
  eventKey: "revenue.event.recorded",
  providerEvent: "Purchase",
  status: "pending",
  attempt: 0,
  skipReason: null,
  httpStatus: null,
  responseBody: null,
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as IntegrationDelivery);

// =============================================================
// runDeliverStep tests
// =============================================================

describe("runDeliverStep", () => {
  it("returns connection_disabled when connection is not found", async () => {
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(undefined),
      decrypt: vi.fn(),
      insertPendingDelivery: vi.fn(),
      updateDeliveryStatus: vi.fn(),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn(),
        deliver: vi.fn(),
      },
      http: { request: vi.fn() },
      attempt: 0,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("connection_disabled");
    expect(deps.insertPendingDelivery).not.toHaveBeenCalled();
  });

  it("returns connection_disabled when isEnabled is false", async () => {
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn({ isEnabled: false })),
      decrypt: vi.fn(),
      insertPendingDelivery: vi.fn(),
      updateDeliveryStatus: vi.fn(),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn(),
        deliver: vi.fn(),
      },
      http: { request: vi.fn() },
      attempt: 0,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("connection_disabled");
  });

  it("returns skipped when mapEvent returns skip", async () => {
    const deliveryRow = makeDelivery("d1");
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: vi.fn().mockReturnValue({ accessToken: "tok" }),
      insertPendingDelivery: vi.fn().mockResolvedValue(deliveryRow),
      updateDeliveryStatus: vi.fn(),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn().mockReturnValue({ skip: true, reason: "no_mapping" }),
        deliver: vi.fn(),
      },
      http: { request: vi.fn() },
      attempt: 0,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("skipped");
    expect(deps.insertPendingDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", skipReason: "no_mapping" }),
    );
    expect(deps.updateDeliveryStatus).not.toHaveBeenCalled();
  });

  it("returns succeeded on successful delivery", async () => {
    const deliveryRow = makeDelivery("d1");
    const updatedRow = { ...deliveryRow, status: "succeeded" as const };
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: vi.fn().mockReturnValue({ accessToken: "tok" }),
      insertPendingDelivery: vi.fn().mockResolvedValue(deliveryRow),
      updateDeliveryStatus: vi.fn().mockResolvedValue(updatedRow),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn().mockReturnValue({
          eventKey: "revenue.event.recorded",
          providerEvent: "Purchase",
          body: { data: [] },
        }),
        deliver: vi.fn().mockResolvedValue({
          ok: true,
          httpStatus: 200,
          responseBody: "{}",
          retriable: false,
        }),
      },
      http: { request: vi.fn() },
      attempt: 0,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("succeeded");
    expect(deps.updateDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", httpStatus: 200 }),
    );
  });

  it("returns dead_letter when retriable is false", async () => {
    const deliveryRow = makeDelivery("d1");
    const updatedRow = { ...deliveryRow, status: "dead_letter" as const };
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: vi.fn().mockReturnValue({ accessToken: "tok" }),
      insertPendingDelivery: vi.fn().mockResolvedValue(deliveryRow),
      updateDeliveryStatus: vi.fn().mockResolvedValue(updatedRow),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn().mockReturnValue({
          eventKey: "revenue.event.recorded",
          providerEvent: "Purchase",
          body: { data: [] },
        }),
        deliver: vi.fn().mockResolvedValue({
          ok: false,
          httpStatus: 400,
          responseBody: "bad request",
          errorMessage: "invalid payload",
          retriable: false,
        }),
      },
      http: { request: vi.fn() },
      attempt: 0,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("dead_letter");
    expect(deps.updateDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dead_letter" }),
    );
  });

  it("publishes live event + skips audit on success", async () => {
    const deliveryRow = makeDelivery("d1");
    const updatedRow = { ...deliveryRow, status: "succeeded" as const };
    const publishLiveEvent = vi.fn().mockResolvedValue(undefined);
    const auditDeadLetter = vi.fn().mockResolvedValue(undefined);
    const captureSentry = vi.fn();
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: vi.fn().mockReturnValue({ accessToken: "tok" }),
      insertPendingDelivery: vi.fn().mockResolvedValue(deliveryRow),
      updateDeliveryStatus: vi.fn().mockResolvedValue(updatedRow),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn().mockReturnValue({
          eventKey: "revenue.event.recorded",
          providerEvent: "Purchase",
          body: { data: [] },
        }),
        deliver: vi.fn().mockResolvedValue({
          ok: true,
          httpStatus: 200,
          responseBody: "{}",
          retriable: false,
        }),
      },
      http: { request: vi.fn() },
      attempt: 0,
      publishLiveEvent,
      auditDeadLetter,
      captureSentry,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("succeeded");
    expect(publishLiveEvent).toHaveBeenCalledOnce();
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(auditDeadLetter).not.toHaveBeenCalled();
    expect(captureSentry).not.toHaveBeenCalled();
  });

  it("fires audit + sentry on dead_letter", async () => {
    const deliveryRow = makeDelivery("d1");
    const updatedRow = { ...deliveryRow, status: "dead_letter" as const };
    const publishLiveEvent = vi.fn().mockResolvedValue(undefined);
    const auditDeadLetter = vi.fn().mockResolvedValue(undefined);
    const captureSentry = vi.fn();
    const deps: DeliverStepDeps = {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: vi.fn().mockReturnValue({ accessToken: "tok" }),
      insertPendingDelivery: vi.fn().mockResolvedValue(deliveryRow),
      updateDeliveryStatus: vi.fn().mockResolvedValue(updatedRow),
      provider: {
        id: "META_CAPI",
        defaultEventMapping: {},
        validateCredentials: vi.fn(),
        mapEvent: vi.fn().mockReturnValue({
          eventKey: "revenue.event.recorded",
          providerEvent: "Purchase",
          body: { data: [] },
        }),
        deliver: vi.fn().mockResolvedValue({
          ok: false,
          httpStatus: 400,
          responseBody: "bad request",
          errorMessage: "invalid payload",
          retriable: false,
        }),
      },
      http: { request: vi.fn() },
      attempt: 0,
      publishLiveEvent,
      auditDeadLetter,
      captureSentry,
    };

    const result = await runDeliverStep(makeJob(), deps);
    expect(result.outcome).toBe("dead_letter");
    expect(publishLiveEvent).toHaveBeenCalledOnce();
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dead_letter" }),
    );
    expect(auditDeadLetter).toHaveBeenCalledOnce();
    expect(captureSentry).toHaveBeenCalledOnce();
  });

  it("returns succeeded without re-delivering when insertPendingDelivery hits dedupe (returns undefined)", async () => {
    const insertPendingDelivery = vi.fn().mockResolvedValue(undefined); // simulate UNIQUE conflict
    const updateDeliveryStatus = vi.fn();
    const provider = {
      id: "META_CAPI" as const,
      defaultEventMapping: {},
      validateCredentials: vi.fn(),
      mapEvent: vi.fn().mockReturnValue({
        eventKey: "revenue.RENEWAL",
        providerEvent: "Purchase",
        body: {},
      }),
      deliver: vi.fn(),
    };
    const r = await runDeliverStep(makeJob(), {
      loadConnection: vi.fn().mockResolvedValue(makeConn()),
      decrypt: () => ({ pixel_id: "p", access_token: "t" }),
      insertPendingDelivery,
      updateDeliveryStatus,
      provider: provider as never,
      http: { request: vi.fn() } as never,
      attempt: 1,
    });
    expect(r.outcome).toBe("succeeded");
    expect(provider.deliver).not.toHaveBeenCalled();
    expect(updateDeliveryStatus).not.toHaveBeenCalled();
  });
});

// =============================================================
// ensureIntegrationsDeliverWorker tests (M2.5)
// =============================================================

describe("ensureIntegrationsDeliverWorker", () => {
  it("returns an object with a stop() function", async () => {
    const handle = await ensureIntegrationsDeliverWorker({ autoStart: false });
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });
});
