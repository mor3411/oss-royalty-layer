import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STALE_IN_PROGRESS_CLAIM_MS,
  clearInMemoryRunRoyaltyCycleExecutionClaims,
  runRoyaltyCycle,
  type ExecutePayoutsInput,
} from "../src/orchestrators/run-royalty-cycle.js";
import type {
  AllocationPersistenceStore,
  PersistedAllocationRecord,
  AllocationPersistenceAudit,
} from "../src/tools/persist-allocations.js";
import type {
  RoyaltyCycleAuditStore,
  RoyaltyCycleAuditRecord,
} from "../src/tools/royalty-cycle-audit.js";
import type { PayoutBatchApprovalRecord } from "../src/tools/payout-batch-approval.js";
import {
  clearInMemoryLibraryUsageIngestionEvents,
  createLibraryUsageIngestionPipeline,
} from "../src/tools/library-usage-ingestion.js";
import { createInMemoryLibraryRegistry } from "../src/tools/library-registry.js";
import {
  clearInMemoryMaintainerProfiles,
  clearInMemoryPayoutBatchApprovals,
  clearInMemoryPersistedAllocations,
  clearInMemoryRoyaltyCycleAudits,
  clearInMemoryRoyaltyObservabilitySamples,
  getInMemoryRoyaltyCycleAuditsByPeriod,
  getInMemoryRoyaltyObservabilitySamples,
  getInMemoryPersistedAllocations,
  recordPayoutBatchApproval,
  upsertInMemoryMaintainerProfile,
} from "../src/tools/testing.js";

const SESSION_IDS = {
  one: "a".repeat(64),
  two: "b".repeat(64),
} as const;

function createDurableStoreAdapters(): {
  allocationStore: AllocationPersistenceStore;
  auditStore: RoyaltyCycleAuditStore;
} {
  const allocationRecordsByPeriod = new Map<string, PersistedAllocationRecord>();
  const allocationAudits: AllocationPersistenceAudit[] = [];
  const auditRecordsByPeriod = new Map<string, RoyaltyCycleAuditRecord[]>();

  const allocationStore: AllocationPersistenceStore = {
    readByPeriod(period: string): PersistedAllocationRecord | null {
      return allocationRecordsByPeriod.get(period) ?? null;
    },
    appendRecord(record: PersistedAllocationRecord): void {
      if (allocationRecordsByPeriod.has(record.period)) {
        throw new Error(`allocation record for period ${record.period} already exists`);
      }
      allocationRecordsByPeriod.set(record.period, record);
    },
    appendAudit(audit: AllocationPersistenceAudit): void {
      allocationAudits.push(audit);
    },
  };

  const auditStore: RoyaltyCycleAuditStore = {
    readLatestByPeriod(period: string): RoyaltyCycleAuditRecord | null {
      const records = auditRecordsByPeriod.get(period) ?? [];
      return records.at(-1) ?? null;
    },
    appendRecord(
      record: RoyaltyCycleAuditRecord,
      expectedPreviousEventHash?: string | null
    ): void {
      const records = auditRecordsByPeriod.get(record.period) ?? [];
      const latestHash = records.at(-1)?.event_hash ?? null;
      if (
        expectedPreviousEventHash !== undefined &&
        latestHash !== expectedPreviousEventHash
      ) {
        const error = new Error("previous event hash mismatch") as Error & {
          code?: string;
        };
        error.code = "audit_previous_hash_mismatch";
        throw error;
      }
      records.push(record);
      auditRecordsByPeriod.set(record.period, records);
    },
    readByPeriod(period: string): RoyaltyCycleAuditRecord[] {
      return [...(auditRecordsByPeriod.get(period) ?? [])];
    },
  };

  return {
    allocationStore,
    auditStore,
  };
}

describe("runRoyaltyCycle", () => {
  beforeEach(() => {
    clearInMemoryRunRoyaltyCycleExecutionClaims();
    clearInMemoryLibraryUsageIngestionEvents();
    clearInMemoryPersistedAllocations();
    clearInMemoryMaintainerProfiles();
    clearInMemoryPayoutBatchApprovals();
    clearInMemoryRoyaltyCycleAudits();
    clearInMemoryRoyaltyObservabilitySamples();
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

    const audits = getInMemoryRoyaltyCycleAuditsByPeriod("2026-02");
    expect(audits.some((event) => event.event_type === "allocation_proposal_persisted")).toBe(
      true
    );
    expect(audits.some((event) => event.event_type === "payout_execution_executed")).toBe(true);

    const observabilitySamples = getInMemoryRoyaltyObservabilitySamples("2026-02");
    expect(observabilitySamples).toHaveLength(1);
    expect(observabilitySamples[0]?.payout.outcome).toBe("executed");
    expect(observabilitySamples[0]?.aggregation.library_count).toBe(2);
  });

  it("fails open when telemetry metric retrieval throws", async () => {
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: [],
    }));

    const output = await runRoyaltyCycle(
      {
        period: "2026-02",
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        pool_amount_minor: 600,
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
        approvePayoutBatch: () => ({ approved: true }),
        executePayouts,
        getTelemetryIngestionMetrics: () => {
          throw new Error("telemetry metrics backend unavailable");
        },
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);
    expect(
      output.notes.some((note) => note.includes("telemetry_metrics_error="))
    ).toBe(true);
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

  it("rejects payout execution for unauthorized principals in production", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();
    const { allocationStore, auditStore } = createDurableStoreAdapters();

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

    await expect(
      runRoyaltyCycle(
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
          approvePayoutBatch: () => ({ approved: true }),
          executePayouts,
          allocationStore,
          auditStore,
          executionClaimStore: {
            tryClaim: () => "acquired" as const,
            markExecuted: () => {},
            releaseClaim: () => {},
          },
          runtimeEnvironment: "production",
          allowTestAuthBypass: false,
          principal: {
            principal_id: "mgr-1",
            role: "manager",
          },
        }
      )
    ).rejects.toThrowError("not authorized");
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

  it("executes only after a stored approval decision is recorded", async () => {
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: [],
    }));

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      executePayouts,
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(firstRun.status).toBe("completed");
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(firstRun.execution).toEqual({
      status: "skipped",
      reason: "approval_required",
      executed_count: 0,
    });
    expect(executePayouts).not.toHaveBeenCalled();

    const approvalHashNote = firstRun.notes.find((note) =>
      note.startsWith("approval_hash=")
    );
    const approvalHash = approvalHashNote?.slice("approval_hash=".length);
    if (!approvalHash) {
      throw new Error("expected approval hash note");
    }

    const approval = await recordPayoutBatchApproval(
      {
        period: "2026-02",
        payout_batch_hash: approvalHash,
        decision: "approved",
        reason: "manual review passed",
      },
      {
        principal: {
          principal_id: "fin.reviewer",
          role: "manager",
        },
      }
    );
    expect(approval.status).toBe("recorded");

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(secondRun.status).toBe("completed");
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);
    const executeInput = executePayouts.mock.calls[0]?.[0];
    expect(executeInput?.idempotency_key).toBe(
      `execute_payouts:2026-02:${firstRun.persistence.record_id}`
    );
    expect(secondRun.notes).toContain("approval_decision=approved");
    expect(secondRun.notes).toContain("approval_reviewer=fin.reviewer");

    const thirdRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(thirdRun.status).toBe("completed");
    if (thirdRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(thirdRun.execution).toEqual({
      status: "skipped",
      reason: "already_executed",
      executed_count: 0,
    });
    expect(executePayouts).toHaveBeenCalledTimes(1);

    const audits = getInMemoryRoyaltyCycleAuditsByPeriod("2026-02");
    expect(
      audits.some(
        (event) =>
          event.event_type === "payout_execution_skipped" &&
          event.payload.reason === "already_executed"
      )
    ).toBe(true);
  });

  it("skips execution when custom approval resolver returns mismatched period/hash", async () => {
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
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
        resolvePayoutBatchApproval: ({ payoutBatchHash }) => ({
          approval_event_id: "apr_mismatch",
          period: "2026-03",
          payout_batch_hash: payoutBatchHash,
          decision: "approved",
          reviewer_id: "fin.reviewer",
          reason: "approved",
          adjustments: [],
          reviewed_at: "2026-02-20T00:00:00.000Z",
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
      reason: "stored_approval_context_mismatch",
      executed_count: 0,
    });
    expect(executePayouts).not.toHaveBeenCalled();
  });

  it("skips execution when custom approval resolver returns malformed approval data", async () => {
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
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
        resolvePayoutBatchApproval: ({ period, payoutBatchHash }) =>
          ({
            approval_event_id: "apr_invalid",
            period,
            payout_batch_hash: payoutBatchHash,
            decision: "adjusted",
            reviewer_id: "fin.reviewer",
            reason: "approved",
            adjustments: [{ maintainer_id: "mnt.alpha", amount_minor: 0 }],
            reviewed_at: "2026-02-20T00:00:00.000Z",
          }) as unknown as PayoutBatchApprovalRecord,
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution).toEqual({
      status: "skipped",
      reason: "invalid_stored_approval_record",
      executed_count: 0,
    });
    expect(executePayouts).not.toHaveBeenCalled();
  });

  it("executes payout when custom approval resolver returns matching approved decision", async () => {
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
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
        resolvePayoutBatchApproval: ({ period, payoutBatchHash }) => ({
          approval_event_id: "apr_valid",
          period,
          payout_batch_hash: payoutBatchHash,
          decision: "approved",
          reviewer_id: "fin.reviewer",
          reason: "approved",
          adjustments: [],
          reviewed_at: "2026-02-20T00:00:00.000Z",
        }),
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);
    expect(output.notes).toContain("approval_decision=approved");
    expect(output.notes).toContain("approval_reviewer=fin.reviewer");
  });

  it("does not re-execute when payout destination changes for the same persisted allocation record", async () => {
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
        account_id: "acct_alpha_v1",
      },
    });

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: input.payouts,
    }));

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      approvePayoutBatch: () => ({ approved: true }),
      executePayouts,
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(firstRun.status).toBe("completed");
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(firstRun.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);

    // Simulate restart where in-memory claim state is lost.
    clearInMemoryRunRoyaltyCycleExecutionClaims();

    upsertInMemoryMaintainerProfile({
      id: "mnt.alpha",
      verification_status: "verified",
      payout_account: {
        provider: "stripe",
        account_id: "acct_alpha_v2",
      },
    });

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(secondRun.status).toBe("completed");
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution).toEqual({
      status: "skipped",
      reason: "already_executed",
      executed_count: 0,
    });
    expect(executePayouts).toHaveBeenCalledTimes(1);
  });

  it("fails closed when allocation persistence reports a duplicate conflict", async () => {
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
      results: [],
    }));
    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 800,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) => {
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
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(firstRun.status).toBe("completed");
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(firstRun.execution.status).toBe("executed");

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T11:00:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 2,
      },
    });

    await expect(runRoyaltyCycle(cycleInput, cycleOptions)).rejects.toThrowError(
      "allocation persistence conflict detected"
    );
    expect(executePayouts).toHaveBeenCalledTimes(1);

    const audits = getInMemoryRoyaltyCycleAuditsByPeriod("2026-02");
    expect(
      audits.some(
        (event) =>
          event.event_type === "payout_execution_skipped" &&
          event.payload.reason === "allocation_conflict_requires_review"
      )
    ).toBe(true);
  });

  it("retains execution claim after ambiguous payout adapter failures", async () => {
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

    const executePayouts = vi
      .fn()
      .mockRejectedValueOnce(new Error("psp timeout"))
      .mockResolvedValueOnce({
        executed_count: 1,
        results: [],
      });

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      approvePayoutBatch: () => ({ approved: true }),
      executePayouts,
    };

    await expect(runRoyaltyCycle(cycleInput, cycleOptions)).rejects.toThrowError("psp timeout");

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(secondRun.status).toBe("completed");
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution).toEqual({
      status: "skipped",
      reason: "payout_execution_in_progress",
      executed_count: 0,
    });
    expect(executePayouts).toHaveBeenCalledTimes(1);
  });

  it("releases execution claim when adapter reports pre-execution failure", async () => {
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

    const preExecutionError = Object.assign(
      new Error("provider rejected request before execution"),
      { execution_state: "not_executed" as const }
    );
    const executePayouts = vi
      .fn()
      .mockRejectedValueOnce(preExecutionError)
      .mockResolvedValueOnce({
        executed_count: 1,
        results: [],
      });

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      approvePayoutBatch: () => ({ approved: true }),
      executePayouts,
    };

    await expect(runRoyaltyCycle(cycleInput, cycleOptions)).rejects.toThrowError(
      "provider rejected request before execution"
    );

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(secondRun.status).toBe("completed");
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(2);
  });

  it("recovers stale in-progress payout execution claims after cooldown", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();
    let nowMs = 0;

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

    const executePayouts = vi
      .fn()
      .mockRejectedValueOnce(new Error("psp timeout"))
      .mockResolvedValueOnce({
        executed_count: 1,
        results: [],
      });

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      approvePayoutBatch: () => ({ approved: true }),
      executePayouts,
      now: () => nowMs,
    };

    await expect(runRoyaltyCycle(cycleInput, cycleOptions)).rejects.toThrowError("psp timeout");

    nowMs = 1_000;
    const blockedRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(blockedRun.status).toBe("completed");
    if (blockedRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(blockedRun.execution).toEqual({
      status: "skipped",
      reason: "payout_execution_in_progress",
      executed_count: 0,
    });

    nowMs = DEFAULT_STALE_IN_PROGRESS_CLAIM_MS + 2_000;
    const recoveredRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(recoveredRun.status).toBe("completed");
    if (recoveredRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(recoveredRun.execution.status).toBe("executed");
    expect(
      recoveredRun.notes.includes("stale_execution_claim_released=true")
    ).toBe(true);
    expect(executePayouts).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent execution for the same approved payout batch", async () => {
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

    const executePayouts = vi.fn(async (input: ExecutePayoutsInput) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        executed_count: input.payouts.length,
        results: [],
      };
    });

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 500,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      executePayouts,
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(firstRun.status).toBe("completed");
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(firstRun.execution.status).toBe("skipped");

    const approvalHashNote = firstRun.notes.find((note) =>
      note.startsWith("approval_hash=")
    );
    const approvalHash = approvalHashNote?.slice("approval_hash=".length);
    if (!approvalHash) {
      throw new Error("expected approval hash note");
    }

    await recordPayoutBatchApproval(
      {
        period: "2026-02",
        payout_batch_hash: approvalHash,
        decision: "approved",
        reason: "manual review passed",
      },
      {
        principal: {
          principal_id: "fin.reviewer",
          role: "manager",
        },
      }
    );

    const [concurrentA, concurrentB] = await Promise.all([
      runRoyaltyCycle(cycleInput, cycleOptions),
      runRoyaltyCycle(cycleInput, cycleOptions),
    ]);
    const concurrentRuns = [concurrentA, concurrentB];

    const executedRuns = concurrentRuns.filter(
      (run) => run.status === "completed" && run.execution.status === "executed"
    );
    const skippedRuns = concurrentRuns.filter(
      (run) => run.status === "completed" && run.execution.status === "skipped"
    );

    expect(executedRuns).toHaveLength(1);
    expect(skippedRuns).toHaveLength(1);
    const skippedRun = skippedRuns[0];
    if (!skippedRun || skippedRun.status !== "completed" || skippedRun.execution.status !== "skipped") {
      throw new Error("expected one skipped run");
    }
    expect(["already_executed", "payout_execution_in_progress"]).toContain(
      skippedRun.execution.reason
    );
    expect(executePayouts).toHaveBeenCalledTimes(1);
  });

  it("applies stored adjusted approval payouts before execution", async () => {
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
        calls: 8,
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: input.payouts,
    }));

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 800,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) =>
        libraryId === alphaLibraryId ? "mnt.alpha" : "mnt.unknown",
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      executePayouts,
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(firstRun.status).toBe("completed");
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    if (firstRun.payout_batch.payouts.length !== 1) {
      throw new Error("expected one payout in first run");
    }
    const originalAmount = firstRun.payout_batch.payouts[0]?.amount_minor ?? 0;
    const adjustedAmount = Math.floor(originalAmount / 2);

    const approvalHashNote = firstRun.notes.find((note) =>
      note.startsWith("approval_hash=")
    );
    const approvalHash = approvalHashNote?.slice("approval_hash=".length);
    if (!approvalHash) {
      throw new Error("expected approval hash note");
    }

    await recordPayoutBatchApproval(
      {
        period: "2026-02",
        payout_batch_hash: approvalHash,
        decision: "adjusted",
        reason: "limit payout for manual holdback",
        adjustments: [
          {
            maintainer_id: "mnt.alpha",
            amount_minor: adjustedAmount,
          },
        ],
      },
      {
        principal: {
          principal_id: "fin.adjuster",
          role: "manager",
        },
      }
    );

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    expect(secondRun.status).toBe("completed");
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);

    const executeInput = executePayouts.mock.calls[0]?.[0];
    expect(executeInput?.payouts[0]?.amount_minor).toBe(adjustedAmount);
    expect(secondRun.notes).toContain("approval_decision=adjusted");
  });

  it("keeps unadjusted payouts when stored adjustments target a subset", async () => {
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
        calls: 8,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "cli",
      ts: "2026-02-19T10:00:00.000Z",
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
      results: input.payouts,
    }));

    const cycleInput = {
      period: "2026-02",
      period_start: "2026-02-19T00:00:00.000Z",
      period_end: "2026-02-20T00:00:00.000Z",
      pool_amount_minor: 1_000,
    };
    const cycleOptions = {
      eventStore: {
        readAll: pipeline.readIngestedEvents,
        append: () => {
          throw new Error("not used");
        },
      },
      resolveLibraryId: (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id,
      resolveMaintainerId: (libraryId: string) => {
        if (libraryId === alphaLibraryId) {
          return "mnt.alpha";
        }
        if (libraryId === betaLibraryId) {
          return "mnt.beta";
        }
        return "mnt.unknown";
      },
      detectPayoutAnomalies: () => ({ has_anomaly: false }),
      executePayouts,
    };

    const firstRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    if (firstRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(firstRun.payout_batch.payouts).toHaveLength(2);
    const originalAmountsByMaintainer = new Map(
      firstRun.payout_batch.payouts.map((payout) => [
        payout.maintainer_id,
        payout.amount_minor,
      ])
    );

    const alphaOriginal = originalAmountsByMaintainer.get("mnt.alpha");
    const betaOriginal = originalAmountsByMaintainer.get("mnt.beta");
    if (alphaOriginal === undefined || betaOriginal === undefined) {
      throw new Error("expected alpha and beta payouts");
    }
    const alphaAdjusted = Math.max(1, alphaOriginal - 100);

    const approvalHashNote = firstRun.notes.find((note) =>
      note.startsWith("approval_hash=")
    );
    const approvalHash = approvalHashNote?.slice("approval_hash=".length);
    if (!approvalHash) {
      throw new Error("expected approval hash note");
    }

    await recordPayoutBatchApproval(
      {
        period: "2026-02",
        payout_batch_hash: approvalHash,
        decision: "adjusted",
        reason: "reduce alpha payout",
        adjustments: [
          {
            maintainer_id: "mnt.alpha",
            amount_minor: alphaAdjusted,
          },
        ],
      },
      {
        principal: {
          principal_id: "fin.adjuster",
          role: "manager",
        },
      }
    );

    const secondRun = await runRoyaltyCycle(cycleInput, cycleOptions);
    if (secondRun.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(secondRun.execution.status).toBe("executed");
    expect(executePayouts).toHaveBeenCalledTimes(1);

    const executeInput = executePayouts.mock.calls[0]?.[0];
    const executedAmountsByMaintainer = new Map(
      executeInput?.payouts.map((payout) => [payout.maintainer_id, payout.amount_minor])
    );
    expect(executeInput?.payouts).toHaveLength(2);
    expect(executedAmountsByMaintainer.get("mnt.alpha")).toBe(alphaAdjusted);
    expect(executedAmountsByMaintainer.get("mnt.beta")).toBe(betaOriginal);
  });

  it("refuses payout execution with default in-memory claim store in production", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();
    const { allocationStore, auditStore } = createDurableStoreAdapters();

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

    await expect(
      runRoyaltyCycle(
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
          approvePayoutBatch: () => ({ approved: true }),
          executePayouts: (input) => ({
            executed_count: input.payouts.length,
            results: [],
          }),
          allocationStore,
          auditStore,
          runtimeEnvironment: "production",
          principal: {
            principal_id: "svc-1",
            role: "service",
          },
        }
      )
    ).rejects.toThrowError("durable executionClaimStore");
    expect(getInMemoryPersistedAllocations()).toHaveLength(0);
  });

  it("requires durable allocation and audit stores for production payout execution", async () => {
    await expect(
      runRoyaltyCycle(
        {
          period: "2026-02",
          period_start: "2026-02-19T00:00:00.000Z",
          period_end: "2026-02-20T00:00:00.000Z",
          pool_amount_minor: 500,
        },
        {
          executePayouts: (input) => ({
            executed_count: input.payouts.length,
            results: [],
          }),
          executionClaimStore: {
            tryClaim: () => "acquired" as const,
            markExecuted: () => {},
            releaseClaim: () => {},
          },
          runtimeEnvironment: "production",
          principal: {
            principal_id: "svc-1",
            role: "service",
          },
        }
      )
    ).rejects.toThrowError("durable allocationStore, auditStore");
  });

  it("skips execution when callback adjustments alter payout destination data", async () => {
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
        calls: 8,
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

    const executePayouts = vi.fn((input: ExecutePayoutsInput) => ({
      executed_count: input.payouts.length,
      results: input.payouts,
    }));

    const output = await runRoyaltyCycle(
      {
        period: "2026-02",
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        pool_amount_minor: 800,
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
        approvePayoutBatch: ({ payoutBatch }) => ({
          approved: true,
          adjusted_payouts: payoutBatch.payouts.map((payout) => ({
            ...payout,
            amount_minor: Math.max(1, payout.amount_minor - 1),
            payout_account: {
              ...payout.payout_account,
              account_id: "acct_hijacked",
            },
          })),
        }),
        executePayouts,
      }
    );

    expect(output.status).toBe("completed");
    if (output.status !== "completed") {
      throw new Error("expected completed cycle output");
    }
    expect(output.execution.status).toBe("skipped");
    if (output.execution.status !== "skipped") {
      throw new Error("expected skipped execution due to invalid callback adjustments");
    }
    expect(output.execution.reason).toContain("cannot override payout account");
    expect(executePayouts).not.toHaveBeenCalled();
  });
});
