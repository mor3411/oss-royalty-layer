import { beforeEach, describe, expect, it } from "vitest";

import {
  persistAllocations,
  type AllocationPersistenceStore,
  type PersistedAllocationRecord,
} from "../src/tools/persist-allocations.js";
import {
  clearInMemoryPersistedAllocations,
  getInMemoryAllocationPersistenceAudits,
  getInMemoryPersistedAllocations,
} from "../src/tools/testing.js";

const BASE_INPUT = {
  period: "2026-02",
  pool_amount_minor: 1_000,
  policy_applied: {
    configured_max_share_per_library: 0.5,
    effective_max_share_per_library: 0.5,
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
      confidence_score: 0.8,
      flags: [],
    },
  ],
  notes: "allocation proposal for period 2026-02",
} as const;

describe("persistAllocations", () => {
  beforeEach(() => {
    clearInMemoryPersistedAllocations();
  });

  it("persists allocations once and ignores duplicate writes for the same period", async () => {
    const first = await persistAllocations(BASE_INPUT, {
      now: () => Date.parse("2026-02-19T23:40:00.000Z"),
    });

    expect(first.status).toBe("ok");
    expect(first.saved_count).toBe(2);

    const second = await persistAllocations(BASE_INPUT, {
      now: () => Date.parse("2026-02-19T23:41:00.000Z"),
    });

    expect(second.status).toBe("already_exists");
    if (second.status !== "already_exists") {
      throw new Error("expected duplicate period write to return already_exists");
    }
    expect(second.saved_count).toBe(0);
    expect(second.record_id).toBe(first.record_id);
    expect(second.period).toBe("2026-02");
    expect(second.duplicate_conflict).toBe(false);

    const records = getInMemoryPersistedAllocations();
    expect(records).toHaveLength(1);
    expect(records[0]?.period).toBe("2026-02");

    const audits = getInMemoryAllocationPersistenceAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0]?.action).toBe("created");
    expect(audits[1]?.action).toBe("duplicate_ignored");
    expect(audits[1]?.payload_conflict).toBe(false);
  });

  it("audits payload conflicts when duplicate period writes differ", async () => {
    await persistAllocations(BASE_INPUT, {
      now: () => Date.parse("2026-02-19T23:40:00.000Z"),
    });

    const duplicate = await persistAllocations(
      {
        ...BASE_INPUT,
        notes: "different narrative for same period",
      },
      {
        now: () => Date.parse("2026-02-19T23:42:00.000Z"),
      }
    );

    expect(duplicate.status).toBe("already_exists");
    if (duplicate.status !== "already_exists") {
      throw new Error("expected duplicate period write to return already_exists");
    }
    expect(duplicate.duplicate_conflict).toBe(true);

    const audits = getInMemoryAllocationPersistenceAudits();
    expect(audits).toHaveLength(2);
    expect(audits[1]?.payload_conflict).toBe(true);
    expect(audits[1]?.incoming_payload_hash).not.toBe(audits[1]?.existing_payload_hash);
  });

  it("returns already_exists under concurrent duplicate writes", async () => {
    const records = new Map<string, PersistedAllocationRecord>();
    const audits: Array<{ action: string }> = [];
    let readCount = 0;
    let releaseConcurrentReads: (() => void) | undefined;
    const concurrentReadBarrier = new Promise<void>((resolve) => {
      releaseConcurrentReads = resolve;
    });

    const store: AllocationPersistenceStore = {
      async readByPeriod(period: string) {
        readCount += 1;
        if (readCount <= 2) {
          if (readCount === 2) {
            releaseConcurrentReads?.();
          }
          await concurrentReadBarrier;
        }
        return records.get(period) ?? null;
      },
      appendRecord(record) {
        if (records.has(record.period)) {
          throw new Error(`allocation record for period ${record.period} already exists`);
        }
        records.set(record.period, record);
      },
      appendAudit(audit) {
        audits.push({ action: audit.action });
      },
    };

    const [first, second] = await Promise.all([
      persistAllocations(BASE_INPUT, { store }),
      persistAllocations(BASE_INPUT, { store }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["already_exists", "ok"]);
    expect(audits.filter((audit) => audit.action === "created")).toHaveLength(1);
    expect(audits.filter((audit) => audit.action === "duplicate_ignored")).toHaveLength(1);
  });

  it("rejects invalid allocation constraints before persisting", async () => {
    await expect(
      persistAllocations({
        ...BASE_INPUT,
        allocations: [
          {
            ...BASE_INPUT.allocations[0],
            amount_minor: 700,
          },
        ],
      })
    ).rejects.toThrowError("allocation persistence rejected invalid constraints");
  });

  it("enforces authorization in production without principal", async () => {
    await expect(
      persistAllocations(BASE_INPUT, {
        runtimeEnvironment: "production",
        allowTestAuthBypass: false,
      })
    ).rejects.toThrowError("authorization required");
  });

  it("enforces tool risk allowance", async () => {
    await expect(
      persistAllocations(BASE_INPUT, {
        maxAllowedRisk: "low",
      })
    ).rejects.toThrowError("requires medium risk allowance");
  });
});
