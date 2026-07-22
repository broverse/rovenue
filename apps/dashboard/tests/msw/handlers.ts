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
            { accessId: "acs_demo_premium000000000", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
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

  http.get(`${BASE}/dashboard/experiments/:id`, ({ params }) =>
    HttpResponse.json({
      data: {
        experiment: {
          id: params.id,
          projectId: "proj_1",
          name: "Paywall v2 pricing",
          description: null,
          type: "PAYWALL",
          key: "paywall_v2_pricing",
          audienceId: "aud_default",
          status: "RUNNING",
          variants: [
            { id: "control", name: "Control", value: null, weight: 0.5 },
            { id: "variant_a", name: "Variant A", value: null, weight: 0.5 },
          ],
          metrics: null,
          mutualExclusionGroup: null,
          startedAt: "2026-04-01T00:00:00Z",
          completedAt: null,
          winnerVariantId: null,
          createdAt: "2026-03-25T00:00:00Z",
          updatedAt: "2026-04-01T00:00:00Z",
        },
        summary: { totalUsers: 0, conversions: 0, conversionRate: 0 },
      },
    }),
  ),

  http.get(`${BASE}/dashboard/experiments/:id/results`, ({ params }) =>
    HttpResponse.json({
      data: {
        experimentId: params.id,
        status: "RUNNING",
        variants: [],
        conversion: null,
        revenue: null,
        srm: null,
        sampleSize: null,
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

  // -------------------------------------------------------------
  // Credits — rollup + grant
  // -------------------------------------------------------------

  http.get(
    `${BASE}/dashboard/projects/:projectId/credits/rollup`,
    () =>
      HttpResponse.json({
        data: {
          window: {
            from: "2026-04-28T00:00:00.000Z",
            to: "2026-05-25T23:59:59.999Z",
            days: 28,
          },
          kpis: {
            outstanding: 14_820_000,
            outstandingWalletCount: 89_142,
            issued28d: 2_410_000,
            burned28d: 1_920_000,
            revenue28dUsd: "182400.00",
            breakagePct: 3.4,
          },
          flow: {
            inflow: 2_410_000,
            outflow: 1_920_000,
            balance: 14_820_000,
            inflowByType: {
              purchase: 2_180_000,
              bonus: 154_000,
              refund: 38_000,
              transferIn: 38_000,
              spend: 0,
              expire: 0,
              transferOut: 0,
            },
            outflowByType: {
              purchase: 0,
              bonus: 0,
              refund: 0,
              transferIn: 0,
              spend: 1_810_000,
              expire: 86_000,
              transferOut: 24_000,
            },
            balanceByType: {
              paid: 6_080_000,
              promo: 5_340_000,
              transfer: 3_400_000,
            },
          },
          liability: {
            paidShare: 0.41,
            promoShare: 0.36,
            transferShare: 0.23,
            paidReserveUsd: "462348.00",
            reserveDeltaPct: 6.4,
            averageAgeDays: 22.4,
          },
          volume: [],
          packages: [],
          topBurners: [],
          ledger: [],
        },
      }),
  ),

  http.post(
    `${BASE}/dashboard/projects/:projectId/credits`,
    async ({ request }) => {
      const body = (await request.json()) as {
        subscriberId: string;
        amount: number;
        type?: "BONUS" | "PURCHASE" | "REFUND";
      };
      return HttpResponse.json({
        data: {
          entry: {
            id: "cl_msw_1",
            subscriberId: body.subscriberId,
            type: body.type ?? "BONUS",
            amount: body.amount,
            balance: body.amount,
            referenceType: null,
            referenceId: null,
            description: null,
            createdAt: new Date().toISOString(),
          },
          balance: body.amount,
        },
      });
    },
  ),

  // -------------------------------------------------------------
  // Cohorts — CRUD + retention
  // -------------------------------------------------------------

  http.get(`${BASE}/dashboard/projects/:projectId/cohorts`, () =>
    HttpResponse.json({
      data: {
        cohorts: [
          {
            id: "coh_1",
            projectId: "proj_1",
            userId: "u1",
            name: "High-value users",
            description: "Spent >$50 lifetime",
            rules: {
              match: "all",
              filters: [{ field: "country", op: "in", value: ["US", "CA"] }],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.post(
    `${BASE}/dashboard/projects/:projectId/cohorts`,
    async ({ request }) => {
      const body = (await request.json()) as {
        name: string;
        description?: string | null;
        rules: unknown;
      };
      return HttpResponse.json({
        data: {
          cohort: {
            id: "coh_new",
            projectId: "proj_1",
            userId: "u1",
            name: body.name,
            description: body.description ?? null,
            rules: body.rules,
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-26T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    ({ params }) =>
      HttpResponse.json({
        data: {
          cohort: {
            id: params.id,
            projectId: "proj_1",
            userId: "u1",
            name: "High-value users",
            description: "Spent >$50 lifetime",
            rules: {
              match: "all",
              filters: [{ field: "country", op: "in", value: ["US", "CA"] }],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        },
      }),
  ),

  http.patch(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          cohort: {
            id: params.id,
            projectId: "proj_1",
            userId: "u1",
            name: (body.name as string) ?? "High-value users",
            description: (body.description as string | null) ?? null,
            rules: body.rules ?? {
              match: "all",
              filters: [],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.delete(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    () => HttpResponse.json({ data: { deleted: true } }),
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id/retention`,
    () =>
      HttpResponse.json({
        data: {
          size: 4821,
          granularity: "week",
          periods: 13,
          points: [
            { period: 0, active: 4821, pct: 100 },
            { period: 1, active: 3961, pct: 82.1 },
            { period: 2, active: 3520, pct: 73 },
            { period: 3, active: 3208, pct: 66.5 },
            { period: 4, active: 3007, pct: 62.4 },
            { period: 5, active: 2853, pct: 59.2 },
            { period: 6, active: 2740, pct: 56.8 },
            { period: 7, active: 2643, pct: 54.8 },
            { period: 8, active: 2559, pct: 53.1 },
            { period: 9, active: 2488, pct: 51.6 },
            { period: 10, active: 2425, pct: 50.3 },
            { period: 11, active: 2371, pct: 49.2 },
            { period: 12, active: 2326, pct: 48.2 },
          ],
        },
      }),
  ),

  // -------------------------------------------------------------
  // Refund Shield — settings / responses / metrics
  // -------------------------------------------------------------

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
    () =>
      HttpResponse.json({
        data: {
          settings: {
            enabled: false,
            responseDelayMinutes: 60,
            consentAcknowledgedAt: null,
            consentAcknowledgedBy: null,
          },
        },
      }),
  ),

  http.put(
    `${BASE}/dashboard/projects/:projectId/refund-shield/settings`,
    async ({ request }) => {
      const body = (await request.json()) as {
        enabled: boolean;
        responseDelayMinutes?: number;
        consentAcknowledged?: boolean;
      };
      return HttpResponse.json({
        data: {
          settings: {
            enabled: body.enabled,
            responseDelayMinutes: body.responseDelayMinutes ?? 60,
            consentAcknowledgedAt: body.consentAcknowledged
              ? "2026-05-28T00:00:00.000Z"
              : null,
            consentAcknowledgedBy: body.consentAcknowledged ? "u1" : null,
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/responses`,
    ({ request }) => {
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const outcome = url.searchParams.get("outcome");

      const all = [
        {
          id: "rss_sent_declined",
          projectId: "proj_1",
          subscriberId: "sub_1",
          appleNotificationUuid: "notif-1111",
          appleOriginalTransactionId: "2000000111111111",
          appleTransactionId: "2000000111111112",
          detectedAt: "2026-05-26T08:00:00.000Z",
          scheduledFor: "2026-05-26T09:00:00.000Z",
          sentAt: "2026-05-26T09:00:14.000Z",
          status: "SENT",
          outcome: "REFUND_DECLINED",
          outcomeReceivedAt: "2026-05-26T15:21:00.000Z",
          appleHttpStatus: 202,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-26T08:00:00.000Z",
          updatedAt: "2026-05-26T15:21:00.000Z",
        },
        {
          id: "rss_pending",
          projectId: "proj_1",
          subscriberId: "sub_2",
          appleNotificationUuid: "notif-2222",
          appleOriginalTransactionId: "2000000222222221",
          appleTransactionId: "2000000222222222",
          detectedAt: "2026-05-28T07:30:00.000Z",
          scheduledFor: "2026-05-28T08:30:00.000Z",
          sentAt: null,
          status: "PENDING",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: null,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-28T07:30:00.000Z",
          updatedAt: "2026-05-28T07:30:00.000Z",
        },
        {
          id: "rss_skipped_disabled",
          projectId: "proj_1",
          subscriberId: null,
          appleNotificationUuid: "notif-3333",
          appleOriginalTransactionId: "2000000333333331",
          appleTransactionId: "2000000333333332",
          detectedAt: "2026-05-20T11:00:00.000Z",
          scheduledFor: "2026-05-20T11:00:00.000Z",
          sentAt: null,
          status: "SKIPPED_DISABLED",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: null,
          error: null,
          retryCount: 0,
          createdAt: "2026-05-20T11:00:00.000Z",
          updatedAt: "2026-05-20T11:00:00.000Z",
        },
        {
          id: "rss_failed",
          projectId: "proj_1",
          subscriberId: "sub_3",
          appleNotificationUuid: "notif-4444",
          appleOriginalTransactionId: "2000000444444441",
          appleTransactionId: "2000000444444442",
          detectedAt: "2026-05-15T03:00:00.000Z",
          scheduledFor: "2026-05-15T04:00:00.000Z",
          sentAt: null,
          status: "FAILED",
          outcome: null,
          outcomeReceivedAt: null,
          appleHttpStatus: 500,
          error: "SLA_EXCEEDED",
          retryCount: 5,
          createdAt: "2026-05-15T03:00:00.000Z",
          updatedAt: "2026-05-15T15:00:00.000Z",
        },
      ];

      let filtered = all;
      if (status) filtered = filtered.filter((r) => r.status === status);
      if (outcome) filtered = filtered.filter((r) => r.outcome === outcome);

      return HttpResponse.json({
        data: { responses: filtered, nextCursor: null },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/responses/:rid`,
    ({ params }) => {
      const rid = String(params.rid);
      const requestPayload =
        rid === "rss_sent_declined"
          ? {
              customerConsented: true,
              consumptionStatus: 1,
              platform: 1,
              sampleContentProvided: false,
              deliveryStatus: 0,
              accountTenure: 5,
              playTime: 4,
              lifetimeDollarsPurchased: 3,
              lifetimeDollarsRefunded: 0,
              userStatus: 1,
              refundPreference: 2,
              appAccountToken: "00000000-0000-4000-8000-000000000001",
            }
          : null;
      return HttpResponse.json({
        data: {
          response: {
            id: rid,
            projectId: "proj_1",
            subscriberId: rid === "rss_skipped_disabled" ? null : "sub_1",
            appleNotificationUuid: `notif-${rid}`,
            appleOriginalTransactionId: "2000000111111111",
            appleTransactionId: "2000000111111112",
            detectedAt: "2026-05-26T08:00:00.000Z",
            scheduledFor: "2026-05-26T09:00:00.000Z",
            sentAt:
              rid === "rss_sent_declined" ? "2026-05-26T09:00:14.000Z" : null,
            status: rid === "rss_pending" ? "PENDING" : "SENT",
            outcome: rid === "rss_sent_declined" ? "REFUND_DECLINED" : null,
            outcomeReceivedAt:
              rid === "rss_sent_declined" ? "2026-05-26T15:21:00.000Z" : null,
            appleHttpStatus: rid === "rss_sent_declined" ? 202 : null,
            appleResponseBody: rid === "rss_sent_declined" ? "" : null,
            error: null,
            retryCount: 0,
            createdAt: "2026-05-26T08:00:00.000Z",
            updatedAt: "2026-05-26T15:21:00.000Z",
            requestPayload,
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/refund-shield/metrics`,
    () =>
      HttpResponse.json({
        data: {
          sentCount: 184,
          outcomeCount: 162,
          declinedCount: 121,
          approvedCount: 36,
          reversedCount: 5,
          winRate: 0.7469,
          estimatedRevenueSavedCents: 482400,
          range: {
            since: "2026-04-28T00:00:00.000Z",
            until: "2026-05-28T00:00:00.000Z",
          },
        },
      }),
  ),

  // -------------------------------------------------------------
  // Billing usage metering
  // -------------------------------------------------------------

  http.get(
    `${BASE}/dashboard/projects/:projectId/billing/usage`,
    () =>
      HttpResponse.json({
        data: {
          tier: "indie",
          cycle: "monthly",
          periodStart: "2026-06-01T00:00:00Z",
          periodEnd: "2026-06-30T23:59:59Z",
          meters: [
            {
              key: "mtr",
              current: 12500,
              limit: 50000,
              cap: "hard",
              unit: "usd",
              available: true,
            },
            {
              key: "events",
              current: 3_200_000,
              limit: 10_000_000,
              cap: "hard",
              unit: "count",
              available: true,
            },
            {
              key: "sql_queries",
              current: null,
              limit: null,
              cap: "soft",
              unit: "count",
              available: false,
            },
          ],
        },
      }),
  ),
];
