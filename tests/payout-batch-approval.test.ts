import { describe, expect, it } from "vitest";

import {
  clearInMemoryPayoutBatchApprovals,
  computePayoutBatchHash,
  getInMemoryPayoutBatchApproval,
  recordPayoutBatchApproval,
} from "../src/tools/payout-batch-approval.js";

describe("payout batch approval tool", () => {
  it("records and retrieves approved decisions by period and batch hash", async () => {
    clearInMemoryPayoutBatchApprovals();

    const payoutBatchHash = computePayoutBatchHash({
      period: "2026-02",
      currency: "USD",
      payouts: [
        {
          maintainer_id: "mnt.alpha",
          amount_minor: 600,
          currency: "USD",
          payout_account: { provider: "stripe", account_id: "acct_alpha" },
          allocation_count: 2,
        },
      ],
      flagged: [],
      totals: {
        total_amount_minor: 600,
        eligible_amount_minor: 600,
        flagged_amount_minor: 0,
      },
    });

    const result = await recordPayoutBatchApproval({
      period: "2026-02",
      payout_batch_hash: payoutBatchHash,
      decision: "approved",
      reviewer_id: "fin.reviewer",
      reason: "manual review accepted",
    });
    expect(result.status).toBe("recorded");

    const stored = getInMemoryPayoutBatchApproval("2026-02", payoutBatchHash);
    expect(stored).not.toBeNull();
    expect(stored?.decision).toBe("approved");
    expect(stored?.reviewer_id).toBe("fin.reviewer");
  });

  it("rejects adjusted decisions without adjustments", async () => {
    clearInMemoryPayoutBatchApprovals();
    await expect(
      recordPayoutBatchApproval({
        period: "2026-02",
        payout_batch_hash: "a".repeat(64),
        decision: "adjusted",
        reviewer_id: "fin.reviewer",
        reason: "adjusting payout",
      })
    ).rejects.toThrowError("requires at least one payout adjustment");
  });

  it("requires authorization outside test bypass", async () => {
    clearInMemoryPayoutBatchApprovals();
    await expect(
      recordPayoutBatchApproval(
        {
          period: "2026-02",
          payout_batch_hash: "b".repeat(64),
          decision: "denied",
          reviewer_id: "fin.reviewer",
          reason: "denied by policy",
        },
        {
          runtimeEnvironment: "production",
        }
      )
    ).rejects.toThrowError("authorization required");
  });
});
