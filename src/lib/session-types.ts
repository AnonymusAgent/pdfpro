/**
 * Browser-safe account types.
 *
 * Kept separate from `src/lib/server/*` so client components never import
 * server code or secrets.
 */

export type AdminRole = "admin" | "support";

export type SessionUserPublic = {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  plan: "free" | "premium";
  accountStatus: "active" | "suspended";
  createdAt: string;
  isAdmin: boolean;
  adminRole: AdminRole | null;
};

export type SubscriptionDTO = {
  id: string;
  planId: string;
  planName: string;
  interval: "month" | "year";
  billingMode: "one_time" | "recurring";
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  provider: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
  cancelledAt: string | null;
  planStorageBytes: number;
};

export type StorageSnapshotDTO = {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  percentUsed: number;
  fileCount: number;
  overQuota: boolean;
  uploadsBlocked: boolean;
  uploadsBlockedReason: string | null;
};

export type EntitlementsDTO = {
  plan: "free" | "premium";
  quotaBytes: number;
  usedBytes: number;
  fileCount: number;
  maxUploadBytes: number;
  storage: StorageSnapshotDTO;
  subscription: SubscriptionDTO | null;
  premiumEndsAt: string | null;
  inGracePeriod: boolean;
};

export type NotificationDTO = {
  id: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
  read: boolean;
};

export type SessionPayload = {
  user: SessionUserPublic | null;
  entitlements: EntitlementsDTO | null;
  notifications: NotificationDTO[];
  features: {
    googleSignIn: boolean;
    cardCheckout: boolean;
    checkoutUnavailableReason: string | null;
  };
};

export type PlanDTO = {
  id: string;
  name: string;
  description: string | null;
  interval: "month" | "year";
  priceMinor: number;
  currency: string;
  compareAtMinor: number | null;
  billingMode: "one_time" | "recurring";
  providerPlanId: string | null;
  storageBytes: number;
  features: string[];
  active: boolean;
  sortOrder: number;
};

export type PaymentDTO = {
  id: string;
  planName: string;
  interval: string | null;
  amountMinor: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "refunded" | "cancelled";
  provider: string;
  reference: string | null;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
};

export type CloudFileDTO = {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  checksumSha256: string | null;
};

export type SessionDeviceDTO = {
  id: string;
  device: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};
