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
  type PayoutBatchEntry,
} from "../tools/create-payout-batch.js";
import {
  detectPayoutAnomalies,
  type DetectPayoutAnomaliesResult,
} from "../tools/payout-anomaly-detector.js";
import {
  appendRoyaltyCycleAuditEvent,
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
  type LibraryUsageEventStore,
} from "../tools/library-usage-ingestion.js";
import { type LibraryIdResolver } from "../tools/library-registry.js";
import { type AuthorizationRuntimeEnvironment } from "../tools/authz.js";
import { type ToolRiskLevel } from "../tools/guardrails.js";

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
};

export type ExecutePayoutsResult = {
  executed_count?: number;
  results?: unknown;
};

export type RunRoyaltyCycleOptions = {
  eventStore?: LibraryUsageEventStore;
  allocationStore?: AllocationPersistenceStore;
  auditStore?: RoyaltyCycleAuditStore;
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
  now?: () => number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  payoutMaxAllowedRisk?: ToolRiskLevel;
  maxAggregationPeriodDays?: number;
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
  const adjustedPayouts: PayoutBatchEntry[] = [];
  let adjustedTotal = 0;

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

    adjustedTotal += adjustment.amount_minor;
    adjustedPayouts.push({
      ...basePayout,
      amount_minor: adjustment.amount_minor,
    });
  }

  if (adjustedTotal > originalTotal) {
    return {
      status: "invalid",
      reason: "adjusted payouts exceed original eligible payout total",
    };
  }

  return {
    status: "ok",
    payouts: adjustedPayouts.sort((left, right) =>
      left.maintainer_id.localeCompare(right.maintainer_id)
    ),
  };
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
  });

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
    return {
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
      execution: {
        status: "skipped",
        reason: anomalyResult.reason ?? "payout_anomaly_detected",
        executed_count: 0,
      },
      notes,
    };
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
      return {
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
        execution: {
          status: "skipped",
          reason: "approval_required",
          executed_count: 0,
        },
        notes,
      };
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
      return {
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
        execution: {
          status: "skipped",
          reason: storedApproval.reason || "payout_batch_denied",
          executed_count: 0,
        },
        notes,
      };
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
        return {
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
          execution: {
            status: "skipped",
            reason: adjustmentResult.reason,
            executed_count: 0,
          },
          notes,
        };
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
      payoutExecutionCandidates = approval.adjusted_payouts;
      notes.push(`approval_adjusted_payouts=${payoutExecutionCandidates.length}`);
    }
  }

  if (approval && !approval.approved) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: approval.reason ?? "approval_required",
      candidate_payout_count: payoutExecutionCandidates.length,
    });
    return {
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
      execution: {
        status: "skipped",
        reason: approval.reason ?? "approval_required",
        executed_count: 0,
      },
      notes,
    };
  }

  if (!options.executePayouts) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: "execute_payouts_not_configured",
      candidate_payout_count: payoutExecutionCandidates.length,
    });
    return {
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
      execution: {
        status: "skipped",
        reason: "execute_payouts_not_configured",
        executed_count: 0,
      },
      notes,
    };
  }

  if (payoutExecutionCandidates.length === 0) {
    await appendAuditEvent("payout_execution_skipped", {
      reason: "no_eligible_payouts",
      candidate_payout_count: 0,
    });
    return {
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
      execution: {
        status: "skipped",
        reason: "no_eligible_payouts",
        executed_count: 0,
      },
      notes,
    };
  }

  const executionResult = await options.executePayouts({
    period: parsedInput.period,
    currency: payoutBatch.currency,
    payouts: payoutExecutionCandidates,
  });
  await appendAuditEvent("payout_execution_executed", {
    candidate_payout_count: payoutExecutionCandidates.length,
    executed_count: executionResult.executed_count ?? payoutExecutionCandidates.length,
  });
  return {
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
    execution: {
      status: "executed",
      executed_count: executionResult.executed_count ?? payoutExecutionCandidates.length,
      results: executionResult.results ?? null,
    },
    notes,
  };
}
