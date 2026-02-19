import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearInMemoryLibraryUsageIngestionEvents,
  createLibraryUsageIngestionPipeline,
  createNdjsonLibraryUsageEventStore,
} from "../src/tools/library-usage-ingestion.js";

const sampleEvent = {
  session_id: "a".repeat(64),
  source: "api" as const,
  ts: "2026-02-19T22:00:00.000Z",
  library: {
    name: "zod",
    ecosystem: "npm" as const,
    version: "3.23.8",
    calls: 2,
  },
};

describe("library usage ingestion pipeline", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearInMemoryLibraryUsageIngestionEvents();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("persists events to in-memory store and exposes metrics", async () => {
    const pipeline = createLibraryUsageIngestionPipeline({
      now: () => Date.parse("2026-02-19T22:01:00.000Z"),
    });

    await pipeline.enqueueEvent(sampleEvent);

    const metrics = pipeline.getMetrics();
    const events = await pipeline.readIngestedEvents();

    expect(metrics).toMatchObject({
      events_received: 1,
      events_persisted: 1,
      events_failed: 0,
      last_ingested_at: "2026-02-19T22:01:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toEqual(sampleEvent);
    expect(events[0]?.event_id).toMatch(/^evt_[a-f0-9]{24}$/);
  });

  it("stores events durably in NDJSON event log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oss-royalty-layer-"));
    tempDirs.push(dir);
    const filePath = join(dir, "library-usage.ndjson");
    const store = createNdjsonLibraryUsageEventStore(filePath);
    const pipeline = createLibraryUsageIngestionPipeline({
      eventStore: store,
      now: () => Date.parse("2026-02-19T22:02:00.000Z"),
    });

    await pipeline.enqueueEvent(sampleEvent);

    const restoredStore = createNdjsonLibraryUsageEventStore(filePath);
    const restored = await restoredStore.readAll();

    expect(restored).toHaveLength(1);
    expect(restored[0]?.event).toEqual(sampleEvent);
    expect(restored[0]?.ingested_at).toBe("2026-02-19T22:02:00.000Z");
  });

  it("counts schema parse failures in ingestion metrics", async () => {
    const pipeline = createLibraryUsageIngestionPipeline();

    await expect(
      pipeline.enqueueEvent({
        session_id: "a".repeat(64),
        source: "api",
        ts: "2026-02-19T22:00:00.000Z",
        library: {
          name: "zod",
          ecosystem: "npm",
          version: "3.23.8",
          calls: -1,
        },
      })
    ).rejects.toThrowError();

    expect(pipeline.getMetrics()).toMatchObject({
      events_received: 1,
      events_persisted: 0,
      events_failed: 1,
    });
  });
});
