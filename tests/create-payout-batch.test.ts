import { beforeEach, describe, expect, it } from "vitest";

import { createPayoutBatch } from "../src/tools/create-payout-batch.js";
import { persistAllocations } from "../src/tools/persist-allocations.js";
import {
  clearInMemoryMaintainerProfiles,
  clearInMemoryPersistedAllocations,
  upsertInMemoryMaintainerProfile,
} from "../src/tools/testing.js";

const PERIOD = "2026-02";

describe("createPayoutBatch", () => {
  beforeEach(() => {
    clearInMemoryPersistedAllocations();
    clearInMemoryMaintainerProfiles();
  });

  it("groups allocations by maintainer and flags unverified or missing-account maintainers", async () => {
    await persistAllocations({
      period: PERIOD,
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
          maintainer_id: "mnt.verified",
          amount_minor: 300,
          confidence_score: 0.9,
          flags: [],
        },
        {
          library_id: "lib.beta",
          maintainer_id: "mnt.verified",
          amount_minor: 200,
          confidence_score: 0.8,
          flags: [],
        },
        {
          library_id: "lib.gamma",
          maintainer_id: "mnt.pending",
          amount_minor: 250,
          confidence_score: 0.8,
          flags: [],
        },
        {
          library_id: "lib.delta",
          maintainer_id: "mnt.noaccount",
          amount_minor: 250,
          confidence_score: 0.7,
          flags: [],
        },
      ],
      notes: "persisted allocation proposal",
    });

    upsertInMemoryMaintainerProfile({
      id: "mnt.verified",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_verified",
      },
      trust_score: 0.8,
    });
    upsertInMemoryMaintainerProfile({
      id: "mnt.pending",
      verification_status: "pending",
      payout_account: {
        provider: "stripe",
        account_id: "acct_pending",
      },
      trust_score: 0.6,
    });
    upsertInMemoryMaintainerProfile({
      id: "mnt.noaccount",
      verification_status: "verified",
      payout_account: null,
      trust_score: 0.6,
    });

    const result = await createPayoutBatch({
      period: PERIOD,
      currency: "usd",
    });

    expect(result.currency).toBe("USD");
    expect(result.payouts).toEqual([
      {
        maintainer_id: "mnt.verified",
        amount_minor: 500,
        currency: "USD",
        payout_account: {
          provider: "stripe",
          account_id: "acct_verified",
        },
        allocation_count: 2,
      },
    ]);
    expect(result.flagged).toHaveLength(2);
    expect(result.flagged).toContainEqual({
      maintainer_id: "mnt.pending",
      amount_minor: 250,
      allocation_count: 1,
      reason: "maintainer_not_verified",
      verification_status: "pending",
    });
    expect(result.flagged).toContainEqual({
      maintainer_id: "mnt.noaccount",
      amount_minor: 250,
      allocation_count: 1,
      reason: "payout_account_missing",
      verification_status: "verified",
    });
    expect(result.totals).toEqual({
      total_amount_minor: 1_000,
      eligible_amount_minor: 500,
      flagged_amount_minor: 500,
    });
  });

  it("flags maintainers that cannot be resolved", async () => {
    await persistAllocations({
      period: PERIOD,
      pool_amount_minor: 100,
      policy_applied: {
        configured_max_share_per_library: 1,
        effective_max_share_per_library: 1,
        min_floor_amount_minor: 0,
        long_tail_weight: 1,
      },
      allocations: [
        {
          library_id: "lib.alpha",
          maintainer_id: "mnt.missing",
          amount_minor: 100,
          confidence_score: 0.9,
          flags: [],
        },
      ],
      notes: "persisted allocation proposal",
    });

    const result = await createPayoutBatch({
      period: PERIOD,
      currency: "USD",
    });

    expect(result.payouts).toEqual([]);
    expect(result.flagged).toEqual([
      {
        maintainer_id: "mnt.missing",
        amount_minor: 100,
        allocation_count: 1,
        reason: "maintainer_not_found",
      },
    ]);
  });

  it("rejects when no persisted allocations exist for the period", async () => {
    await expect(
      createPayoutBatch({
        period: PERIOD,
        currency: "USD",
      })
    ).rejects.toThrowError(`no persisted allocations found for period ${PERIOD}`);
  });

  it("enforces authorization in production without principal", async () => {
    await expect(
      createPayoutBatch(
        {
          period: PERIOD,
          currency: "USD",
        },
        {
          runtimeEnvironment: "production",
          allowTestAuthBypass: false,
        }
      )
    ).rejects.toThrowError("authorization required");
  });

  it("enforces high-risk allowance", async () => {
    await expect(
      createPayoutBatch(
        {
          period: PERIOD,
          currency: "USD",
        },
        {
          maxAllowedRisk: "medium",
        }
      )
    ).rejects.toThrowError("requires high risk allowance");
  });
});
