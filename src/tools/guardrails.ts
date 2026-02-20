import { z } from "zod";

export const ToolRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type ToolRiskLevel = z.infer<typeof ToolRiskLevelSchema>;

export const GuardrailedToolNameSchema = z.enum([
  "log_library_usage",
  "aggregate_usage_for_period",
  "validate_allocation_constraints",
  "compute_allocations",
  "persist_allocations",
  "create_payout_batch",
  "append_royalty_cycle_audit",
  "record_royalty_observability",
  "get_royalty_observability_dashboard",
  "record_payout_batch_approval",
  "execute_payouts",
]);
export type GuardrailedToolName = z.infer<typeof GuardrailedToolNameSchema>;

export const DEFAULT_MAX_GUARDRAIL_INPUT_BYTES = 512 * 1024;
export const DEFAULT_MAX_AGGREGATION_PERIOD_DAYS = 31;
export const MAX_GUARDRAIL_AGGREGATE_OUTPUT_ROWS = 200_000;

const TOOL_RISK_BY_NAME: Record<GuardrailedToolName, ToolRiskLevel> = {
  log_library_usage: "low",
  aggregate_usage_for_period: "medium",
  validate_allocation_constraints: "medium",
  compute_allocations: "medium",
  persist_allocations: "medium",
  create_payout_batch: "high",
  append_royalty_cycle_audit: "medium",
  record_royalty_observability: "medium",
  get_royalty_observability_dashboard: "medium",
  record_payout_batch_approval: "high",
  execute_payouts: "high",
};

const RISK_ORDER: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const AggregateUsageForPeriodInputVettingSchema = z
  .object({
    period_start: z.string().datetime(),
    period_end: z.string().datetime(),
  })
  .refine((value) => Date.parse(value.period_end) > Date.parse(value.period_start), {
    message: "period_end must be greater than period_start",
    path: ["period_end"],
  });

const LogLibraryUsageOutputSanitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    recorded_count: z.number().int().positive(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.string().min(1),
    recorded_count: z.number().int().nonnegative().optional(),
  }),
]);

const AggregateUsageForPeriodOutputSanitySchema = z.object({
  aggregates: z.array(
    z.object({
      library_id: z.string().min(1),
      total_calls: z.number().int().nonnegative(),
      unique_sessions: z.number().int().nonnegative(),
    })
  ),
  next_cursor: z.string().min(1).optional(),
});

const ValidateAllocationConstraintsOutputSanitySchema = z.object({
  status: z.enum(["valid", "invalid"]),
  total_allocated_minor: z.number().int().nonnegative(),
  expected_pool_minor: z.number().int().positive(),
  violations: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
  ),
});

const PersistAllocationsOutputSanitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    record_id: z.string().min(1),
    persisted_at: z.string().datetime(),
    saved_count: z.number().int().positive(),
    audit_event_id: z.string().min(1),
  }),
  z.object({
    status: z.literal("already_exists"),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    record_id: z.string().min(1),
    persisted_at: z.string().datetime(),
    saved_count: z.literal(0),
    duplicate_conflict: z.boolean(),
    audit_event_id: z.string().min(1),
  }),
]);

const CreatePayoutBatchOutputSanitySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  payouts: z.array(
    z.object({
      maintainer_id: z.string().min(1),
      amount_minor: z.number().int().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      payout_account: z.object({
        provider: z.enum(["stripe", "adyen", "other"]),
        account_id: z.string().min(1),
      }),
      allocation_count: z.number().int().positive(),
    })
  ),
  flagged: z.array(
    z.object({
      maintainer_id: z.string().min(1),
      amount_minor: z.number().int().positive(),
      allocation_count: z.number().int().positive(),
      reason: z.enum([
        "maintainer_not_found",
        "maintainer_not_verified",
        "payout_account_missing",
      ]),
      verification_status: z
        .enum(["unverified", "pending", "verified", "rejected"])
        .optional(),
    })
  ),
  totals: z.object({
    total_amount_minor: z.number().int().nonnegative(),
    eligible_amount_minor: z.number().int().nonnegative(),
    flagged_amount_minor: z.number().int().nonnegative(),
  }),
  notes: z.string().min(1),
});

const RecordPayoutBatchApprovalOutputSanitySchema = z.object({
  status: z.literal("recorded"),
  approval_event_id: z.string().min(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  payout_batch_hash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["approved", "adjusted", "denied"]),
  reviewed_at: z.string().datetime(),
});

const AppendRoyaltyCycleAuditOutputSanitySchema = z.object({
  status: z.literal("recorded"),
  event_id: z.string().min(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  run_id: z.string().min(1),
  event_hash: z.string().regex(/^[a-f0-9]{64}$/),
  previous_event_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  observed_at: z.string().datetime(),
});

const RecordRoyaltyObservabilityOutputSanitySchema = z.object({
  status: z.literal("recorded"),
  sample_id: z.string().min(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  run_id: z.string().min(1),
  recorded_at: z.string().datetime(),
});

function estimatePayloadBytes(payload: unknown): number {
  const serialized = JSON.stringify(payload);
  return Buffer.byteLength(serialized, "utf8");
}

export function getToolRiskLevel(toolName: GuardrailedToolName): ToolRiskLevel {
  return TOOL_RISK_BY_NAME[toolName];
}

export function assertToolRiskAllowed(options: {
  toolName: GuardrailedToolName;
  maxAllowedRisk?: ToolRiskLevel;
}): void {
  const maxAllowedRisk = options.maxAllowedRisk ?? "medium";
  const toolRisk = getToolRiskLevel(options.toolName);
  if (RISK_ORDER[toolRisk] > RISK_ORDER[maxAllowedRisk]) {
    throw new Error(
      `tool ${options.toolName} requires ${toolRisk} risk allowance, but max allowed is ${maxAllowedRisk}`
    );
  }
}

export function assertToolInputVetting(
  toolName: GuardrailedToolName,
  input: unknown,
  options: {
    maxBytes?: number;
    maxAggregationPeriodDays?: number;
  } = {}
): void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES;
  const payloadBytes = estimatePayloadBytes(input);
  if (payloadBytes > maxBytes) {
    throw new Error(
      `tool ${toolName} input payload ${payloadBytes} bytes exceeds max ${maxBytes} bytes`
    );
  }

  if (toolName !== "aggregate_usage_for_period") {
    return;
  }

  const parsedWindow = AggregateUsageForPeriodInputVettingSchema.safeParse(input);
  if (!parsedWindow.success) {
    return;
  }

  const maxAggregationPeriodDays =
    options.maxAggregationPeriodDays ?? DEFAULT_MAX_AGGREGATION_PERIOD_DAYS;
  const maxPeriodMs = maxAggregationPeriodDays * 24 * 60 * 60 * 1000;
  const periodMs =
    Date.parse(parsedWindow.data.period_end) - Date.parse(parsedWindow.data.period_start);
  if (periodMs > maxPeriodMs) {
    throw new Error(`aggregation period exceeds ${maxAggregationPeriodDays} days`);
  }
}

export function assertToolOutputSanity(
  toolName: GuardrailedToolName,
  output: unknown
): void {
  if (toolName === "log_library_usage") {
    LogLibraryUsageOutputSanitySchema.parse(output);
    return;
  }

  if (toolName === "aggregate_usage_for_period") {
    const parsedOutput = AggregateUsageForPeriodOutputSanitySchema.parse(output);
    if (parsedOutput.aggregates.length > MAX_GUARDRAIL_AGGREGATE_OUTPUT_ROWS) {
      throw new Error("aggregate output row count exceeds sanity limit");
    }

    const libraryIds = new Set<string>();
    for (const aggregate of parsedOutput.aggregates) {
      if (libraryIds.has(aggregate.library_id)) {
        throw new Error(`duplicate library_id found in aggregate output: ${aggregate.library_id}`);
      }
      libraryIds.add(aggregate.library_id);
    }
    return;
  }

  if (toolName === "validate_allocation_constraints") {
    const parsedOutput = ValidateAllocationConstraintsOutputSanitySchema.parse(output);
    if (parsedOutput.status === "valid" && parsedOutput.violations.length > 0) {
      throw new Error("valid allocation constraint output cannot include violations");
    }
    if (parsedOutput.status === "invalid" && parsedOutput.violations.length === 0) {
      throw new Error("invalid allocation constraint output must include at least one violation");
    }
    return;
  }

  if (toolName === "persist_allocations") {
    PersistAllocationsOutputSanitySchema.parse(output);
    return;
  }

  if (toolName === "create_payout_batch") {
    const parsedOutput = CreatePayoutBatchOutputSanitySchema.parse(output);
    if (
      parsedOutput.totals.eligible_amount_minor +
        parsedOutput.totals.flagged_amount_minor !==
      parsedOutput.totals.total_amount_minor
    ) {
      throw new Error("create_payout_batch totals are inconsistent");
    }
    return;
  }

  if (toolName === "record_payout_batch_approval") {
    RecordPayoutBatchApprovalOutputSanitySchema.parse(output);
    return;
  }

  if (toolName === "append_royalty_cycle_audit") {
    AppendRoyaltyCycleAuditOutputSanitySchema.parse(output);
    return;
  }

  if (toolName === "record_royalty_observability") {
    RecordRoyaltyObservabilityOutputSanitySchema.parse(output);
  }
}
