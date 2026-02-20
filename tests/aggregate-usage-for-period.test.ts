import { describe, expect, it, vi } from "vitest";

import { aggregateUsageForPeriod } from "../src/tools/aggregate-usage-for-period.js";
import {
  clearInMemoryLibraryUsageIngestionEvents,
  createLibraryUsageIngestionPipeline,
} from "../src/tools/library-usage-ingestion.js";
import { createInMemoryLibraryRegistry } from "../src/tools/library-registry.js";

const SESSION_IDS = {
  one: "a".repeat(64),
  two: "b".repeat(64),
  three: "c".repeat(64),
} as const;

describe("aggregateUsageForPeriod", () => {
  it("aggregates calls and unique sessions for events in period", async () => {
    clearInMemoryLibraryUsageIngestionEvents();

    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: 2,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "cli",
      ts: "2026-02-19T11:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: 3,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T12:00:00.000Z",
      library: {
        name: "redis",
        ecosystem: "npm",
        version: "4.0.0",
        calls: 1,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.three,
      source: "api",
      ts: "2026-02-20T00:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: 10,
      },
    });

    const result = await aggregateUsageForPeriod(
      {
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
      },
      {
        eventStore: {
          readAll: pipeline.readIngestedEvents,
          append: () => {
            throw new Error("not used in aggregation");
          },
        },
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
      }
    );

    expect(result.next_cursor).toBeUndefined();
    expect(result.aggregates).toHaveLength(2);

    const zodId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "zod",
    }).library_id;
    const redisId = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "redis",
    }).library_id;

    expect(result.aggregates).toContainEqual({
      library_id: zodId,
      total_calls: 5,
      unique_sessions: 2,
    });
    expect(result.aggregates).toContainEqual({
      library_id: redisId,
      total_calls: 1,
      unique_sessions: 1,
    });
  });

  it("supports cursor pagination and rejects malformed cursor", async () => {
    clearInMemoryLibraryUsageIngestionEvents();

    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 1,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T10:01:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 1,
      },
    });

    const eventStore = {
      readAll: vi.fn(async () => pipeline.readIngestedEvents()),
      append: () => {
        throw new Error("not used in aggregation");
      },
    };

    const firstPage = await aggregateUsageForPeriod(
      {
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        page_size: 1,
      },
      {
        eventStore,
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
      }
    );

    expect(firstPage.aggregates).toHaveLength(1);
    expect(firstPage.next_cursor).toBeDefined();

    const secondPage = await aggregateUsageForPeriod(
      {
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
        page_size: 1,
        cursor: firstPage.next_cursor,
      },
      {
        eventStore,
        resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
      }
    );

    expect(secondPage.aggregates).toHaveLength(1);
    expect(secondPage.next_cursor).toBeUndefined();
    expect(eventStore.readAll).toHaveBeenCalledTimes(1);

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-18T00:00:00.000Z",
          period_end: "2026-02-19T00:00:00.000Z",
          page_size: 1,
          cursor: firstPage.next_cursor,
        },
        {
          eventStore,
          resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        }
      )
    ).rejects.toThrowError("cursor does not match query");

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-19T00:00:00.000Z",
          period_end: "2026-02-20T00:00:00.000Z",
          cursor: "not-a-valid-cursor",
        },
        {
          eventStore,
          resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        }
      )
    ).rejects.toThrowError("invalid cursor");

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-19T00:00:00.000Z",
          period_end: "2026-02-20T00:00:00.000Z",
          page_size: 1,
          cursor: firstPage.next_cursor,
        },
        {
          eventStore,
          principal: {
            principal_id: "analyst-2",
            role: "analyst",
          },
          resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        }
      )
    ).rejects.toThrowError("cursor does not match caller context");
  });

  it("memoizes resolver lookups for repeated library references", async () => {
    clearInMemoryLibraryUsageIngestionEvents();

    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 1,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T10:01:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 2,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.three,
      source: "api",
      ts: "2026-02-19T10:02:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 3,
      },
    });

    const resolveLibraryId = vi.fn(
      (reference: { ecosystem: string; name: string }) =>
        registry.resolveLibraryId(reference).library_id
    );

    await aggregateUsageForPeriod(
      {
        period_start: "2026-02-19T00:00:00.000Z",
        period_end: "2026-02-20T00:00:00.000Z",
      },
      {
        eventStore: {
          readAll: pipeline.readIngestedEvents,
          append: () => {
            throw new Error("not used in aggregation");
          },
        },
        resolveLibraryId,
      }
    );

    expect(resolveLibraryId).toHaveBeenCalledTimes(2);
  });

  it("rejects aggregate snapshots that exceed the configured size limit", async () => {
    clearInMemoryLibraryUsageIngestionEvents();

    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "alpha",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 1,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T10:01:00.000Z",
      library: {
        name: "beta",
        ecosystem: "npm",
        version: "1.0.0",
        calls: 1,
      },
    });

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-19T00:00:00.000Z",
          period_end: "2026-02-20T00:00:00.000Z",
          page_size: 1,
        },
        {
          eventStore: {
            readAll: pipeline.readIngestedEvents,
            append: () => {
              throw new Error("not used in aggregation");
            },
          },
          resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
          maxSnapshotRows: 1,
        }
      )
    ).rejects.toThrowError("exceeds snapshot limit");
  });

  it("enforces guardrail risk allowance and maximum aggregation period", async () => {
    const eventStore = {
      readAll: () => [],
      append: () => {
        throw new Error("not used in aggregation");
      },
    };

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-01T00:00:00.000Z",
          period_end: "2026-02-02T00:00:00.000Z",
        },
        {
          eventStore,
          maxAllowedRisk: "low",
        }
      )
    ).rejects.toThrowError("requires medium risk allowance");

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-01-01T00:00:00.000Z",
          period_end: "2026-02-15T00:00:00.000Z",
        },
        {
          eventStore,
          maxAggregationPeriodDays: 31,
        }
      )
    ).rejects.toThrowError("aggregation period exceeds 31 days");
  });

  it("enforces authorization boundaries for internal aggregation tool access", async () => {
    const eventStore = {
      readAll: () => [],
      append: () => {
        throw new Error("not used in aggregation");
      },
    };

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-01T00:00:00.000Z",
          period_end: "2026-02-02T00:00:00.000Z",
        },
        {
          eventStore,
          runtimeEnvironment: "production",
          allowTestAuthBypass: false,
        }
      )
    ).rejects.toThrowError("authorization required");

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-01T00:00:00.000Z",
          period_end: "2026-02-02T00:00:00.000Z",
        },
        {
          eventStore,
          runtimeEnvironment: "production",
          principal: {
            principal_id: "viewer-1",
            role: "viewer",
          },
        }
      )
    ).rejects.toThrowError("not authorized");

    const allowed = await aggregateUsageForPeriod(
      {
        period_start: "2026-02-01T00:00:00.000Z",
        period_end: "2026-02-02T00:00:00.000Z",
      },
      {
        eventStore,
        runtimeEnvironment: "production",
        principal: {
          principal_id: "analyst-1",
          role: "analyst",
        },
      }
    );
    expect(allowed).toEqual({ aggregates: [] });
  });

  it("rejects usage aggregation overflow", async () => {
    clearInMemoryLibraryUsageIngestionEvents();

    const pipeline = createLibraryUsageIngestionPipeline();
    const registry = createInMemoryLibraryRegistry();

    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-19T10:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: Number.MAX_SAFE_INTEGER,
      },
    });
    await pipeline.enqueueEvent({
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-19T11:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: 1,
      },
    });

    await expect(
      aggregateUsageForPeriod(
        {
          period_start: "2026-02-19T00:00:00.000Z",
          period_end: "2026-02-20T00:00:00.000Z",
        },
        {
          eventStore: {
            readAll: pipeline.readIngestedEvents,
            append: () => {
              throw new Error("not used in aggregation");
            },
          },
          resolveLibraryId: (reference) => registry.resolveLibraryId(reference).library_id,
        }
      )
    ).rejects.toThrowError("aggregate total_calls overflow");
  });
});
