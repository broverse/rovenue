import type { SchemaTable } from "./types";

export const SCHEMA_TABLES: ReadonlyArray<SchemaTable> = [
  {
    name: "subscriptions",
    rows: "482K",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscriber_id", type: "uuid" },
      { name: "product_id", type: "string" },
      { name: "status", type: "enum" },
      { name: "platform", type: "enum" },
      { name: "country_code", type: "string" },
      { name: "started_at", type: "timestamp" },
      { name: "expires_at", type: "timestamp" },
      { name: "mrr_usd", type: "numeric" },
      { name: "ltv_usd", type: "numeric" },
      { name: "is_trial", type: "bool" },
    ],
  },
  {
    name: "transactions",
    rows: "8.4M",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscription_id", type: "uuid" },
      { name: "amount_usd", type: "numeric" },
      { name: "currency", type: "string" },
      { name: "occurred_at", type: "timestamp" },
      { name: "kind", type: "enum" },
    ],
  },
  {
    name: "subscribers",
    rows: "124K",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "email", type: "string" },
      { name: "created_at", type: "timestamp" },
      { name: "channel", type: "string" },
      { name: "platform_first", type: "enum" },
    ],
  },
  {
    name: "events",
    rows: "38.2M",
    columns: [
      { name: "id", type: "ulid", pk: true },
      { name: "type", type: "string" },
      { name: "subscriber_id", type: "uuid" },
      { name: "occurred_at", type: "timestamp" },
      { name: "payload", type: "jsonb" },
    ],
  },
  {
    name: "experiments_assignments",
    rows: "604K",
    columns: [
      { name: "subscriber_id", type: "uuid" },
      { name: "experiment_id", type: "string" },
      { name: "variant", type: "string" },
      { name: "assigned_at", type: "timestamp" },
    ],
  },
  {
    name: "credits_ledger",
    rows: "2.1M",
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "subscriber_id", type: "uuid" },
      { name: "delta", type: "numeric" },
      { name: "reason", type: "enum" },
      { name: "occurred_at", type: "timestamp" },
    ],
  },
];

export const AI_SUGGESTIONS: ReadonlyArray<string> = [
  "addMomDelta",
  "filterIos",
  "convertWeekly",
  "groupByProduct",
  "limitTopFive",
];
