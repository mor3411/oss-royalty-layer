import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLibraryUsageEvents,
  getLibraryUsageEvents,
  logLibraryUsage,
  MAX_LIBRARIES_PER_CALL,
} from "../src/tools/log-library-usage.js";

const SESSION_IDS = {
  one: "a".repeat(64),
  two: "b".repeat(64),
  three: "c".repeat(64),
  four: "d".repeat(64),
  five: "e".repeat(64),
  six: "f".repeat(64),
} as const;

describe("logLibraryUsage", () => {
  beforeEach(() => {
    clearLibraryUsageEvents();
  });

  it("accepts valid input, normalizes values, and emits events", async () => {
    const result = await logLibraryUsage({
      session_id: SESSION_IDS.one,
      source: "IDE",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: " Zod ",
          ecosystem: "NPM",
          version: " 3.23.8 ",
          calls: 4,
        },
      ],
    });

    const events = getLibraryUsageEvents();

    expect(result).toEqual({
      status: "ok",
      recorded_count: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: SESSION_IDS.one,
      source: "ide",
      ts: "2026-02-17T12:00:00.000Z",
      library: {
        name: "zod",
        ecosystem: "npm",
        version: "3.23.8",
        calls: 4,
      },
    });
  });

  it("rejects calls above hard library cap", async () => {
    const libraries = Array.from({ length: MAX_LIBRARIES_PER_CALL + 1 }, (_, index) => ({
      name: `lib-${index}`,
      ecosystem: "npm",
      version: "1.0.0",
      calls: 1,
    }));

    const result = await logLibraryUsage({
      session_id: SESSION_IDS.two,
      source: "cli",
      ts: "2026-02-17T12:00:00.000Z",
      libraries,
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "too_many_libraries",
    });
    expect(getLibraryUsageEvents()).toHaveLength(0);
  });

  it("rejects empty libraries payloads", async () => {
    const result = await logLibraryUsage({
      session_id: SESSION_IDS.three,
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [],
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "no_libraries",
    });
    expect(getLibraryUsageEvents()).toHaveLength(0);
  });

  it("rejects malformed payloads", async () => {
    const result = await logLibraryUsage({
      session_id: "",
      source: "unknown",
      ts: "invalid-date",
      libraries: [
        {
          name: "",
          ecosystem: "bad",
          version: "",
          calls: -1,
        },
      ],
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_payload",
    });
    expect(getLibraryUsageEvents()).toHaveLength(0);
  });

  it("rejects non-hash session identifiers", async () => {
    const result = await logLibraryUsage({
      session_id: "sess-plain-text",
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: "zod",
          ecosystem: "npm",
          version: "3.23.8",
          calls: 1,
        },
      ],
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_payload",
    });
  });

  it("rejects overly long library names", async () => {
    const result = await logLibraryUsage({
      session_id: SESSION_IDS.four,
      source: "cli",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: "a".repeat(129),
          ecosystem: "npm",
          version: "1.0.0",
          calls: 1,
        },
      ],
    });

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid_payload",
    });
  });

  it("supports custom enqueue implementations", async () => {
    const enqueueEvent = vi.fn().mockResolvedValue(undefined);

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.four,
        source: "ci",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [
          {
            name: "fastapi",
            ecosystem: "pypi",
            version: "0.115.3",
            calls: 2,
          },
        ],
      },
      { enqueueEvent }
    );

    expect(result).toEqual({
      status: "ok",
      recorded_count: 1,
    });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(getLibraryUsageEvents()).toHaveLength(0);
  });

  it("rejects duplicate events within replay window", async () => {
    const input = {
      session_id: SESSION_IDS.five,
      source: "cli",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: "redis",
          ecosystem: "npm",
          version: "1.0.0",
          calls: 1,
        },
      ],
    };

    const first = await logLibraryUsage(input, {
      now: () => 0,
      replayWindowMs: 60_000,
    });

    const second = await logLibraryUsage(input, {
      now: () => 1_000,
      replayWindowMs: 60_000,
    });

    expect(first.status).toBe("ok");
    expect(second).toEqual({
      status: "rejected",
      reason: "duplicate_event",
    });
  });

  it("rejects requests when session rate limit is exceeded", async () => {
    const input = {
      session_id: SESSION_IDS.six,
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: "zod",
          ecosystem: "npm",
          version: "3.23.8",
          calls: 1,
        },
      ],
    };

    const first = await logLibraryUsage(input, {
      now: () => 0,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
    });
    const second = await logLibraryUsage(input, {
      now: () => 1_000,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
    });

    expect(first.status).toBe("ok");
    expect(second).toEqual({
      status: "rejected",
      reason: "rate_limited",
    });
  });
});
