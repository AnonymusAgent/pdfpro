import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uuid,
  bigint,
  bigserial,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* Existing workspace tables (additive owner columns; keep legacy rows) */
/* ------------------------------------------------------------------ */

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  size: integer("size").notNull().default(0),
  pages: integer("pages").notNull().default(0),
  kind: text("kind").notNull().default("pdf"),
  starred: boolean("starred").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  workspaceId: text("workspace_id").notNull().default("legacy"),
});

export const signatures = pgTable("signatures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  dataUrl: text("data_url").notNull(),
  kind: text("kind").notNull().default("draw"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  workspaceId: text("workspace_id").notNull().default("legacy"),
});

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: text("workspace_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.key] })]);

export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("completed"),
  inputSize: integer("input_size").notNull().default(0),
  outputSize: integer("output_size").notNull().default(0),
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  workspaceId: text("workspace_id").notNull().default("legacy"),
});

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    plan: text("plan").notNull().default("free"),
    accountStatus: text("account_status").notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("users_email_normalized_key").on(t.emailNormalized)],
);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  company: text("company"),
  country: text("country"),
  timezone: text("timezone"),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("email_tokens_token_hash_key").on(t.tokenHash),
    index("email_tokens_user_kind_idx").on(t.userId, t.kind),
  ],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("oauth_accounts_provider_account_key").on(t.provider, t.providerAccountId)],
);

export const adminRoles = pgTable("admin_roles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  grantedBy: uuid("granted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ------------------------------------------------------------------ */
/* Cloud storage                                                       */
/* ------------------------------------------------------------------ */

export const storageUsage = pgTable("storage_usage", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userFiles = pgTable(
  "user_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull().default("application/pdf"),
    storageDriver: text("storage_driver").notNull().default("local"),
    storageKey: text("storage_key").notNull(),
    checksumSha256: text("checksum_sha256"),
    pages: integer("pages"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_files_storage_key_key").on(t.storageKey),
    index("user_files_user_idx").on(t.userId, t.status, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Plans, subscriptions, payments                                      */
/* ------------------------------------------------------------------ */

export const subscriptionPlans = pgTable("subscription_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  interval: text("interval").notNull(),
  priceMinor: integer("price_minor").notNull().default(0),
  currency: text("currency").notNull().default("PKR"),
  compareAtMinor: integer("compare_at_minor"),
  billingMode: text("billing_mode").notNull().default("one_time"),
  provider: text("provider").notNull().default("safepay"),
  providerPlanId: text("provider_plan_id"),
  storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(2_147_483_648),
  features: jsonb("features").notNull().default([]),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    provider: text("provider").notNull().default("safepay"),
    providerSubscriptionId: text("provider_subscription_id"),
    providerReference: text("provider_reference"),
    status: text("status").notNull().default("pending"),
    billingMode: text("billing_mode").notNull().default("one_time"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("subscriptions_provider_sub_key")
      .on(t.provider, t.providerSubscriptionId)
      .where(sql`${t.providerSubscriptionId} is not null`),
    index("subscriptions_user_idx").on(t.userId, t.createdAt),
    index("subscriptions_lifecycle_idx").on(t.status, t.currentPeriodEnd),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id"),
    planId: text("plan_id").references(() => subscriptionPlans.id),
    provider: text("provider").notNull().default("safepay"),
    providerPaymentId: text("provider_payment_id"),
    providerReference: text("provider_reference"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_provider_payment_key")
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} is not null`),
    index("payments_user_idx").on(t.userId, t.createdAt),
    index("payments_status_idx").on(t.status, t.createdAt),
  ],
);

export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type"),
    signatureValid: boolean("signature_valid").notNull().default(false),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("received"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("payment_webhook_events_provider_event_key").on(t.provider, t.eventId),
    index("payment_webhook_events_received_idx").on(t.receivedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Platform operations                                                 */
/* ------------------------------------------------------------------ */

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    kind: text("kind").notNull(),
    transport: text("transport").notNull(),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("email_outbox_created_idx").on(t.createdAt)],
);

export const userNotifications = pgTable(
  "user_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("user_notifications_user_idx").on(t.userId, t.createdAt)],
);
