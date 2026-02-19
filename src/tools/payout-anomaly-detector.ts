import { z } from "zod";
import { type ComputeAllocationsOutput } from "./compute-allocations.js";
import { type CreatePayoutBatchOutput } from "./create-payout-batch.js";

export const PayoutAnomalyCodeSchema = z.enum([
  "concentration_spike",
  "wash_usage_pattern",
  "batch_amount_outlier",
]);
export type PayoutAnomalyCode = z.infer<typeof PayoutAnomalyCodeSchema>;

export type PayoutAnomalySignal = {
  code: PayoutAnomalyCode;
  message: string;
};

export type DetectPayoutAnomaliesInput = {
  payoutBatch: CreatePayoutBatchOutput;
  allocation: ComputeAllocationsOutput;
};

export type DetectPayoutAnomaliesConfig = {
  maxTopRecipientShare: number;
  concentrationMinAmountMinor: number;
  outlierTopToMedianRatio: number;
  outlierMinGapMinor: number;
  washUsageMinPayoutShare: number;
  washUsageMinLowSignalRatio: number;
  lowConfidenceThreshold: number;
};

export type DetectPayoutAnomaliesResult = {
  has_anomaly: boolean;
  reason?: string;
  codes: PayoutAnomalyCode[];
  signals: PayoutAnomalySignal[];
};

export const DEFAULT_PAYOUT_ANOMALY_CONFIG: DetectPayoutAnomaliesConfig = {
  maxTopRecipientShare: 0.85,
  concentrationMinAmountMinor: 500,
  outlierTopToMedianRatio: 8,
  outlierMinGapMinor: 10_000,
  washUsageMinPayoutShare: 0.35,
  washUsageMinLowSignalRatio: 0.75,
  lowConfidenceThreshold: 0.45,
};

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    const left = ordered[mid - 1] ?? 0;
    const right = ordered[mid] ?? 0;
    return (left + right) / 2;
  }
  return ordered[mid] ?? 0;
}

function mergeConfig(
  config: Partial<DetectPayoutAnomaliesConfig> | undefined
): DetectPayoutAnomaliesConfig {
  return {
    ...DEFAULT_PAYOUT_ANOMALY_CONFIG,
    ...(config ?? {}),
  };
}

export function detectPayoutAnomalies(
  input: DetectPayoutAnomaliesInput,
  config?: Partial<DetectPayoutAnomaliesConfig>
): DetectPayoutAnomaliesResult {
  const effectiveConfig = mergeConfig(config);
  const payouts = input.payoutBatch.payouts;
  const totalEligible = input.payoutBatch.totals.eligible_amount_minor;
  if (payouts.length === 0 || totalEligible <= 0) {
    return {
      has_anomaly: false,
      codes: [],
      signals: [],
    };
  }

  const signals: PayoutAnomalySignal[] = [];

  const topPayout = payouts.reduce((current, payout) =>
    payout.amount_minor > current.amount_minor ? payout : current
  );
  const topShare = topPayout.amount_minor / totalEligible;
  if (
    topPayout.amount_minor >= effectiveConfig.concentrationMinAmountMinor &&
    (payouts.length === 1 || topShare >= effectiveConfig.maxTopRecipientShare)
  ) {
    signals.push({
      code: "concentration_spike",
      message: `top recipient share ${topShare.toFixed(4)} exceeds threshold`,
    });
  }

  if (payouts.length >= 3) {
    const payoutAmounts = payouts.map((payout) => payout.amount_minor);
    const medianAmount = median(payoutAmounts);
    const topToMedianRatio =
      medianAmount > 0 ? topPayout.amount_minor / medianAmount : Number.POSITIVE_INFINITY;
    const topGap = topPayout.amount_minor - medianAmount;
    if (
      topToMedianRatio >= effectiveConfig.outlierTopToMedianRatio &&
      topGap >= effectiveConfig.outlierMinGapMinor
    ) {
      signals.push({
        code: "batch_amount_outlier",
        message: `top payout to median ratio ${topToMedianRatio.toFixed(4)} exceeds threshold`,
      });
    }
  }

  const byMaintainer = new Map<
    string,
    { totalAmountMinor: number; lowSignalAmountMinor: number }
  >();
  for (const allocation of input.allocation.allocations) {
    const current = byMaintainer.get(allocation.maintainer_id) ?? {
      totalAmountMinor: 0,
      lowSignalAmountMinor: 0,
    };
    const isLowSignal =
      allocation.confidence_score <= effectiveConfig.lowConfidenceThreshold ||
      allocation.flags.includes("low_usage_signal");
    current.totalAmountMinor += allocation.amount_minor;
    if (isLowSignal) {
      current.lowSignalAmountMinor += allocation.amount_minor;
    }
    byMaintainer.set(allocation.maintainer_id, current);
  }

  for (const payout of payouts) {
    const maintainer = byMaintainer.get(payout.maintainer_id);
    if (!maintainer || maintainer.totalAmountMinor <= 0) {
      continue;
    }
    const payoutShare = payout.amount_minor / totalEligible;
    const lowSignalRatio = maintainer.lowSignalAmountMinor / maintainer.totalAmountMinor;
    if (
      payoutShare >= effectiveConfig.washUsageMinPayoutShare &&
      lowSignalRatio >= effectiveConfig.washUsageMinLowSignalRatio
    ) {
      signals.push({
        code: "wash_usage_pattern",
        message: `maintainer ${payout.maintainer_id} has low-signal ratio ${lowSignalRatio.toFixed(
          4
        )}`,
      });
    }
  }

  const codes: PayoutAnomalyCode[] = [...new Set(signals.map((signal) => signal.code))];
  if (codes.length === 0) {
    return {
      has_anomaly: false,
      codes: [],
      signals: [],
    };
  }
  const firstMessage = signals[0]?.message;
  return {
    has_anomaly: true,
    codes,
    signals,
    ...(firstMessage === undefined ? {} : { reason: firstMessage }),
  };
}
