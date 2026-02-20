import { describe, expect, it } from "vitest";

import {
  clearInMemoryRoyaltyObservabilitySamples,
  getRoyaltyObservabilityDashboard,
  recordRoyaltyObservabilitySample,
} from "../src/tools/royalty-observability.js";

describe("royalty observability", () => {
  it("records run observability samples and builds a dashboard snapshot", async () => {
    clearInMemoryRoyaltyObservabilitySamples();

    await recordRoyaltyObservabilitySample({
      period: "2026-02",
      run_id: "rrn_1",
      telemetry: {
        events_received: 100,
        events_persisted: 98,
        events_failed: 2,
        last_ingested_at: "2026-02-20T10:00:00.000Z",
        ingestion_lag_ms: 3_000,
      },
      aggregation: {
        pages_fetched: 2,
        library_count: 5,
        aggregation_lag_ms: 5_000,
      },
      anomaly: {
        detected: false,
        codes: [],
      },
      payout: {
        outcome: "executed",
        candidate_payout_count: 4,
        executed_count: 4,
      },
    });

    const dashboard = await getRoyaltyObservabilityDashboard({
      period: "2026-02",
    });
    expect(dashboard.totals).toEqual({
      runs: 1,
      executed_runs: 1,
      skipped_runs: 0,
      anomaly_hits: 0,
      telemetry_events_received: 100,
      telemetry_events_failed: 2,
    });
    expect(dashboard.rates.ingestion_failure_rate).toBe(0.02);
    expect(dashboard.alerts).toHaveLength(0);
  });

  it("emits alerts when failure and lag thresholds are exceeded", async () => {
    clearInMemoryRoyaltyObservabilitySamples();

    await recordRoyaltyObservabilitySample({
      period: "2026-02",
      run_id: "rrn_2",
      telemetry: {
        events_received: 100,
        events_persisted: 90,
        events_failed: 10,
      },
      aggregation: {
        pages_fetched: 1,
        library_count: 2,
        aggregation_lag_ms: 600_000,
      },
      anomaly: {
        detected: true,
        codes: ["concentration_spike"],
      },
      payout: {
        outcome: "skipped",
        candidate_payout_count: 2,
        executed_count: 0,
        skip_reason: "payout_anomaly_detected",
      },
    });

    const dashboard = await getRoyaltyObservabilityDashboard({
      period: "2026-02",
      thresholds: {
        max_ingestion_failure_rate: 0.05,
        max_aggregation_lag_ms: 300_000,
        max_anomaly_hit_rate: 0.1,
        max_payout_skip_rate: 0.1,
      },
    });

    const alertCodes = dashboard.alerts.map((alert) => alert.code).sort();
    expect(alertCodes).toEqual([
      "aggregation_lag_exceeded",
      "anomaly_hit_rate_exceeded",
      "payout_skip_rate_exceeded",
      "telemetry_ingestion_failure_rate_exceeded",
    ]);
  });

  it("requires authorization outside test bypass", async () => {
    clearInMemoryRoyaltyObservabilitySamples();

    await expect(
      recordRoyaltyObservabilitySample(
        {
          period: "2026-02",
          run_id: "rrn_3",
          aggregation: {
            pages_fetched: 0,
            library_count: 0,
            aggregation_lag_ms: 0,
          },
          anomaly: {
            detected: false,
            codes: [],
          },
          payout: {
            outcome: "skipped",
            candidate_payout_count: 0,
            executed_count: 0,
            skip_reason: "no_usage",
          },
        },
        {
          runtimeEnvironment: "production",
        }
      )
    ).rejects.toThrowError("authorization required");
  });
});
