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
];
