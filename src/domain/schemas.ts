import { z } from "zod";
import { CurrencyCodeSchema } from "../shared/currency.js";

export const DOMAIN_SCHEMA_VERSION = "1.0.0" as const;

export const SchemaVersionSchema = z.literal(DOMAIN_SCHEMA_VERSION);
export const PeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const EcosystemSchema = z.enum([
  "npm",
  "pypi",
  "crates",
  "maven",
  "nuget",
  "other",
]);

export const UsageSourceSchema = z.enum(["ide", "cli", "ci", "api"]);

export const VerificationStatusSchema = z.enum([
  "unverified",
  "pending",
  "verified",
  "rejected",
]);

export const PayoutStatusSchema = z.enum([
  "queued",
  "processing",
  "success",
  "failed",
  "skipped",
]);

export const PayoutAccountSchema = z.object({
  provider: z.enum(["stripe", "adyen", "other"]),
  account_id: z.string().min(1),
});

export const RoyaltyPolicySchema = z.object({
  max_share_per_library: z.number().min(0).max(1).default(0.2),
  min_floor_amount_minor: z.number().int().nonnegative().default(0),
  long_tail_weight: z.number().positive().default(1),
});

export const LibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ecosystem: EcosystemSchema,
  repo_url: z.string().url().optional(),
  maintainer_ids: z.array(z.string().min(1)).default([]),
  risk_score: z.number().min(0).max(1).default(0),
});

export const MaintainerSchema = z.object({
  id: z.string().min(1),
  payout_account: PayoutAccountSchema.nullable().optional(),
  verification_status: VerificationStatusSchema,
  trust_score: z.number().min(0).max(1).default(0.5),
});

export const UsageRecordSchema = z.object({
  id: z.string().min(1),
  agent_session_id: z.string().min(1),
  library_id: z.string().min(1),
  version: z.string().min(1),
  call_count: z.number().int().nonnegative(),
  source: UsageSourceSchema,
  ts: z.string().datetime(),
});

export const RoyaltyPoolSchema = z.object({
  period: PeriodSchema,
  total_amount_minor: z.number().int().positive(),
  policy: RoyaltyPolicySchema,
});

export const AllocationSchema = z.object({
  id: z.string().min(1),
  period: PeriodSchema,
  library_id: z.string().min(1),
  maintainer_id: z.string().min(1),
  amount_minor: z.number().int().nonnegative(),
  confidence_score: z.number().min(0).max(1),
  flags: z.array(z.string().min(1)).default([]),
});

export const PayoutSchema = z.object({
  id: z.string().min(1),
  period: PeriodSchema,
  maintainer_id: z.string().min(1),
  amount_minor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  status: PayoutStatusSchema,
  provider_tx_id: z.string().min(1).optional(),
});

export const DomainSchemaRegistry = z.object({
  schema_version: SchemaVersionSchema,
  library: LibrarySchema,
  maintainer: MaintainerSchema,
  usage_record: UsageRecordSchema,
  royalty_pool: RoyaltyPoolSchema,
  allocation: AllocationSchema,
  payout: PayoutSchema,
});

export type Library = z.infer<typeof LibrarySchema>;
export type Maintainer = z.infer<typeof MaintainerSchema>;
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export type RoyaltyPool = z.infer<typeof RoyaltyPoolSchema>;
export type Allocation = z.infer<typeof AllocationSchema>;
export type Payout = z.infer<typeof PayoutSchema>;
