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
    }, {
      principal: {
        principal_id: "fin.reviewer",
        role: "manager",
      },
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
      }, {
        principal: {
          principal_id: "fin.reviewer",
          role: "manager",
        },
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

  it("rejects a second approval for the same period and batch hash as immutable", async () => {
    clearInMemoryPayoutBatchApprovals();

    const hash = "c".repeat(64);
    await recordPayoutBatchApproval({
      period: "2026-03",
      payout_batch_hash: hash,
      decision: "approved",
      reviewer_id: "fin.reviewer",
      reason: "first approval",
    }, {
      principal: {
        principal_id: "fin.reviewer",
        role: "manager",
      },
    });

    await expect(
      recordPayoutBatchApproval({
        period: "2026-03",
        payout_batch_hash: hash,
        decision: "denied",
        reviewer_id: "fin.reviewer",
        reason: "attempt to overwrite",
      }, {
        principal: {
          principal_id: "fin.reviewer",
          role: "manager",
        },
      })
    ).rejects.toThrowError("approvals are immutable");
  });

  it("binds reviewer_id to authenticated principal when a real principal is provided", async () => {
    clearInMemoryPayoutBatchApprovals();

    const hash = "d".repeat(64);
    await recordPayoutBatchApproval(
      {
        period: "2026-03",
        payout_batch_hash: hash,
        decision: "approved",
        reviewer_id: "caller-supplied-id",
        reason: "approved by principal",
      },
      {
        principal: {
          principal_id: "mgr-finance-1",
          role: "manager",
        },
      }
    );

    const stored = getInMemoryPayoutBatchApproval("2026-03", hash);
    expect(stored).not.toBeNull();
    expect(stored?.reviewer_id).toBe("mgr-finance-1");
  });

  it("rejects approvals from reserved synthetic principals", async () => {
    clearInMemoryPayoutBatchApprovals();

    await expect(
      recordPayoutBatchApproval(
        {
          period: "2026-02",
          payout_batch_hash: "e".repeat(64),
          decision: "approved",
          reviewer_id: "fin.reviewer",
          reason: "manual review accepted",
        },
        {
          runtimeEnvironment: "test",
          allowTestAuthBypass: true,
        }
      )
    ).rejects.toThrowError("reserved principals cannot record payout batch approvals");
  });
});
