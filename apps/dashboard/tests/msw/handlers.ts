import { http, HttpResponse } from "msw";

const BASE = "http://localhost:3000";

export const handlers = [
  http.get(`${BASE}/api/auth/get-session`, () =>
    HttpResponse.json({ user: { id: "u1", email: "tester@example.com" } }),
  ),

  http.get(`${BASE}/dashboard/projects`, () =>
    HttpResponse.json({
      data: {
        projects: [
          {
            id: "proj_1",
            name: "Acme",
            slug: "acme",
            role: "OWNER",
            createdAt: "2026-04-01T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/projects/:id`, ({ params }) =>
    HttpResponse.json({
      data: {
        project: {
          id: params.id,
          name: "Acme",
          slug: "acme",
          webhookUrl: null,
          hasWebhookSecret: false,
          settings: {},
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
          counts: { subscribers: 3, experiments: 1, featureFlags: 2, activeApiKeys: 1 },
          apiKeys: [],
        },
      },
    }),
  ),

  http.post(`${BASE}/dashboard/projects`, async ({ request }) => {
    const body = (await request.json()) as { name: string; slug: string };
    return HttpResponse.json({
      data: {
        project: {
          id: "proj_new",
          name: body.name,
          slug: body.slug,
          webhookUrl: null,
          hasWebhookSecret: false,
          settings: {},
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:00Z",
          counts: { subscribers: 0, experiments: 0, featureFlags: 0, activeApiKeys: 1 },
          apiKeys: [
            {
              id: "k_new",
              label: "default",
              publicKey: "rov_pub_test_xxx",
              environment: "PRODUCTION",
              createdAt: "2026-04-18T00:00:00Z",
            },
          ],
        },
        apiKey: { publicKey: "rov_pub_test_xxx", secretKey: "rov_sec_test_yyy" },
      },
    });
  }),

  http.get(`${BASE}/dashboard/projects/:id/subscribers`, ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const subscribers = q ? [] : [
      {
        id: "sub_1",
        appUserId: "alice",
        attributes: {},
        firstSeenAt: "2026-04-01T00:00:00Z",
        lastSeenAt: "2026-04-18T00:00:00Z",
        purchaseCount: 1,
        activeEntitlementKeys: ["premium"],
      },
      {
        id: "sub_2",
        appUserId: "bob",
        attributes: {},
        firstSeenAt: "2026-04-02T00:00:00Z",
        lastSeenAt: "2026-04-17T00:00:00Z",
        purchaseCount: 0,
        activeEntitlementKeys: [],
      },
    ];
    return HttpResponse.json({ data: { subscribers, nextCursor: null } });
  }),

  http.get(`${BASE}/dashboard/projects/:projectId/subscribers/:id`, () =>
    HttpResponse.json({
      data: {
        subscriber: {
          id: "sub_1",
          appUserId: "alice",
          attributes: { country: "TR" },
          firstSeenAt: "2026-04-01T00:00:00Z",
          lastSeenAt: "2026-04-18T00:00:00Z",
          deletedAt: null,
          mergedInto: null,
          access: [
            { entitlementKey: "premium", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
          ],
          purchases: [],
          creditBalance: "42",
          creditLedger: [],
          assignments: [],
          outgoingWebhooks: [],
        },
      },
    }),
  ),

  http.get(`${BASE}/dashboard/experiments`, () =>
    HttpResponse.json({
      data: {
        experiments: [
          {
            id: "exp_1",
            projectId: "proj_1",
            name: "Paywall v2 pricing",
            description: null,
            type: "PRICING",
            key: "paywall_v2_pricing",
            audienceId: "aud_default",
            status: "RUNNING",
            variants: [
              { id: "v_a", key: "a", weight: 50, payload: null },
              { id: "v_b", key: "b", weight: 50, payload: null },
            ],
            metrics: null,
            mutualExclusionGroup: null,
            startedAt: "2026-04-01T00:00:00Z",
            completedAt: null,
            winnerVariantId: null,
            createdAt: "2026-03-25T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/feature-flags`, () =>
    HttpResponse.json({
      data: {
        flags: [
          {
            id: "ff_1",
            key: "show_credits_in_paywall",
            description: "Surface the credit pack picker on the paywall.",
            type: "BOOLEAN",
            defaultValue: false,
            rules: [],
            isEnabled: true,
            createdAt: "2026-03-21T00:00:00Z",
            updatedAt: "2026-04-09T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/me`, () =>
    HttpResponse.json({
      data: {
        user: {
          id: "u1",
          email: "tester@example.com",
          name: "Test User",
          image: null,
          locale: "en",
          timezone: "UTC",
          createdAt: "2026-03-01T00:00:00Z",
        },
      },
    }),
  ),

  http.get(`${BASE}/dashboard/audiences`, () =>
    HttpResponse.json({
      data: {
        audiences: [
          {
            id: "aud_default",
            projectId: "proj_1",
            name: "All Users",
            description: "Matches every subscriber",
            rules: {},
            isDefault: true,
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
          },
          {
            id: "aud_eu",
            projectId: "proj_1",
            name: "EU customers",
            description: null,
            rules: { country: { $in: ["DE", "FR"] } },
            isDefault: false,
            createdAt: "2026-04-10T00:00:00Z",
            updatedAt: "2026-04-10T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/audiences/:id`, ({ params }) =>
    HttpResponse.json({
      data: {
        audience: {
          id: params.id,
          projectId: "proj_1",
          name: params.id === "aud_default" ? "All Users" : "EU customers",
          description:
            params.id === "aud_default" ? "Matches every subscriber" : null,
          rules:
            params.id === "aud_default"
              ? {}
              : { country: { $in: ["DE", "FR"] } },
          isDefault: params.id === "aud_default",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
    }),
  ),

  http.post(`${BASE}/dashboard/audiences`, async ({ request }) => {
    const body = (await request.json()) as {
      projectId: string;
      name: string;
      description?: string;
      rules?: Record<string, unknown>;
    };
    return HttpResponse.json({
      data: {
        audience: {
          id: "aud_new",
          projectId: body.projectId,
          name: body.name,
          description: body.description ?? null,
          rules: body.rules ?? {},
          isDefault: false,
          createdAt: "2026-05-26T00:00:00Z",
          updatedAt: "2026-05-26T00:00:00Z",
        },
      },
    });
  }),

  http.patch(
    `${BASE}/dashboard/audiences/:id`,
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          audience: {
            id: params.id,
            projectId: "proj_1",
            name: (body.name as string) ?? "EU customers",
            description: (body.description as string | null) ?? null,
            rules:
              (body.rules as Record<string, unknown>) ??
              { country: { $in: ["DE", "FR"] } },
            isDefault: false,
            createdAt: "2026-04-10T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.delete(`${BASE}/dashboard/audiences/:id`, () =>
    HttpResponse.json({ data: { deleted: true } }),
  ),
];
