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
  });
});
