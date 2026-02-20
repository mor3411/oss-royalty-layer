import { z } from "zod";
import { PeriodSchema } from "../domain/index.js";
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

const SAFE_INTEGER_SCHEMA = z.number().int().safe();

export const RoyaltyRunTelemetryMetricsSchema = z.object({
  events_received: SAFE_INTEGER_SCHEMA.nonnegative(),
  events_persisted: SAFE_INTEGER_SCHEMA.nonnegative(),
  events_failed: SAFE_INTEGER_SCHEMA.nonnegative(),
  last_ingested_at: z.string().datetime().optional(),
  ingestion_lag_ms: SAFE_INTEGER_SCHEMA.nonnegative().nullable().optional(),
});

export const RoyaltyRunAggregationMetricsSchema = z.object({
  pages_fetched: SAFE_INTEGER_SCHEMA.nonnegative(),
  library_count: SAFE_INTEGER_SCHEMA.nonnegative(),
  aggregation_lag_ms: SAFE_INTEGER_SCHEMA.nonnegative(),
});

export const RoyaltyRunAnomalyMetricsSchema = z.object({
  detected: z.boolean(),
  codes: z.array(z.string().min(1)).default([]),
});

export const RoyaltyRunPayoutMetricsSchema = z.object({
  outcome: z.enum(["executed", "skipped"]),
  candidate_payout_count: SAFE_INTEGER_SCHEMA.nonnegative(),
  executed_count: SAFE_INTEGER_SCHEMA.nonnegative(),
  skip_reason: z.string().min(1).optional(),
});

export const RoyaltyObservabilitySampleSchema = z.object({
  sample_id: z.string().min(1),
  period: PeriodSchema,
  run_id: z.string().min(1),
  recorded_at: z.string().datetime(),
  telemetry: RoyaltyRunTelemetryMetricsSchema.optional(),
  aggregation: RoyaltyRunAggregationMetricsSchema,
  anomaly: RoyaltyRunAnomalyMetricsSchema,
  payout: RoyaltyRunPayoutMetricsSchema,
});

export const RecordRoyaltyObservabilityInputSchema = z.object({
  period: PeriodSchema,
  run_id: z.string().min(1),
  telemetry: RoyaltyRunTelemetryMetricsSchema.optional(),
  aggregation: RoyaltyRunAggregationMetricsSchema,
  anomaly: RoyaltyRunAnomalyMetricsSchema,
  payout: RoyaltyRunPayoutMetricsSchema,
});

export const RecordRoyaltyObservabilityOutputSchema = z.object({
  status: z.literal("recorded"),
  sample_id: z.string().min(1),
  period: PeriodSchema,
  run_id: z.string().min(1),
  recorded_at: z.string().datetime(),
});

export const RoyaltyObservabilityAlertSchema = z.object({
  code: z.enum([
    "telemetry_ingestion_failure_rate_exceeded",
    "aggregation_lag_exceeded",
    "anomaly_hit_rate_exceeded",
    "payout_skip_rate_exceeded",
  ]),
  severity: z.enum(["warning", "critical"]),
  message: z.string().min(1),
});

export const RoyaltyObservabilityThresholdsSchema = z.object({
  max_ingestion_failure_rate: z.number().min(0).max(1).default(0.02),
  max_aggregation_lag_ms: SAFE_INTEGER_SCHEMA.nonnegative().default(
    6 * 60 * 60 * 1000
  ),
  max_anomaly_hit_rate: z.number().min(0).max(1).default(0.2),
  max_payout_skip_rate: z.number().min(0).max(1).default(0.2),
});

export const GetRoyaltyObservabilityDashboardInputSchema = z.object({
  period: PeriodSchema.optional(),
  thresholds: RoyaltyObservabilityThresholdsSchema.optional(),
});

export const RoyaltyObservabilityDashboardSchema = z.object({
  period: PeriodSchema.optional(),
  totals: z.object({
    runs: SAFE_INTEGER_SCHEMA.nonnegative(),
    executed_runs: SAFE_INTEGER_SCHEMA.nonnegative(),
    skipped_runs: SAFE_INTEGER_SCHEMA.nonnegative(),
    anomaly_hits: SAFE_INTEGER_SCHEMA.nonnegative(),
    telemetry_events_received: SAFE_INTEGER_SCHEMA.nonnegative(),
    telemetry_events_failed: SAFE_INTEGER_SCHEMA.nonnegative(),
  }),
  rates: z.object({
    ingestion_failure_rate: z.number().min(0).max(1),
    anomaly_hit_rate: z.number().min(0).max(1),
    payout_skip_rate: z.number().min(0).max(1),
  }),
  latest: z.object({
    aggregation_lag_ms: SAFE_INTEGER_SCHEMA.nonnegative().nullable(),
    last_recorded_at: z.string().datetime().nullable(),
  }),
  alerts: z.array(RoyaltyObservabilityAlertSchema),
});

export type RoyaltyRunTelemetryMetrics = z.infer<
  typeof RoyaltyRunTelemetryMetricsSchema
>;
export type RoyaltyRunAggregationMetrics = z.infer<
  typeof RoyaltyRunAggregationMetricsSchema
>;
export type RoyaltyRunAnomalyMetrics = z.infer<
  typeof RoyaltyRunAnomalyMetricsSchema
>;
export type RoyaltyRunPayoutMetrics = z.infer<typeof RoyaltyRunPayoutMetricsSchema>;
export type RoyaltyObservabilitySample = z.infer<
  typeof RoyaltyObservabilitySampleSchema
>;
export type RecordRoyaltyObservabilityInput = z.infer<
  typeof RecordRoyaltyObservabilityInputSchema
>;
export type RecordRoyaltyObservabilityOutput = z.infer<
  typeof RecordRoyaltyObservabilityOutputSchema
>;
export type RoyaltyObservabilityAlert = z.infer<
  typeof RoyaltyObservabilityAlertSchema
>;
export type RoyaltyObservabilityThresholds = z.infer<
  typeof RoyaltyObservabilityThresholdsSchema
>;
export type GetRoyaltyObservabilityDashboardInput = z.infer<
  typeof GetRoyaltyObservabilityDashboardInputSchema
>;
export type RoyaltyObservabilityDashboard = z.infer<
  typeof RoyaltyObservabilityDashboardSchema
>;

export type RoyaltyObservabilityStore = {
  appendSample: (sample: RoyaltyObservabilitySample) => Promise<void> | void;
  readSamples:
    (period?: string) =>
      | Promise<RoyaltyObservabilitySample[]>
      | RoyaltyObservabilitySample[];
  clear?: () => Promise<void> | void;
};

type RecordRoyaltyObservabilityOptions = {
  store?: RoyaltyObservabilityStore;
  now?: () => number;
  sampleIdGenerator?: (period: string, runId: string, nowMs: number) => string;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
};

type GetRoyaltyObservabilityDashboardOptions = {
  store?: RoyaltyObservabilityStore;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
};

const inMemorySamples: RoyaltyObservabilitySample[] = [];

function cloneSample(sample: RoyaltyObservabilitySample): RoyaltyObservabilitySample {
  return {
    ...sample,
    ...(sample.telemetry === undefined ? {} : { telemetry: { ...sample.telemetry } }),
    aggregation: { ...sample.aggregation },
    anomaly: { ...sample.anomaly, codes: [...sample.anomaly.codes] },
    payout: { ...sample.payout },
  };
}

const inMemoryRoyaltyObservabilityStore: RoyaltyObservabilityStore = {
  appendSample(sample: RoyaltyObservabilitySample): void {
    inMemorySamples.push(cloneSample(sample));
  },

  readSamples(period?: string): RoyaltyObservabilitySample[] {
    return inMemorySamples
      .filter((sample) => (period === undefined ? true : sample.period === period))
      .map((sample) => cloneSample(sample));
  },

  clear(): void {
    inMemorySamples.length = 0;
  },
};

function defaultSampleIdGenerator(period: string, runId: string, nowMs: number): string {
  const base = `${period}:${runId}:${nowMs}:${inMemorySamples.length}`;
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = (hash * 31 + base.charCodeAt(index)) >>> 0;
  }
  return `obs_${hash.toString(16).padStart(8, "0")}`;
}

export function clearInMemoryRoyaltyObservabilitySamples(): void {
  inMemorySamples.length = 0;
}

export function getInMemoryRoyaltyObservabilitySamples(
  period?: string
): RoyaltyObservabilitySample[] {
  return inMemorySamples
    .filter((sample) => (period === undefined ? true : sample.period === period))
    .map((sample) => cloneSample(sample));
}

export async function recordRoyaltyObservabilitySample(
  input: unknown,
  options: RecordRoyaltyObservabilityOptions = {}
): Promise<RecordRoyaltyObservabilityOutput> {
  assertToolAuthorized({
    toolName: "record_royalty_observability",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "record_royalty_observability",
    maxAllowedRisk: options.maxAllowedRisk ?? "medium",
  });
  assertToolInputVetting("record_royalty_observability", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = RecordRoyaltyObservabilityInputSchema.parse(input);
  const nowMs = options.now?.() ?? Date.now();
  const recordedAt = new Date(nowMs).toISOString();
  const sampleIdGenerator = options.sampleIdGenerator ?? defaultSampleIdGenerator;
  const sampleId = sampleIdGenerator(parsedInput.period, parsedInput.run_id, nowMs);
  const store = options.store ?? inMemoryRoyaltyObservabilityStore;

  const sample: RoyaltyObservabilitySample = {
    sample_id: sampleId,
    period: parsedInput.period,
    run_id: parsedInput.run_id,
    recorded_at: recordedAt,
    ...(parsedInput.telemetry === undefined
      ? {}
      : { telemetry: parsedInput.telemetry }),
    aggregation: parsedInput.aggregation,
    anomaly: parsedInput.anomaly,
    payout: parsedInput.payout,
  };
  await store.appendSample(sample);

  const output: RecordRoyaltyObservabilityOutput = {
    status: "recorded",
    sample_id: sampleId,
    period: parsedInput.period,
    run_id: parsedInput.run_id,
    recorded_at: recordedAt,
  };
  assertToolOutputSanity("record_royalty_observability", output);
  return output;
}

export async function getRoyaltyObservabilityDashboard(
  input: unknown = {},
  options: GetRoyaltyObservabilityDashboardOptions = {}
): Promise<RoyaltyObservabilityDashboard> {
  assertToolAuthorized({
    toolName: "get_royalty_observability_dashboard",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "get_royalty_observability_dashboard",
    maxAllowedRisk: options.maxAllowedRisk ?? "medium",
  });
  assertToolInputVetting("get_royalty_observability_dashboard", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = GetRoyaltyObservabilityDashboardInputSchema.parse(input);
  const thresholds = RoyaltyObservabilityThresholdsSchema.parse(
    parsedInput.thresholds ?? {}
  );
  const store = options.store ?? inMemoryRoyaltyObservabilityStore;
  const samples = await store.readSamples(parsedInput.period);

  const totals = {
    runs: samples.length,
    executed_runs: 0,
    skipped_runs: 0,
    anomaly_hits: 0,
    telemetry_events_received: 0,
    telemetry_events_failed: 0,
  };

  let lastRecordedAt: string | null = null;
  let latestAggregationLagMs: number | null = null;

  for (const sample of samples) {
    if (sample.payout.outcome === "executed") {
      totals.executed_runs += 1;
    } else {
      totals.skipped_runs += 1;
    }
    if (sample.anomaly.detected) {
      totals.anomaly_hits += 1;
    }
    if (sample.telemetry) {
      totals.telemetry_events_received += sample.telemetry.events_received;
      totals.telemetry_events_failed += sample.telemetry.events_failed;
    }
    if (!lastRecordedAt || sample.recorded_at > lastRecordedAt) {
      lastRecordedAt = sample.recorded_at;
      latestAggregationLagMs = sample.aggregation.aggregation_lag_ms;
    }
  }

  const ingestionFailureRate =
    totals.telemetry_events_received > 0
      ? totals.telemetry_events_failed / totals.telemetry_events_received
      : 0;
  const anomalyHitRate = totals.runs > 0 ? totals.anomaly_hits / totals.runs : 0;
  const payoutSkipRate = totals.runs > 0 ? totals.skipped_runs / totals.runs : 0;

  const alerts: RoyaltyObservabilityAlert[] = [];
  if (ingestionFailureRate > thresholds.max_ingestion_failure_rate) {
    alerts.push({
      code: "telemetry_ingestion_failure_rate_exceeded",
      severity: "critical",
      message: `telemetry ingestion failure rate ${(ingestionFailureRate * 100).toFixed(
        2
      )}% exceeds threshold ${(thresholds.max_ingestion_failure_rate * 100).toFixed(2)}%`,
    });
  }
  if (
    latestAggregationLagMs !== null &&
    latestAggregationLagMs > thresholds.max_aggregation_lag_ms
  ) {
    alerts.push({
      code: "aggregation_lag_exceeded",
      severity: "warning",
      message: `aggregation lag ${latestAggregationLagMs}ms exceeds threshold ${thresholds.max_aggregation_lag_ms}ms`,
    });
  }
  if (anomalyHitRate > thresholds.max_anomaly_hit_rate) {
    alerts.push({
      code: "anomaly_hit_rate_exceeded",
      severity: "warning",
      message: `anomaly hit rate ${(anomalyHitRate * 100).toFixed(
        2
      )}% exceeds threshold ${(thresholds.max_anomaly_hit_rate * 100).toFixed(2)}%`,
    });
  }
  if (payoutSkipRate > thresholds.max_payout_skip_rate) {
    alerts.push({
      code: "payout_skip_rate_exceeded",
      severity: "warning",
      message: `payout skip rate ${(payoutSkipRate * 100).toFixed(
        2
      )}% exceeds threshold ${(thresholds.max_payout_skip_rate * 100).toFixed(2)}%`,
    });
  }

  const output: RoyaltyObservabilityDashboard = {
    ...(parsedInput.period === undefined ? {} : { period: parsedInput.period }),
    totals,
    rates: {
      ingestion_failure_rate: Number(ingestionFailureRate.toFixed(6)),
      anomaly_hit_rate: Number(anomalyHitRate.toFixed(6)),
      payout_skip_rate: Number(payoutSkipRate.toFixed(6)),
    },
    latest: {
      aggregation_lag_ms: latestAggregationLagMs,
      last_recorded_at: lastRecordedAt,
    },
    alerts,
  };

  return RoyaltyObservabilityDashboardSchema.parse(output);
}
