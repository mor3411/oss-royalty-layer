import { createHash } from "node:crypto";
import { z } from "zod";
import { PeriodSchema } from "../domain/index.js";
import { CurrencyCodeSchema } from "../shared/currency.js";
import {
  aggregateUsageForPeriod,
  type AggregatedLibraryUsage,
  type AggregateUsageForPeriodOutput,
} from "../tools/aggregate-usage-for-period.js";
import {
  computeAllocations,
  type ComputeAllocationsOutput,
  ComputeAllocationsPolicySchema,
  type ComputeAllocationsPolicy,
} from "../tools/compute-allocations.js";
import {
  createPayoutBatch,
  type CreatePayoutBatchOutput,
  type MaintainerPayoutProfile,
  PayoutBatchEntrySchema,
  type PayoutBatchEntry,
} from "../tools/create-payout-batch.js";
import {
  detectPayoutAnomalies,
  type DetectPayoutAnomaliesResult,
} from "../tools/payout-anomaly-detector.js";
import {
  appendRoyaltyCycleAuditEvent,
  getInMemoryRoyaltyCycleAuditsByPeriod,
  type RoyaltyCycleAuditStore,
} from "../tools/royalty-cycle-audit.js";
import {
  computePayoutBatchHashFromOutput,
  getInMemoryPayoutBatchApproval,
  type PayoutBatchAdjustment,
  type PayoutBatchApprovalRecord,
} from "../tools/payout-batch-approval.js";
import {
  persistAllocations,
  type AllocationPersistenceStore,
  type PersistAllocationsOutput,
} from "../tools/persist-allocations.js";
import {
  getInMemoryLibraryUsageIngestionEvents,
  type LibraryUsageIngestionMetrics,
  type LibraryUsageEventStore,
} from "../tools/library-usage-ingestion.js";
import {
  recordRoyaltyObservabilitySample,
  type RoyaltyObservabilityStore,
} from "../tools/royalty-observability.js";
import { type LibraryIdResolver } from "../tools/library-registry.js";
import {
  assertToolAuthorized,
  type AuthorizationRuntimeEnvironment,
} from "../tools/authz.js";
import { assertToolRiskAllowed, type ToolRiskLevel } from "../tools/guardrails.js";

const RunRoyaltyCycleInputSchema = z
  .object({
    period: PeriodSchema,
    period_start: z.string().datetime(),
    period_end: z.string().datetime(),
    pool_amount_minor: z.number().int().positive(),
    policy_config: z
      .object({
        max_share_per_library: z.number().min(0).max(1).optional(),
        min_floor_amount_minor: z.number().int().nonnegative().optional(),
        long_tail_weight: z.number().positive().optional(),
      })
      .optional(),
    currency: CurrencyCodeSchema.default("USD"),
    page_size: z.number().int().positive().max(1000).default(100),
  })
  .refine((value) => Date.parse(value.period_end) > Date.parse(value.period_start), {
    message: "period_end must be greater than period_start",
    path: ["period_end"],
  });

export type RunRoyaltyCycleInput = z.infer<typeof RunRoyaltyCycleInputSchema>;

type PayoutAnomalyResult = {
  has_anomaly: boolean;
  reason?: string;
  codes?: string[];
};

type PayoutApprovalDecision = {
  approved: boolean;
  reason?: string;
  adjusted_payouts?: PayoutBatchEntry[];
};

export type ExecutePayoutsInput = {
  period: string;
  currency: string;
  payouts: PayoutBatchEntry[];
  idempotency_key: string;
};

export type ExecutePayoutsResult = {
  executed_count?: number;
  results?: unknown;
};

export type PayoutExecutionClaimStatus = "acquired" | "already_executed" | "in_progress";

export type PayoutExecutionClaimStore = {
  tryClaim:
    (idempotencyKey: string) =>
      | Promise<PayoutExecutionClaimStatus>
      | PayoutExecutionClaimStatus;
  markExecuted: (idempotencyKey: string) => Promise<void> | void;
  releaseClaim: (idempotencyKey: string) => Promise<void> | void;
};

export type RunRoyaltyCycleOptions = {
  eventStore?: LibraryUsageEventStore;
  allocationStore?: AllocationPersistenceStore;
  auditStore?: RoyaltyCycleAuditStore;
  observabilityStore?: RoyaltyObservabilityStore;
  resolveLibraryId?: LibraryIdResolver;
  resolveMaintainerId?: (libraryId: string) => Promise<string> | string;
  resolveMaintainer?:
    (maintainerId: string) =>
      | Promise<MaintainerPayoutProfile | null>
      | MaintainerPayoutProfile
      | null;
  detectPayoutAnomalies?: (context: {
    payoutBatch: CreatePayoutBatchOutput;
    allocation: ComputeAllocationsOutput;
  }) => Promise<PayoutAnomalyResult> | PayoutAnomalyResult;
  approvePayoutBatch?: (context: {
    payoutBatch: CreatePayoutBatchOutput;
    allocation: ComputeAllocationsOutput;
    persistence: PersistAllocationsOutput;
  }) => Promise<PayoutApprovalDecision> | PayoutApprovalDecision;
  resolvePayoutBatchApproval?: (context: {
    period: string;
    payoutBatchHash: string;
    payoutBatch: CreatePayoutBatchOutput;
    allocation: ComputeAllocationsOutput;
    persistence: PersistAllocationsOutput;
  }) => Promise<PayoutBatchApprovalRecord | null> | PayoutBatchApprovalRecord | null;
  executePayouts?: (input: ExecutePayoutsInput) => Promise<ExecutePayoutsResult> | ExecutePayoutsResult;
  getTelemetryIngestionMetrics?:
    () =>
      | Promise<LibraryUsageIngestionMetrics>
      | LibraryUsageIngestionMetrics;
  now?: () => number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  payoutMaxAllowedRisk?: ToolRiskLevel;
  maxAggregationPeriodDays?: number;
  executionClaimStore?: PayoutExecutionClaimStore;
};

export type RunRoyaltyCycleOutput =
  | {
      status: "no_usage";
      period: string;
      pool_amount_minor: number;
      aggregation: {
        pages_fetched: number;
        library_count: 0;
        usage_stats: [];
      };
      notes: string[];
    }
  | {
      status: "completed";
      period: string;
      pool_amount_minor: number;
      aggregation: {
        pages_fetched: number;
        library_count: number;
        usage_stats: AggregatedLibraryUsage[];
      };
      allocation: ComputeAllocationsOutput;
      persistence: PersistAllocationsOutput;
      payout_batch: CreatePayoutBatchOutput;
      execution:
        | {
            status: "skipped";
            reason: string;
            executed_count: 0;
          }
        | {
            status: "executed";
            executed_count: number;
            results: unknown;
          };
      notes: string[];
    };

const defaultEventStore: LibraryUsageEventStore = {
  append: () => {
    throw new Error("runRoyaltyCycle does not support eventStore.append");
  },
  readAll: () => getInMemoryLibraryUsageIngestionEvents(),
};

type InMemoryPayoutExecutionClaimState = "in_progress" | "executed";

const inMemoryPayoutExecutionClaimStates = new Map<
  string,
  InMemoryPayoutExecutionClaimState
>();

/**
 * Clears in-memory execution claims used by the orchestrator's default
 * idempotency guard.
 */
export function clearInMemoryRunRoyaltyCycleExecutionClaims(): void {
  inMemoryPayoutExecutionClaimStates.clear();
}

/**
 * Default single-process claim store.
 * For multi-instance deployments, inject a distributed implementation through
 * `RunRoyaltyCycleOptions.executionClaimStore`.
 */
const inMemoryPayoutExecutionClaimStore: PayoutExecutionClaimStore = {
  tryClaim(idempotencyKey: string): PayoutExecutionClaimStatus {
    const state = inMemoryPayoutExecutionClaimStates.get(idempotencyKey);
    if (state === "executed") {
      return "already_executed";
    }
    if (state === "in_progress") {
      return "in_progress";
    }
    inMemoryPayoutExecutionClaimStates.set(idempotencyKey, "in_progress");
    return "acquired";
  },
  markExecuted(idempotencyKey: string): void {
    inMemoryPayoutExecutionClaimStates.set(idempotencyKey, "executed");
  },
  releaseClaim(idempotencyKey: string): void {
    if (inMemoryPayoutExecutionClaimStates.get(idempotencyKey) === "in_progress") {
      inMemoryPayoutExecutionClaimStates.delete(idempotencyKey);
    }
  },
};

/** Parses and validates policy overrides with sensible defaults. */
function buildComputePolicy(
  policy: RunRoyaltyCycleInput["policy_config"]
): ComputeAllocationsPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  return ComputeAllocationsPolicySchema.parse(policy);
}

function applyApprovalAdjustments(
  payouts: PayoutBatchEntry[],
  adjustments: PayoutBatchAdjustment[]
): { status: "ok"; payouts: PayoutBatchEntry[] } | { status: "invalid"; reason: string } {
  if (adjustments.length === 0) {
    return {
      status: "invalid",
      reason: "approval adjusted decision requires non-empty adjustments",
    };
  }

  const payoutsByMaintainer = new Map<string, PayoutBatchEntry>();
  let originalTotal = 0;
  for (const payout of payouts) {
    payoutsByMaintainer.set(payout.maintainer_id, payout);
    originalTotal += payout.amount_minor;
  }

  const seenMaintainers = new Set<string>();
  const adjustmentAmountsByMaintainer = new Map<string, number>();

  for (const adjustment of adjustments) {
    if (seenMaintainers.has(adjustment.maintainer_id)) {
      return {
        status: "invalid",
        reason: `duplicate payout adjustment for maintainer ${adjustment.maintainer_id}`,
      };
    }
    seenMaintainers.add(adjustment.maintainer_id);

    const basePayout = payoutsByMaintainer.get(adjustment.maintainer_id);
    if (!basePayout) {
      return {
        status: "invalid",
        reason: `adjusted payout includes unknown maintainer ${adjustment.maintainer_id}`,
      };
    }

    adjustmentAmountsByMaintainer.set(adjustment.maintainer_id, adjustment.amount_minor);
  }

  const adjustedPayouts = payouts.map((payout) => ({
    ...payout,
    amount_minor:
      adjustmentAmountsByMaintainer.get(payout.maintainer_id) ?? payout.amount_minor,
  }));
  const adjustedTotal = adjustedPayouts.reduce(
    (sum, payout) => sum + payout.amount_minor,
    0
  );

  if (adjustedTotal <= 0) {
    return {
      status: "invalid",
      reason: "adjusted payouts must include at least one positive transfer",
    };
  }

  if (adjustedTotal > originalTotal) {
    return {
      status: "invalid",
      reason: "adjusted payouts exceed original eligible payout total",
    };
  }

  return {
    status: "ok",
    payouts: adjustedPayouts,
  };
}

const CallbackAdjustedPayoutsSchema = z.array(PayoutBatchEntrySchema).min(1);

/**
 * Normalizes callback-provided payout entries into safe amount-only
 * adjustments, refusing any destination/account changes.
 */
function applyCallbackAdjustedPayouts(
  payouts: PayoutBatchEntry[],
  adjustedPayouts: unknown
): { status: "ok"; payouts: PayoutBatchEntry[] } | { status: "invalid"; reason: string } {
  const parsedAdjustedPayouts = CallbackAdjustedPayoutsSchema.safeParse(adjustedPayouts);
  if (!parsedAdjustedPayouts.success) {
    return {
      status: "invalid",
      reason: "approval callback returned invalid adjusted payouts",
    };
  }

  const payoutsByMaintainer = new Map<string, PayoutBatchEntry>();
  for (const payout of payouts) {
    payoutsByMaintainer.set(payout.maintainer_id, payout);
  }

  const adjustments: PayoutBatchAdjustment[] = [];
  for (const adjusted of parsedAdjustedPayouts.data) {
    const basePayout = payoutsByMaintainer.get(adjusted.maintainer_id);
    if (!basePayout) {
      return {
        status: "invalid",
        reason: `approval callback included unknown maintainer ${adjusted.maintainer_id}`,
      };
    }
    if (adjusted.currency !== basePayout.currency) {
      return {
        status: "invalid",
        reason: `approval callback adjusted payout for maintainer ${adjusted.maintainer_id} cannot override currency`,
      };
    }
    if (adjusted.allocation_count !== basePayout.allocation_count) {
      return {
        status: "invalid",
        reason: `approval callback adjusted payout for maintainer ${adjusted.maintainer_id} cannot override allocation_count`,
      };
    }
    if (
      adjusted.payout_account.provider !== basePayout.payout_account.provider ||
      adjusted.payout_account.account_id !== basePayout.payout_account.account_id
    ) {
      return {
        status: "invalid",
        reason: `approval callback adjusted payout for maintainer ${adjusted.maintainer_id} cannot override payout account`,
      };
    }

    adjustments.push({
      maintainer_id: adjusted.maintainer_id,
      amount_minor: adjusted.amount_minor,
    });
  }

  return applyApprovalAdjustments(payouts, adjustments);
}

export async function runRoyaltyCycle(
  input: unknown,
  options: RunRoyaltyCycleOptions = {}
): Promise<RunRoyaltyCycleOutput> {
  const parsedInput = RunRoyaltyCycleInputSchema.parse(input);
  const notes: string[] = [];
  const mediumRisk = options.maxAllowedRisk ?? "medium";
  const payoutRisk = options.payoutMaxAllowedRisk ?? "high";
  const eventStore = options.eventStore ?? defaultEventStore;
  const runEpochMs = options.now?.() ?? Date.now();
  const runId = `rrn_${createHash("sha256")
    .update(parsedInput.period)
    .update(":")
    .update(parsedInput.period_start)
    .update(":")
    .update(parsedInput.period_end)
    .update(":")
    .update(String(parsedInput.pool_amount_minor))
    .update(":")
    .update(String(runEpochMs))
    .digest("hex")
    .slice(0, 24)}`;
  notes.push(`run_id=${runId}`);
  let telemetryIngestionMetrics: LibraryUsageIngestionMetrics | undefined;
  if (options.getTelemetryIngestionMetrics) {
    try {
      telemetryIngestionMetrics = await options.getTelemetryIngestionMetrics();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`telemetry_metrics_error=${message}`);
    }
  }
  const periodEndMs = Date.parse(parsedInput.period_end);
  const aggregationLagMs = Number.isFinite(periodEndMs)
    ? Math.max(0, runEpochMs - periodEndMs)
    : 0;
  const telemetryIngestionLagMs = (() => {
    if (!telemetryIngestionMetrics?.last_ingested_at) {
      return null;
    }
    const lastIngestedAtMs = Date.parse(telemetryIngestionMetrics.last_ingested_at);
    if (!Number.isFinite(lastIngestedAtMs)) {
      return null;
    }
    return Math.max(0, runEpochMs - lastIngestedAtMs);
  })();

  const appendAuditEvent = async (
    eventType:
      | "cycle_no_usage"
      | "allocation_proposal_persisted"
      | "payout_approval_required"
      | "payout_approval_resolved"
      | "payout_anomaly_detected"
      | "payout_execution_skipped"
      | "payout_execution_executed",
    payload: Record<string, unknown> = {}
  ) => {
    await appendRoyaltyCycleAuditEvent(
      {
        period: parsedInput.period,
        run_id: runId,
        event_type: eventType,
        payload,
      },
      {
        ...(options.auditStore === undefined ? {} : { store: options.auditStore }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.principal === undefined ? {} : { principal: options.principal }),
        ...(options.runtimeEnvironment === undefined
          ? {}
          : { runtimeEnvironment: options.runtimeEnvironment }),
        ...(options.allowTestAuthBypass === undefined
          ? {}
          : { allowTestAuthBypass: options.allowTestAuthBypass }),
        maxAllowedRisk: mediumRisk,
      }
    );
  };

  const appendObservability = async (input: {
    pagesFetched: number;
    libraryCount: number;
    anomalyDetected: boolean;
    anomalyCodes: string[];
    payoutOutcome: "executed" | "skipped";
    candidatePayoutCount: number;
    executedCount: number;
    skipReason?: string;
  }) => {
    try {
      await recordRoyaltyObservabilitySample(
        {
          period: parsedInput.period,
          run_id: runId,
          ...(telemetryIngestionMetrics === undefined
            ? {}
            : {
                telemetry: {
                  events_received: telemetryIngestionMetrics.events_received,
                  events_persisted: telemetryIngestionMetrics.events_persisted,
                  events_failed: telemetryIngestionMetrics.events_failed,
                  ...(telemetryIngestionMetrics.last_ingested_at === undefined
                    ? {}
                    : {
                        last_ingested_at:
                          telemetryIngestionMetrics.last_ingested_at,
                      }),
                  ...(telemetryIngestionLagMs === null
                    ? {}
                    : { ingestion_lag_ms: telemetryIngestionLagMs }),
                },
              }),
          aggregation: {
            pages_fetched: input.pagesFetched,
            library_count: input.libraryCount,
            aggregation_lag_ms: aggregationLagMs,
          },
          anomaly: {
            detected: input.anomalyDetected,
            codes: input.anomalyCodes,
          },
          payout: {
            outcome: input.payoutOutcome,
            candidate_payout_count: input.candidatePayoutCount,
            executed_count: input.executedCount,
            ...(input.skipReason === undefined
              ? {}
              : { skip_reason: input.skipReason }),
          },
        },
        {
          ...(options.observabilityStore === undefined
            ? {}
            : { store: options.observabilityStore }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.principal === undefined ? {} : { principal: options.principal }),
          ...(options.runtimeEnvironment === undefined
            ? {}
            : { runtimeEnvironment: options.runtimeEnvironment }),
          ...(options.allowTestAuthBypass === undefined
            ? {}
            : { allowTestAuthBypass: options.allowTestAuthBypass }),
          maxAllowedRisk: mediumRisk,
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`observability_record_error=${message}`);
    }
  };

  const usageStats: AggregatedLibraryUsage[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  do {
    const page: AggregateUsageForPeriodOutput = await aggregateUsageForPeriod(
      {
        period_start: parsedInput.period_start,
        period_end: parsedInput.period_end,
        ...(cursor === undefined ? {} : { cursor }),
        page_size: parsedInput.page_size,
      },
      {
        eventStore,
        ...(options.resolveLibraryId === undefined
          ? {}
          : { resolveLibraryId: options.resolveLibraryId }),
        ...(options.now === undefined ? {} : { now: options.now }),
        maxAllowedRisk: mediumRisk,
        ...(options.maxAggregationPeriodDays === undefined
          ? {}
          : { maxAggregationPeriodDays: options.maxAggregationPeriodDays }),
        ...(options.principal === undefined ? {} : { principal: options.principal }),
        ...(options.runtimeEnvironment === undefined
          ? {}
          : { runtimeEnvironment: options.runtimeEnvironment }),
        ...(options.allowTestAuthBypass === undefined
          ? {}
          : { allowTestAuthBypass: options.allowTestAuthBypass }),
      }
    );
    usageStats.push(...page.aggregates);
    cursor = page.next_cursor;
    pagesFetched += 1;
  } while (cursor);

  if (usageStats.length === 0) {
    notes.push("no usage aggregates found for requested period");
    await appendAuditEvent("cycle_no_usage", {
      pages_fetched: pagesFetched,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: 0,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: 0,
      executedCount: 0,
      skipReason: "no_usage",
    });
    return {
      status: "no_usage",
      period: parsedInput.period,
      pool_amount_minor: parsedInput.pool_amount_minor,
      aggregation: {
        pages_fetched: pagesFetched,
        library_count: 0,
        usage_stats: [],
      },
      notes,
    };
  }

  const allocation = await computeAllocations(
    {
      period: parsedInput.period,
      pool_amount_minor: parsedInput.pool_amount_minor,
      usage_stats: usageStats,
      ...(parsedInput.policy_config === undefined
        ? {}
        : { policy_config: buildComputePolicy(parsedInput.policy_config) }),
    },
    {
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestAuthBypass: options.allowTestAuthBypass }),
      maxAllowedRisk: mediumRisk,
      ...(options.resolveMaintainerId === undefined
        ? {}
        : { resolveMaintainerId: options.resolveMaintainerId }),
    }
  );

  const persistence = await persistAllocations(
    {
      period: parsedInput.period,
      pool_amount_minor: allocation.pool_amount_minor,
      policy_applied: allocation.policy_applied,
      allocations: allocation.allocations,
      notes: allocation.notes,
    },
    {
      ...(options.allocationStore === undefined ? {} : { store: options.allocationStore }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestAuthBypass: options.allowTestAuthBypass }),
      maxAllowedRisk: mediumRisk,
    }
  );
  await appendAuditEvent("allocation_proposal_persisted", {
    allocation_count: allocation.allocations.length,
    persistence_status: persistence.status,
    record_id: persistence.record_id,
    persistence_audit_event_id: persistence.audit_event_id,
    pool_amount_minor: allocation.pool_amount_minor,
    ...(persistence.status === "already_exists"
      ? { duplicate_conflict: persistence.duplicate_conflict }
      : {}),
  });
  if (persistence.status === "already_exists" && persistence.duplicate_conflict) {
    const conflictReason = "allocation_conflict_requires_review";
    notes.push(`persistence_conflict=${persistence.record_id}`);
    await appendAuditEvent("payout_execution_skipped", {
      reason: conflictReason,
      candidate_payout_count: 0,
      record_id: persistence.record_id,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: 0,
      executedCount: 0,
      skipReason: conflictReason,
    });
    throw new Error(
      `allocation persistence conflict detected for period ${parsedInput.period}; manual review required`
    );
  }

  const payoutBatch = await createPayoutBatch(
    {
      period: parsedInput.period,
      currency: parsedInput.currency,
    },
    {
      ...(options.allocationStore === undefined
        ? {}
        : { allocationStore: options.allocationStore }),
      ...(options.resolveMaintainer === undefined
        ? {}
        : { resolveMaintainer: options.resolveMaintainer }),
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestAuthBypass: options.allowTestAuthBypass }),
      maxAllowedRisk: payoutRisk,
    }
  );
  const payoutBatchHash = computePayoutBatchHashFromOutput({
    period: payoutBatch.period,
    currency: payoutBatch.currency,
    payouts: payoutBatch.payouts,
    flagged: payoutBatch.flagged,
    totals: payoutBatch.totals,
  });
  notes.push(`approval_hash=${payoutBatchHash}`);
  const payoutExecutionIdempotencyKey = `execute_payouts:${parsedInput.period}:${payoutBatchHash}`;
  const executionClaimStore =
    options.executionClaimStore ?? inMemoryPayoutExecutionClaimStore;
  const buildCompletedOutput = (
    execution: Extract<RunRoyaltyCycleOutput, { status: "completed" }>["execution"]
  ): RunRoyaltyCycleOutput => ({
    status: "completed",
    period: parsedInput.period,
    pool_amount_minor: parsedInput.pool_amount_minor,
    aggregation: {
      pages_fetched: pagesFetched,
      library_count: usageStats.length,
      usage_stats: usageStats,
    },
    allocation,
    persistence,
    payout_batch: payoutBatch,
    execution,
    notes,
  });

  const anomalyResult = options.detectPayoutAnomalies
    ? await options.detectPayoutAnomalies({
        payoutBatch,
        allocation,
      })
    : detectPayoutAnomalies({
        payoutBatch,
        allocation,
      });
  const anomalyDetails = anomalyResult as DetectPayoutAnomaliesResult;
  if (anomalyResult.has_anomaly) {
    if (
      Array.isArray(anomalyDetails.codes) &&
      anomalyDetails.codes.length > 0
    ) {
      notes.push(`anomaly_codes=${anomalyDetails.codes.join(",")}`);
    }
    await appendAuditEvent("payout_anomaly_detected", {
      reason: anomalyResult.reason ?? "payout_anomaly_detected",
      codes:
        Array.isArray(anomalyDetails.codes) && anomalyDetails.codes.length > 0
          ? anomalyDetails.codes
          : [],
    });
    await appendAuditEvent("payout_execution_skipped", {
      reason: anomalyResult.reason ?? "payout_anomaly_detected",
      candidate_payout_count: payoutBatch.payouts.length,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: true,
      anomalyCodes:
        Array.isArray(anomalyDetails.codes) && anomalyDetails.codes.length > 0
          ? anomalyDetails.codes
          : [],
      payoutOutcome: "skipped",
      candidatePayoutCount: payoutBatch.payouts.length,
      executedCount: 0,
      skipReason: anomalyResult.reason ?? "payout_anomaly_detected",
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: anomalyResult.reason ?? "payout_anomaly_detected",
      executed_count: 0,
    });
  }

  let payoutExecutionCandidates = payoutBatch.payouts;
  const approval = options.approvePayoutBatch
    ? await options.approvePayoutBatch({
        payoutBatch,
        allocation,
        persistence,
      })
    : null;

  if (!approval) {
    const storedApproval = options.resolvePayoutBatchApproval
      ? await options.resolvePayoutBatchApproval({
          period: parsedInput.period,
          payoutBatchHash,
          payoutBatch,
          allocation,
          persistence,
        })
      : getInMemoryPayoutBatchApproval(parsedInput.period, payoutBatchHash);

    if (!storedApproval) {
      await appendAuditEvent("payout_approval_required", {
        payout_batch_hash: payoutBatchHash,
      });
      await appendAuditEvent("payout_execution_skipped", {
        reason: "approval_required",
        candidate_payout_count: payoutBatch.payouts.length,
      });
      await appendObservability({
        pagesFetched,
        libraryCount: usageStats.length,
        anomalyDetected: false,
        anomalyCodes: [],
        payoutOutcome: "skipped",
        candidatePayoutCount: payoutBatch.payouts.length,
        executedCount: 0,
        skipReason: "approval_required",
      });
      return buildCompletedOutput({
        status: "skipped",
        reason: "approval_required",
        executed_count: 0,
      });
    }

    notes.push(`approval_decision=${storedApproval.decision}`);
    notes.push(`approval_reviewer=${storedApproval.reviewer_id}`);
    await appendAuditEvent("payout_approval_resolved", {
      source: "stored",
      payout_batch_hash: payoutBatchHash,
      decision: storedApproval.decision,
      reviewer_id: storedApproval.reviewer_id,
      reason: storedApproval.reason,
      adjustments_count: storedApproval.adjustments.length,
    });

    if (storedApproval.decision === "denied") {
      await appendAuditEvent("payout_execution_skipped", {
        reason: storedApproval.reason || "payout_batch_denied",
        candidate_payout_count: payoutBatch.payouts.length,
      });
      await appendObservability({
        pagesFetched,
        libraryCount: usageStats.length,
        anomalyDetected: false,
        anomalyCodes: [],
        payoutOutcome: "skipped",
        candidatePayoutCount: payoutBatch.payouts.length,
        executedCount: 0,
        skipReason: storedApproval.reason || "payout_batch_denied",
      });
      return buildCompletedOutput({
        status: "skipped",
        reason: storedApproval.reason || "payout_batch_denied",
        executed_count: 0,
      });
    }

    if (storedApproval.decision === "adjusted") {
      const adjustmentResult = applyApprovalAdjustments(
        payoutBatch.payouts,
        storedApproval.adjustments
      );
      if (adjustmentResult.status !== "ok") {
        await appendAuditEvent("payout_execution_skipped", {
          reason: adjustmentResult.reason,
          candidate_payout_count: payoutBatch.payouts.length,
        });
        await appendObservability({
          pagesFetched,
          libraryCount: usageStats.length,
          anomalyDetected: false,
          anomalyCodes: [],
          payoutOutcome: "skipped",
          candidatePayoutCount: payoutBatch.payouts.length,
          executedCount: 0,
          skipReason: adjustmentResult.reason,
        });
        return buildCompletedOutput({
          status: "skipped",
          reason: adjustmentResult.reason,
          executed_count: 0,
        });
      }
      payoutExecutionCandidates = adjustmentResult.payouts;
      notes.push(`approval_adjusted_payouts=${payoutExecutionCandidates.length}`);
    }
  } else {
    await appendAuditEvent("payout_approval_resolved", {
      source: "callback",
      payout_batch_hash: payoutBatchHash,
      decision: approval.approved ? "approved" : "denied",
      reason: approval.reason,
      adjustments_count: approval.adjusted_payouts?.length ?? 0,
    });
    if (approval.adjusted_payouts && approval.adjusted_payouts.length > 0) {
      const callbackAdjustmentResult = applyCallbackAdjustedPayouts(
        payoutBatch.payouts,
        approval.adjusted_payouts
      );
      if (callbackAdjustmentResult.status !== "ok") {
        await appendAuditEvent("payout_execution_skipped", {
          reason: callbackAdjustmentResult.reason,
          candidate_payout_count: payoutBatch.payouts.length,
        });
        await appendObservability({
          pagesFetched,
          libraryCount: usageStats.length,
          anomalyDetected: false,
          anomalyCodes: [],
          payoutOutcome: "skipped",
          candidatePayoutCount: payoutBatch.payouts.length,
          executedCount: 0,
          skipReason: callbackAdjustmentResult.reason,
        });
        return buildCompletedOutput({
          status: "skipped",
          reason: callbackAdjustmentResult.reason,
          executed_count: 0,
        });
      }
      payoutExecutionCandidates = callbackAdjustmentResult.payouts;
      notes.push(`approval_adjusted_payouts=${payoutExecutionCandidates.length}`);
    }
  }

  if (approval && !approval.approved) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: approval.reason ?? "approval_required",
      candidate_payout_count: payoutExecutionCandidates.length,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: payoutExecutionCandidates.length,
      executedCount: 0,
      skipReason: approval.reason ?? "approval_required",
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: approval.reason ?? "approval_required",
      executed_count: 0,
    });
  }

  if (!options.executePayouts) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: "execute_payouts_not_configured",
      candidate_payout_count: payoutExecutionCandidates.length,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: payoutExecutionCandidates.length,
      executedCount: 0,
      skipReason: "execute_payouts_not_configured",
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: "execute_payouts_not_configured",
      executed_count: 0,
    });
  }

  if (payoutExecutionCandidates.length === 0) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: "no_eligible_payouts",
      candidate_payout_count: 0,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: 0,
      executedCount: 0,
      skipReason: "no_eligible_payouts",
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: "no_eligible_payouts",
      executed_count: 0,
    });
  }

  const existingExecutionRecorded = (
    (
      options.auditStore
        ? await options.auditStore.readByPeriod(parsedInput.period)
        : getInMemoryRoyaltyCycleAuditsByPeriod(parsedInput.period)
    ) ?? []
  ).some((event) => {
    if (event.event_type !== "payout_execution_executed") {
      return false;
    }
    return event.payload.payout_batch_hash === payoutBatchHash;
  });
  if (existingExecutionRecorded) {
    await executionClaimStore.markExecuted(payoutExecutionIdempotencyKey);
    await appendAuditEvent("payout_execution_skipped", {
      reason: "already_executed",
      candidate_payout_count: payoutExecutionCandidates.length,
      payout_batch_hash: payoutBatchHash,
      idempotency_key: payoutExecutionIdempotencyKey,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: payoutExecutionCandidates.length,
      executedCount: 0,
      skipReason: "already_executed",
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: "already_executed",
      executed_count: 0,
    });
  }

  const claimStatus = await executionClaimStore.tryClaim(
    payoutExecutionIdempotencyKey
  );
  if (claimStatus !== "acquired") {
    const skipReason =
      claimStatus === "already_executed"
        ? "already_executed"
        : "payout_execution_in_progress";
    await appendAuditEvent("payout_execution_skipped", {
      reason: skipReason,
      candidate_payout_count: payoutExecutionCandidates.length,
      payout_batch_hash: payoutBatchHash,
      idempotency_key: payoutExecutionIdempotencyKey,
    });
    await appendObservability({
      pagesFetched,
      libraryCount: usageStats.length,
      anomalyDetected: false,
      anomalyCodes: [],
      payoutOutcome: "skipped",
      candidatePayoutCount: payoutExecutionCandidates.length,
      executedCount: 0,
      skipReason,
    });
    return buildCompletedOutput({
      status: "skipped",
      reason: skipReason,
      executed_count: 0,
    });
  }

  let executionCompleted = false;
  let executionResult: ExecutePayoutsResult;
  try {
    assertToolAuthorized({
      toolName: "execute_payouts",
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestBypass: options.allowTestAuthBypass }),
    });
    assertToolRiskAllowed({
      toolName: "execute_payouts",
      maxAllowedRisk: payoutRisk,
    });

    executionResult = await options.executePayouts({
      period: parsedInput.period,
      currency: payoutBatch.currency,
      payouts: payoutExecutionCandidates,
      idempotency_key: payoutExecutionIdempotencyKey,
    });
    executionCompleted = true;
    // Mark execution as completed before downstream writes so retries never
    // trigger a second transfer if audit/observability persistence fails.
    await executionClaimStore.markExecuted(payoutExecutionIdempotencyKey);
  } catch (error) {
    if (!executionCompleted) {
      await executionClaimStore.releaseClaim(payoutExecutionIdempotencyKey);
    }
    throw error;
  }

  await appendAuditEvent("payout_execution_executed", {
    candidate_payout_count: payoutExecutionCandidates.length,
    executed_count: executionResult.executed_count ?? payoutExecutionCandidates.length,
    payout_batch_hash: payoutBatchHash,
    idempotency_key: payoutExecutionIdempotencyKey,
  });
  await appendObservability({
    pagesFetched,
    libraryCount: usageStats.length,
    anomalyDetected: false,
    anomalyCodes: [],
    payoutOutcome: "executed",
    candidatePayoutCount: payoutExecutionCandidates.length,
    executedCount: executionResult.executed_count ?? payoutExecutionCandidates.length,
  });
  return buildCompletedOutput({
    status: "executed",
    executed_count: executionResult.executed_count ?? payoutExecutionCandidates.length,
    results: executionResult.results ?? null,
  });
}
