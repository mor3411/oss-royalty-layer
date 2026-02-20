import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertToolAuthorized,
  type AuthorizationRuntimeEnvironment,
} from "./authz.js";
import {
  DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  assertToolInputVetting,
  assertToolOutputSanity,
  assertToolRiskAllowed,
  type ToolRiskLevel,
} from "./guardrails.js";
import { PeriodSchema } from "../domain/index.js";
import { CurrencyCodeSchema } from "../shared/currency.js";
import {
  PayoutBatchEntrySchema,
  PayoutBatchFlagSchema,
  type CreatePayoutBatchOutput,
} from "./create-payout-batch.js";

const SAFE_INTEGER_SCHEMA = z.number().int().safe();
const PayoutBatchHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const PayoutBatchAdjustmentSchema = z.object({
  maintainer_id: z.string().min(1),
  amount_minor: SAFE_INTEGER_SCHEMA.positive(),
});

export const PayoutBatchApprovalDecisionSchema = z.enum([
  "approved",
  "adjusted",
  "denied",
]);

export const PayoutBatchApprovalRecordSchema = z.object({
  approval_event_id: z.string().min(1),
  period: PeriodSchema,
  payout_batch_hash: PayoutBatchHashSchema,
  decision: PayoutBatchApprovalDecisionSchema,
  reviewer_id: z.string().min(1),
  reason: z.string().min(1),
  adjustments: z.array(PayoutBatchAdjustmentSchema),
  reviewed_at: z.string().datetime(),
});

export const RecordPayoutBatchApprovalInputSchema = z
  .object({
    period: PeriodSchema,
    payout_batch_hash: PayoutBatchHashSchema,
    decision: PayoutBatchApprovalDecisionSchema,
    reviewer_id: z.string().min(1),
    reason: z.string().min(1),
    adjustments: z.array(PayoutBatchAdjustmentSchema).default([]),
  })
  .superRefine((value, context) => {
    if (value.decision === "adjusted" && value.adjustments.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjustments"],
        message: "adjusted decision requires at least one payout adjustment",
      });
    }
    if (value.decision !== "adjusted" && value.adjustments.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjustments"],
        message: "adjustments are only allowed for adjusted decisions",
      });
    }
  });

export const RecordPayoutBatchApprovalOutputSchema = z.object({
  status: z.literal("recorded"),
  approval_event_id: z.string().min(1),
  period: PeriodSchema,
  payout_batch_hash: PayoutBatchHashSchema,
  decision: PayoutBatchApprovalDecisionSchema,
  reviewed_at: z.string().datetime(),
});

export type PayoutBatchAdjustment = z.infer<typeof PayoutBatchAdjustmentSchema>;
export type PayoutBatchApprovalDecision = z.infer<
  typeof PayoutBatchApprovalDecisionSchema
>;
export type PayoutBatchApprovalRecord = z.infer<
  typeof PayoutBatchApprovalRecordSchema
>;
export type RecordPayoutBatchApprovalInput = z.infer<
  typeof RecordPayoutBatchApprovalInputSchema
>;
export type RecordPayoutBatchApprovalOutput = z.infer<
  typeof RecordPayoutBatchApprovalOutputSchema
>;

type HashablePayoutBatch = {
  period: string;
  currency: string;
  payouts: Array<z.infer<typeof PayoutBatchEntrySchema>>;
  flagged: Array<z.infer<typeof PayoutBatchFlagSchema>>;
  totals: {
    total_amount_minor: number;
    eligible_amount_minor: number;
    flagged_amount_minor: number;
  };
};

const HashablePayoutBatchSchema = z.object({
  period: PeriodSchema,
  currency: CurrencyCodeSchema,
  payouts: z.array(PayoutBatchEntrySchema),
  flagged: z.array(PayoutBatchFlagSchema),
  totals: z.object({
    total_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
    eligible_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
    flagged_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
  }),
});

export type PayoutBatchApprovalStore = {
  readByPeriodAndHash:
    (period: string, payoutBatchHash: string) =>
      | Promise<PayoutBatchApprovalRecord | null>
      | PayoutBatchApprovalRecord
      | null;
  upsertRecord: (record: PayoutBatchApprovalRecord) => Promise<void> | void;
  readAllRecords?: () => Promise<PayoutBatchApprovalRecord[]> | PayoutBatchApprovalRecord[];
  clear?: () => Promise<void> | void;
};

type RecordPayoutBatchApprovalOptions = {
  store?: PayoutBatchApprovalStore;
  now?: () => number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
  eventIdGenerator?: (
    period: string,
    payoutBatchHash: string,
    nowMs: number
  ) => string;
};

const inMemoryApprovalsByKey = new Map<string, PayoutBatchApprovalRecord>();

function toStoreKey(period: string, payoutBatchHash: string): string {
  return `${period}:${payoutBatchHash}`;
}

function cloneApprovalRecord(
  record: PayoutBatchApprovalRecord
): PayoutBatchApprovalRecord {
  return {
    ...record,
    adjustments: record.adjustments.map((adjustment) => ({ ...adjustment })),
  };
}

const inMemoryPayoutBatchApprovalStore: PayoutBatchApprovalStore = {
  readByPeriodAndHash(
    period: string,
    payoutBatchHash: string
  ): PayoutBatchApprovalRecord | null {
    const record = inMemoryApprovalsByKey.get(toStoreKey(period, payoutBatchHash));
    return record ? cloneApprovalRecord(record) : null;
  },

  upsertRecord(record: PayoutBatchApprovalRecord): void {
    inMemoryApprovalsByKey.set(
      toStoreKey(record.period, record.payout_batch_hash),
      cloneApprovalRecord(record)
    );
  },

  readAllRecords(): PayoutBatchApprovalRecord[] {
    return [...inMemoryApprovalsByKey.values()]
      .map((record) => cloneApprovalRecord(record))
      .sort((left, right) => {
        if (left.period !== right.period) {
          return left.period.localeCompare(right.period);
        }
        return left.payout_batch_hash.localeCompare(right.payout_batch_hash);
      });
  },

  clear(): void {
    inMemoryApprovalsByKey.clear();
  },
};

function defaultEventIdGenerator(
  period: string,
  payoutBatchHash: string,
  nowMs: number
): string {
  const digest = createHash("sha256")
    .update("payout-approval:")
    .update(period)
    .update(":")
    .update(payoutBatchHash)
    .update(":")
    .update(String(nowMs))
    .update(":")
    .update(randomUUID())
    .digest("hex");
  return `apr_${digest.slice(0, 24)}`;
}

function normalizeHashablePayoutBatch(
  batch: HashablePayoutBatch
): HashablePayoutBatch {
  const payouts = batch.payouts
    .map((payout) => ({
      maintainer_id: payout.maintainer_id,
      amount_minor: payout.amount_minor,
      currency: payout.currency,
      payout_account: {
        provider: payout.payout_account.provider,
        account_id: payout.payout_account.account_id,
      },
      allocation_count: payout.allocation_count,
    }))
    .sort((left, right) => left.maintainer_id.localeCompare(right.maintainer_id));

  const flagged = batch.flagged
    .map((entry) => ({
      maintainer_id: entry.maintainer_id,
      amount_minor: entry.amount_minor,
      allocation_count: entry.allocation_count,
      reason: entry.reason,
      ...(entry.verification_status === undefined
        ? {}
        : { verification_status: entry.verification_status }),
    }))
    .sort((left, right) => left.maintainer_id.localeCompare(right.maintainer_id));

  return {
    period: batch.period,
    currency: batch.currency,
    payouts,
    flagged,
    totals: {
      total_amount_minor: batch.totals.total_amount_minor,
      eligible_amount_minor: batch.totals.eligible_amount_minor,
      flagged_amount_minor: batch.totals.flagged_amount_minor,
    },
  };
}

export function computePayoutBatchHash(batch: unknown): string {
  const parsedBatch = HashablePayoutBatchSchema.parse(batch);
  const normalized = normalizeHashablePayoutBatch(parsedBatch);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function clearInMemoryPayoutBatchApprovals(): void {
  inMemoryApprovalsByKey.clear();
}

export function getInMemoryPayoutBatchApproval(
  period: string,
  payoutBatchHash: string
): PayoutBatchApprovalRecord | null {
  const record = inMemoryApprovalsByKey.get(toStoreKey(period, payoutBatchHash));
  return record ? cloneApprovalRecord(record) : null;
}

export function getInMemoryPayoutBatchApprovals(): PayoutBatchApprovalRecord[] {
  return [...inMemoryApprovalsByKey.values()]
    .map((record) => cloneApprovalRecord(record))
    .sort((left, right) => {
      if (left.period !== right.period) {
        return left.period.localeCompare(right.period);
      }
      return left.payout_batch_hash.localeCompare(right.payout_batch_hash);
    });
}

export async function recordPayoutBatchApproval(
  input: unknown,
  options: RecordPayoutBatchApprovalOptions = {}
): Promise<RecordPayoutBatchApprovalOutput> {
  const principal = assertToolAuthorized({
    toolName: "record_payout_batch_approval",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "record_payout_batch_approval",
    maxAllowedRisk: options.maxAllowedRisk ?? "high",
  });
  assertToolInputVetting("record_payout_batch_approval", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = RecordPayoutBatchApprovalInputSchema.parse(input);
  const nowMs = options.now?.() ?? Date.now();
  const reviewedAt = new Date(nowMs).toISOString();
  const eventIdGenerator = options.eventIdGenerator ?? defaultEventIdGenerator;
  const store = options.store ?? inMemoryPayoutBatchApprovalStore;

  const existing = await store.readByPeriodAndHash(
    parsedInput.period,
    parsedInput.payout_batch_hash
  );
  if (existing) {
    throw new Error(
      `approval record already exists for period ${parsedInput.period} ` +
      `and batch hash ${parsedInput.payout_batch_hash}; approvals are immutable`
    );
  }

  const effectiveReviewerId =
    principal.principal_id !== "test-auth-bypass" &&
    principal.principal_id !== "anonymous"
      ? principal.principal_id
      : parsedInput.reviewer_id;

  const record: PayoutBatchApprovalRecord = {
    approval_event_id: eventIdGenerator(
      parsedInput.period,
      parsedInput.payout_batch_hash,
      nowMs
    ),
    period: parsedInput.period,
    payout_batch_hash: parsedInput.payout_batch_hash,
    decision: parsedInput.decision,
    reviewer_id: effectiveReviewerId,
    reason: parsedInput.reason,
    adjustments: parsedInput.adjustments,
    reviewed_at: reviewedAt,
  };
  await store.upsertRecord(record);

  const output: RecordPayoutBatchApprovalOutput = {
    status: "recorded",
    approval_event_id: record.approval_event_id,
    period: record.period,
    payout_batch_hash: record.payout_batch_hash,
    decision: record.decision,
    reviewed_at: record.reviewed_at,
  };
  assertToolOutputSanity("record_payout_batch_approval", output);
  return output;
}

export function computePayoutBatchHashFromOutput(
  payoutBatch: Pick<
    CreatePayoutBatchOutput,
    "period" | "currency" | "payouts" | "flagged" | "totals"
  >
): string {
  return computePayoutBatchHash(payoutBatch);
}
