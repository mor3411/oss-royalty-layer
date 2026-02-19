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

export async function runRoyaltyCycle(
  input: unknown,
  options: RunRoyaltyCycleOptions = {}
): Promise<RunRoyaltyCycleOutput> {
  const parsedInput = RunRoyaltyCycleInputSchema.parse(input);
  const notes: string[] = [];
  const mediumRisk = options.maxAllowedRisk ?? "medium";
  const payoutRisk = options.payoutMaxAllowedRisk ?? "high";
  const eventStore = options.eventStore ?? defaultEventStore;

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

  const approval = options.approvePayoutBatch
    ? await options.approvePayoutBatch({
        payoutBatch,
        allocation,
        persistence,
      })
    : { approved: false, reason: "approval_required" };
  if (!approval.approved) {
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

  if (payoutBatch.payouts.length === 0) {
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
    payouts: payoutBatch.payouts,
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
      executed_count: executionResult.executed_count ?? payoutBatch.payouts.length,
      results: executionResult.results ?? null,
    },
    notes,
  };
}
