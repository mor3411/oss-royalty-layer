import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runRoyaltyCycle,
  type ExecutePayoutsInput,
} from "../src/orchestrators/run-royalty-cycle.js";
import {
  clearInMemoryLibraryUsageIngestionEvents,
  createLibraryUsageIngestionPipeline,
} from "../src/tools/library-usage-ingestion.js";
import { createInMemoryLibraryRegistry } from "../src/tools/library-registry.js";
import {
  clearInMemoryMaintainerProfiles,
  clearInMemoryPersistedAllocations,
  getInMemoryPersistedAllocations,
  upsertInMemoryMaintainerProfile,
} from "../src/tools/testing.js";

const SESSION_IDS = {
  one: "a".repeat(64),
  two: "b".repeat(64),
} as const;

describe("runRoyaltyCycle", () => {
  beforeEach(() => {
    clearInMemoryLibraryUsageIngestionEvents();
    clearInMemoryPersistedAllocations();
    clearInMemoryMaintainerProfiles();
  });

  it("runs aggregate -> allocate -> persist -> payout -> execute", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "cli",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 4,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T11:00:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 3,
      },
    });

    const alphaLibraryId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "alpha",
    }).library_id;
    const betaLibraryId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "beta",
    }).library_id;

    upsertInMemoryMaintainerProfile({
      id: "mnt.alpha",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_alpha",
      },
    });
    upsertInMemoryMaintainerProfile({
      id: "mnt.beta",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_beta",
      },
    });

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: input.payouts.map((payout) => ({
        maintainer_id: payout.maintainer_id,
        status: "success",
      })),
    }));

    const output = await runRoyaltyCycle(
      {
        period: "2026-02",
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        pool_amount_minor: 1_000,
        page_size: 1,
      },
      {
        eventStore: {
          readAll: pipeline.readIngestedEvents,
          append: () => {
            throw new Error("not used");
          },
        },
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        resolveMaintainerId: (libraryId) => {
          if (libraryId === alphaLibraryId) {
            return "mnt.alpha";
          }
          if (libraryId === betaLibraryId) {
            return "mnt.beta";
          }
          return "mnt.unknown";
        },
        detectPayoutAnomalies: () => ({ has_anomaly: false }),
        approvePayoutBatch: () => ({ approved: true }),
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.aggregation.pages_fetched).toBe(2);
    expect(output.aggregation.library_count).toBe(2);
    expect(output.persistence.status).toBe("ok");
    expect(output.payout_batch.payouts).toHaveLength(2);
    expect(output.execution.status).toBe("executed");
    expect(output.execution.executed_count).toBe(2);
    expect(executePayouts).toHaveBeenCalledTimes(1);

    const persisted = getInMemoryPersistedAllocations();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.period).toBe("2026-02");
  });

  it("skips execute stage when approval is denied", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "cli",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 5,
      },
    });

    const alphaLibraryId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "alpha",
    }).library_id;

    upsertInMemoryMaintainerProfile({
      id: "mnt.alpha",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_alpha",
      },
    });

    const executePayouts = vi.fn(() => ({
      executed_count: 1,
      results: [],
    }));

    const output = await runRoyaltyCycle(
      {
        period: "2026-02",
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        pool_amount_minor: 500,
      },
      {
        eventStore: {
          readAll: pipeline.readIngestedEvents,
          append: () => {
            throw new Error("not used");
          },
        },
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        resolveMaintainerId: (libraryId) =>
          libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
        detectPayoutAnomalies: () => ({ has_anomaly: false }),
        approvePayoutBatch: () => ({
          approved: false,
          reason: "manual_review_required",
        }),
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution).toEqual({
      status: "skipped",
      reason: "manual_review_required",
      executed_count: 0,
    });
    expect(executePayouts).not.toHaveBeenCalled();
  });

  it("returns no_usage when period has no usage events", async () => {
    const output = await runRoyaltyCycle({
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    });

    expect(output.status).toBe("no_usage");
    if (output.status !== "no_usage") {
      throw new Error("expected no_usage cycle output");
    }
    expect(output.aggregation.library_count).toBe(0);
    expect(output.notes).toContain("no usage aggregates found for requested period");
  });

  it("blocks execution when default anomaly tripwires are triggered", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "cli",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 10,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T11:00:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 8,
      },
    });

    const alphaLibraryId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "alpha",
    }).library_id;
    const betaLibraryId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "beta",
    }).library_id;

    upsertInMemoryMaintainerProfile({
      id: "mnt.single",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_single",
      },
    });

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: [],
    }));

    const output = await runRoyaltyCycle(
      {
        period: "2026-02",
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        pool_amount_minor: 1_000,
      },
      {
        eventStore: {
          readAll: pipeline.readIngestedEvents,
          append: () => {
            throw new Error("not used");
          },
        },
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        resolveMaintainerId: (libraryId) =>
          libraryId === alphaLibraryId || libraryId === betaLibraryId
            ? "mnt.single"
            : "mnt.unknown",
        approvePayoutBatch: () => ({ approved: true }),
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution.status).toBe("skipped");
    if (output.execution.status !== "skipped") {
      throw new Error("expected skipped execution due to anomaly");
    }
    expect(output.execution.reason).toContain("top recipient share");
    expect(output.notes.some((note) => note.includes("concentration_spike"))).toBe(true);
    expect(executePayouts).not.toHaveBeenCalled();
  });
});
