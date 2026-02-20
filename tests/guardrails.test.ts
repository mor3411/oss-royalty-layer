import { describe, expect, it } from "vitest";

import {
  assertToolInputVetting,
  assertToolOutputSanity,
  assertToolRiskAllowed,
  getToolRiskLevel,
} from "../src/tools/guardrails.js";

describe("tool guardrails", () => {
  it("exposes risk classification per tool", () => {
    expect(getToolRiskLevel("log_library_usage")).toBe("low");
    expect(getToolRiskLevel("aggregate_usage_for_period")).toBe("medium");
    expect(getToolRiskLevel("append_royalty_cycle_audit")).toBe("medium");
    expect(getToolRiskLevel("record_royalty_observability")).toBe("medium");
    expect(getToolRiskLevel("get_royalty_observability_dashboard")).toBe("medium");
    expect(getToolRiskLevel("record_payout_batch_approval")).toBe("high");
    expect(getToolRiskLevel("execute_payouts")).toBe("high");
  });

  it("blocks tool execution when risk allowance is too low", () => {
    expect(() =>
      assertToolRiskAllowed({
        toolName: "execute_payouts",
        maxAllowedRisk: "medium",
      })
    ).toThrowError("requires high risk allowance");
  });

  it("rejects oversized tool payloads during input vetting", () => {
    expect(() =>
      assertToolInputVetting("log_library_usage", { data: "x".repeat(1024) }, { maxBytes: 16 })
    ).toThrowError("input payload");
  });

  it("rejects overly long aggregation periods during input vetting", () => {
    expect(() =>
      assertToolInputVetting(
        "aggregate_usage_for_period",
        {
          period_start: "2026-01-01T00:00:00.000Z",
          period_end: "2026-02-15T00:00:00.000Z",
        },
        { maxAggregationPeriodDays: 31 }
      )
    ).toThrowError("aggregation period exceeds 31 days");
  });

  it("rejects aggregate output with duplicate library IDs", () => {
    expect(() =>
      assertToolOutputSanity("aggregate_usage_for_period", {
        aggregates: [
          { library_id: "lib_1", total_calls: 2, unique_sessions: 1 },
          { library_id: "lib_1", total_calls: 3, unique_sessions: 1 },
        ],
      })
    ).toThrowError("duplicate library_id found");
  });

  it("rejects invalid allocation output state transitions", () => {
    expect(() =>
      assertToolOutputSanity("validate_allocation_constraints", {
        status: "valid",
        total_allocated_minor: 100,
        expected_pool_minor: 100,
        violations: [{ code: "pool_sum_mismatch", message: "mismatch" }],
      })
    ).toThrowError("valid allocation constraint output cannot include violations");
  });

  it("rejects invalid persist allocation output payloads", () => {
    expect(() =>
      assertToolOutputSanity("persist_allocations", {
        status: "already_exists",
        period: "2026-02",
        record_id: "alr_1",
        persisted_at: "2026-02-19T23:30:00.000Z",
        saved_count: 4,
        duplicate_conflict: false,
        audit_event_id: "ala_1",
      })
    ).toThrowError();
  });

  it("rejects inconsistent create payout batch totals", () => {
    expect(() =>
      assertToolOutputSanity("create_payout_batch", {
        period: "2026-02",
        currency: "USD",
        payouts: [],
        flagged: [],
        totals: {
          total_amount_minor: 100,
          eligible_amount_minor: 40,
          flagged_amount_minor: 30,
        },
        notes: "invalid totals",
      })
    ).toThrowError("totals are inconsistent");
  });
});
