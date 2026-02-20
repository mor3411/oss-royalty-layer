import { describe, expect, it } from "vitest";

import {
  appendRoyaltyCycleAuditEvent,
  clearInMemoryRoyaltyCycleAudits,
  getInMemoryRoyaltyCycleAuditsByPeriod,
  verifyRoyaltyCycleAuditTrail,
} from "../src/tools/royalty-cycle-audit.js";

describe("royalty cycle audit trail", () => {
  it("records append-only audit events that are queryable by period", async () => {
    clearInMemoryRoyaltyCycleAudits();

    await appendRoyaltyCycleAuditEvent({
      period: "2026-02",
      run_id: "rrn_1",
      event_type: "allocation_proposal_persisted",
      payload: {
        record_id: "alr_1",
      },
    });
    await appendRoyaltyCycleAuditEvent({
      period: "2026-02",
      run_id: "rrn_1",
      event_type: "payout_execution_skipped",
      payload: {
        reason: "approval_required",
      },
    });

    const periodEvents = getInMemoryRoyaltyCycleAuditsByPeriod("2026-02");
    expect(periodEvents).toHaveLength(2);
    expect(periodEvents[0]?.event_type).toBe("allocation_proposal_persisted");
    expect(periodEvents[1]?.event_type).toBe("payout_execution_skipped");
  });

  it("builds a tamper-evident hash chain per period", async () => {
    clearInMemoryRoyaltyCycleAudits();

    await appendRoyaltyCycleAuditEvent({
      period: "2026-02",
      run_id: "rrn_2",
      event_type: "allocation_proposal_persisted",
      payload: {
        record_id: "alr_2",
      },
    });
    await appendRoyaltyCycleAuditEvent({
      period: "2026-02",
      run_id: "rrn_2",
      event_type: "payout_execution_executed",
      payload: {
        executed_count: 1,
      },
    });

    const verification = verifyRoyaltyCycleAuditTrail("2026-02");
    expect(verification).toEqual({
      status: "valid",
      period: "2026-02",
      checked_events: 2,
    });
  });

  it("requires authorization outside test bypass", async () => {
    clearInMemoryRoyaltyCycleAudits();
    await expect(
      appendRoyaltyCycleAuditEvent(
        {
          period: "2026-02",
          run_id: "rrn_3",
          event_type: "payout_execution_skipped",
          payload: { reason: "no_eligible_payouts" },
        },
        {
          runtimeEnvironment: "production",
        }
      )
    ).rejects.toThrowError("authorization required");
  });
});
