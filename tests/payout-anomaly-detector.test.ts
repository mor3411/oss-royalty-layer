import { describe, expect, it } from "vitest";

import { detectPayoutAnomalies } from "../src/tools/payout-anomaly-detector.js";

describe("detectPayoutAnomalies", () => {
  it("flags concentration spikes for single-recipient payouts", () => {
    const result = detectPayoutAnomalies({
      payoutBatch: {
        period: "2026-02",
        currency: "USD",
        payouts: [
          {
            maintainer_id: "mnt.alpha",
            amount_minor: 5_000,
            currency: "USD",
            payout_account: {
              provider: "stripe",
              account_id: "acct_alpha",
            },
            allocation_count: 2,
          },
        ],
        flagged: [],
        totals: {
          total_amount_minor: 5_000,
          eligible_amount_minor: 5_000,
          flagged_amount_minor: 0,
        },
        notes: "single-recipient payout",
      },
      allocation: {
        period: "2026-02",
        pool_amount_minor: 5_000,
        policy_applied: {
          configured_max_share_per_library: 1,
          effective_max_share_per_library: 1,
          min_floor_amount_minor: 0,
          long_tail_weight: 1,
        },
        allocations: [
          {
            library_id: "lib.alpha",
            maintainer_id: "mnt.alpha",
            amount_minor: 5_000,
            confidence_score: 0.8,
            flags: [],
          },
        ],
        notes: "allocations",
      },
    });

    expect(result.has_anomaly).toBe(true);
    expect(result.codes).toContain("concentration_spike");
  });

  it("flags wash-usage patterns when low-signal allocations dominate recipient share", () => {
    const result = detectPayoutAnomalies({
      payoutBatch: {
        period: "2026-02",
        currency: "USD",
        payouts: [
          {
            maintainer_id: "mnt.alpha",
            amount_minor: 700,
            currency: "USD",
            payout_account: {
              provider: "stripe",
              account_id: "acct_alpha",
            },
            allocation_count: 2,
          },
          {
            maintainer_id: "mnt.beta",
            amount_minor: 300,
            currency: "USD",
            payout_account: {
              provider: "stripe",
              account_id: "acct_beta",
            },
            allocation_count: 1,
          },
        ],
        flagged: [],
        totals: {
          total_amount_minor: 1_000,
          eligible_amount_minor: 1_000,
          flagged_amount_minor: 0,
        },
        notes: "two-recipient payout",
      },
      allocation: {
        period: "2026-02",
        pool_amount_minor: 1_000,
        policy_applied: {
          configured_max_share_per_library: 1,
          effective_max_share_per_library: 1,
          min_floor_amount_minor: 0,
          long_tail_weight: 1,
        },
        allocations: [
          {
            library_id: "lib.alpha",
            maintainer_id: "mnt.alpha",
            amount_minor: 500,
            confidence_score: 0.2,
            flags: ["low_usage_signal"],
          },
          {
            library_id: "lib.gamma",
            maintainer_id: "mnt.alpha",
            amount_minor: 200,
            confidence_score: 0.3,
            flags: ["low_usage_signal"],
          },
          {
            library_id: "lib.beta",
            maintainer_id: "mnt.beta",
            amount_minor: 300,
            confidence_score: 0.9,
            flags: [],
          },
        ],
        notes: "allocations",
      },
    });

    expect(result.has_anomaly).toBe(true);
    expect(result.codes).toContain("wash_usage_pattern");
  });

  it("returns no anomaly for balanced, high-confidence batches", () => {
    const result = detectPayoutAnomalies({
      payoutBatch: {
        period: "2026-02",
        currency: "USD",
        payouts: [
          {
            maintainer_id: "mnt.alpha",
            amount_minor: 500,
            currency: "USD",
            payout_account: {
              provider: "stripe",
              account_id: "acct_alpha",
            },
            allocation_count: 1,
          },
          {
            maintainer_id: "mnt.beta",
            amount_minor: 500,
            currency: "USD",
            payout_account: {
              provider: "stripe",
              account_id: "acct_beta",
            },
            allocation_count: 1,
          },
        ],
        flagged: [],
        totals: {
          total_amount_minor: 1_000,
          eligible_amount_minor: 1_000,
          flagged_amount_minor: 0,
        },
        notes: "balanced payout",
      },
      allocation: {
        period: "2026-02",
        pool_amount_minor: 1_000,
        policy_applied: {
          configured_max_share_per_library: 1,
          effective_max_share_per_library: 1,
          min_floor_amount_minor: 0,
          long_tail_weight: 1,
        },
        allocations: [
          {
            library_id: "lib.alpha",
            maintainer_id: "mnt.alpha",
            amount_minor: 500,
            confidence_score: 0.9,
            flags: [],
          },
          {
            library_id: "lib.beta",
            maintainer_id: "mnt.beta",
            amount_minor: 500,
            confidence_score: 0.92,
            flags: [],
          },
        ],
        notes: "allocations",
      },
    });

    expect(result.has_anomaly).toBe(false);
    expect(result.codes).toEqual([]);
  });
});
