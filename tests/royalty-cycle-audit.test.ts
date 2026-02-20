import { describe, expect, it } from "vitest";

import {
  MAX_IN_MEMORY_ROYALTY_CYCLE_AUDIT_EVENTS_PER_PERIOD,
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

  it("retries append when previous hash changed concurrently", async () => {
    clearInMemoryRoyaltyCycleAudits();
    const records: Array<{ event_hash: string }> = [];
    let injected = false;
    let latestHash: string | null = null;

    await appendRoyaltyCycleAuditEvent(
      {
        period: "2026-02",
        run_id: "rrn_race",
        event_type: "payout_execution_skipped",
        payload: { reason: "approval_required" },
      },
      {
        store: {
          readLatestByPeriod: () =>
            latestHash
              ? ({
                  event_id: "latest",
                  period: "2026-02",
                  run_id: "rrn_race",
                  event_type: "payout_execution_skipped",
                  payload: {},
                  payload_hash: "a".repeat(64),
                  previous_event_hash: null,
                  event_hash: latestHash,
                  observed_at: "2026-02-20T00:00:00.000Z",
                } as const)
              : null,
          appendRecord: (record, expectedPreviousEventHash) => {
            if (!injected) {
              injected = true;
              latestHash = "f".repeat(64);
              const error = new Error("previous event hash mismatch");
              (error as Error & { code?: string }).code =
                "audit_previous_hash_mismatch";
              throw error;
            }
            if (expectedPreviousEventHash !== latestHash) {
              throw new Error("unexpected expectedPreviousEventHash in retry");
            }
            latestHash = record.event_hash;
            records.push({ event_hash: record.event_hash });
          },
          readByPeriod: () => [],
        },
      }
    );

    expect(records).toHaveLength(1);
  });

  it("caps in-memory events per period without breaking chain verification", async () => {
    clearInMemoryRoyaltyCycleAudits();

    for (
      let index = 0;
      index < MAX_IN_MEMORY_ROYALTY_CYCLE_AUDIT_EVENTS_PER_PERIOD + 2;
      index += 1
    ) {
      await appendRoyaltyCycleAuditEvent({
        period: "2026-02",
        run_id: `rrn_cap_${index}`,
        event_type: "payout_execution_skipped",
        payload: { index },
      });
    }

    const periodEvents = getInMemoryRoyaltyCycleAuditsByPeriod("2026-02");
    expect(periodEvents).toHaveLength(MAX_IN_MEMORY_ROYALTY_CYCLE_AUDIT_EVENTS_PER_PERIOD);
    const verification = verifyRoyaltyCycleAuditTrail("2026-02");
    expect(verification.status).toBe("valid");
  });
});
