import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REJECTION_AUDIT_TTL_MS,
  logLibraryUsage,
  MAX_LIBRARIES_PER_CALL,
} from "../src/tools/log-library-usage.js";
import {
  clearLibraryUsageEvents,
  getLibraryUsageEvents,
  getLibraryUsageRejectionAudits,
} from "../src/tools/testing.js";

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
    vi.stubEnv("NODE_ENV", "test");
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
    expect(enqueueEvent).toHaveBeenCalledWith({
      session_id: SESSION_IDS.four,
      source: "ci",
      ts: "2026-02-17T12:00:00.000Z",
      library: {
        name: "fastapi",
        ecosystem: "pypi",
        version: "0.115.3",
        calls: 2,
      },
    });
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

  it("accepts only one of two concurrent duplicate requests", async () => {
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

    const enqueueEvent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const [first, second] = await Promise.all([
      logLibraryUsage(input, {
        enqueueEvent,
        now: () => 0,
        replayWindowMs: 60_000,
      }),
      logLibraryUsage(input, {
        enqueueEvent,
        now: () => 0,
        replayWindowMs: 60_000,
      }),
    ]);

    const okResults = [first, second].filter((result) => result.status === "ok");
    const duplicateResults = [first, second].filter(
      (result) => result.status === "rejected" && result.reason === "duplicate_event"
    );

    expect(okResults).toHaveLength(1);
    expect(duplicateResults).toHaveLength(1);
  });

  it("rejects requests when session rate limit is exceeded", async () => {
    const firstInput = {
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

    const secondInput = {
      ...firstInput,
      libraries: [
        {
          name: "redis",
          ecosystem: "npm",
          version: "4.0.0",
          calls: 1,
        },
      ],
    };

    const first = await logLibraryUsage(firstInput, {
      now: () => 0,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
    });
    const second = await logLibraryUsage(secondInput, {
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

  it("audits rate-limited rejection metadata", async () => {
    const firstInput = {
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

    const secondInput = {
      ...firstInput,
      libraries: [
        {
          name: "redis",
          ecosystem: "npm",
          version: "4.0.0",
          calls: 1,
        },
      ],
    };

    await logLibraryUsage(firstInput, {
      now: () => 0,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
    });
    const rejected = await logLibraryUsage(secondInput, {
      now: () => 1_000,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
    });

    const audits = getLibraryUsageRejectionAudits();

    expect(rejected).toEqual({
      status: "rejected",
      reason: "rate_limited",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      observed_at: "1970-01-01T00:00:01.000Z",
      runtime_environment: "test",
      reason: "rate_limited",
      session_id: SESSION_IDS.six,
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries_count: 1,
      candidate_events_count: 1,
    });
  });

  it("prunes stale in-memory rejection audits beyond TTL", async () => {
    await logLibraryUsage(
      {
        session_id: "invalid",
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [],
      },
      {
        now: () => 0,
      }
    );

    await logLibraryUsage(
      {
        session_id: "invalid",
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [],
      },
      {
        now: () => DEFAULT_REJECTION_AUDIT_TTL_MS + 2_000,
      }
    );

    const audits = getLibraryUsageRejectionAudits();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.observed_at).toBe("1970-01-02T00:00:02.000Z");
  });

  it("rejects first request when libraries exceed per-window cap", async () => {
    const result = await logLibraryUsage(
      {
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
          {
            name: "redis",
            ecosystem: "npm",
            version: "4.0.0",
            calls: 1,
          },
        ],
      },
      {
        maxLibrariesPerWindow: 1,
      }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "rate_limited",
    });
  });

  it("rejects requests when guardrail limits are invalid", async () => {
    const result = await logLibraryUsage(
      {
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
      },
      {
        maxRequestsPerWindow: 0,
      }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "guardrail_failure",
    });
  });

  it("does not mark replay cache when enqueue fails before any success", async () => {
    const enqueueEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);

    const input = {
      session_id: SESSION_IDS.one,
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
      enqueueEvent,
      now: () => 0,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
      maxLibrariesPerWindow: 1,
    });
    const second = await logLibraryUsage(input, {
      enqueueEvent,
      now: () => 1,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 1,
      maxLibrariesPerWindow: 1,
    });

    expect(first).toEqual({
      status: "rejected",
      reason: "enqueue_failed",
      recorded_count: 0,
    });
    expect(second).toEqual({
      status: "ok",
      recorded_count: 1,
    });
  });

  it("allows retry to continue after partial enqueue success", async () => {
    const enqueueEvent = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("queue timeout"))
      .mockResolvedValueOnce(undefined);

    const input = {
      session_id: SESSION_IDS.two,
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [
        {
          name: "zod",
          ecosystem: "npm",
          version: "3.23.8",
          calls: 1,
        },
        {
          name: "redis",
          ecosystem: "npm",
          version: "4.0.0",
          calls: 1,
        },
      ],
    };

    const first = await logLibraryUsage(input, {
      enqueueEvent,
      now: () => 0,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 10,
      maxLibrariesPerWindow: 2,
    });
    const second = await logLibraryUsage(input, {
      enqueueEvent,
      now: () => 1,
      rateLimitWindowMs: 60_000,
      maxRequestsPerWindow: 10,
      maxLibrariesPerWindow: 2,
    });

    expect(first).toEqual({
      status: "rejected",
      reason: "enqueue_failed",
      recorded_count: 1,
    });
    expect(second).toEqual({
      status: "ok",
      recorded_count: 1,
    });
  });

  it("rejects in production when in-memory guardrails are used without explicit opt-in", async () => {
    vi.stubEnv("NODE_ENV", "production");

    try {
      const auditRejection = vi.fn();
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

      const rejected = await logLibraryUsage(input, {
        auditRejection,
      });
      const allowed = await logLibraryUsage(input, {
        allowInMemoryGuardsInProduction: true,
        auditRejection,
      });

      expect(rejected).toEqual({
        status: "rejected",
        reason: "guardrails_not_configured",
      });
      expect(allowed).toEqual({
        status: "ok",
        recorded_count: 1,
      });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "test");
    }
  });

  it("allows production calls with custom guardrail adapters and durable audit sink", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const replayProtection = {
      cleanup: vi.fn(),
      reserve: vi.fn(() => true),
      release: vi.fn(),
    };
    const rateLimiter = {
      cleanup: vi.fn(),
      consume: vi.fn(() => true),
      refund: vi.fn(),
    };

    try {
      const input = {
        session_id: SESSION_IDS.one,
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
        replayProtection,
        rateLimiter,
        rejectionAuditFilePath: ".data/test-library-usage-rejection-audits.ndjson",
      });
      const second = await logLibraryUsage(input, {
        replayProtection,
        rateLimiter,
        rejectionAuditFilePath: ".data/test-library-usage-rejection-audits.ndjson",
      });

      expect(first).toEqual({
        status: "ok",
        recorded_count: 1,
      });
      expect(second).toEqual({
        status: "ok",
        recorded_count: 1,
      });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "test");
    }
  });

  it("fails closed when runtime mode is unknown or unset", async () => {
    vi.stubEnv("NODE_ENV", undefined);

    try {
      const auditRejection = vi.fn();
      const result = await logLibraryUsage(
        {
          session_id: SESSION_IDS.one,
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
        },
        { auditRejection }
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "guardrails_not_configured",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "test");
    }
  });

  it("returns rejected output when replay guardrail cleanup throws", async () => {
    const replayProtection = {
      cleanup: vi.fn().mockRejectedValue(new Error("replay backend unavailable")),
      reserve: vi.fn(),
      release: vi.fn(),
    };

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.one,
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
      },
      { replayProtection }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "guardrail_failure",
    });
  });

  it("returns rejected output and releases reservations when rate limiter throws", async () => {
    const reservedFingerprints = new Set<string>();
    const replayProtection = {
      cleanup: vi.fn(),
      reserve: vi.fn((fingerprint: string) => {
        if (reservedFingerprints.has(fingerprint)) {
          return false;
        }
        reservedFingerprints.add(fingerprint);
        return true;
      }),
      release: vi.fn((fingerprint: string) => {
        reservedFingerprints.delete(fingerprint);
      }),
    };
    const rateLimiter = {
      cleanup: vi.fn(),
      consume: vi.fn().mockRejectedValue(new Error("rate backend unavailable")),
      refund: vi.fn(),
    };

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.two,
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
      },
      {
        replayProtection,
        rateLimiter,
      }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "guardrail_failure",
    });
    expect(replayProtection.release).toHaveBeenCalledTimes(1);
    expect(reservedFingerprints.size).toBe(0);
  });

  it("throttles repetitive malformed-payload rejection audits", async () => {
    const auditRejection = vi.fn().mockResolvedValue(undefined);
    const payload = {
      session_id: SESSION_IDS.one,
      source: "api",
      ts: "2026-02-17T12:00:00.000Z",
      libraries: [],
    };

    const first = await logLibraryUsage(payload, {
      auditRejection,
      invalidRejectionAuditWindowMs: 60_000,
      maxInvalidRejectionAuditsPerWindow: 1,
    });
    const second = await logLibraryUsage(payload, {
      auditRejection,
      invalidRejectionAuditWindowMs: 60_000,
      maxInvalidRejectionAuditsPerWindow: 1,
    });
    const third = await logLibraryUsage(payload, {
      auditRejection,
      invalidRejectionAuditWindowMs: 60_000,
      maxInvalidRejectionAuditsPerWindow: 1,
    });

    expect(first).toEqual({
      status: "rejected",
      reason: "no_libraries",
    });
    expect(second).toEqual({
      status: "rejected",
      reason: "no_libraries",
    });
    expect(third).toEqual({
      status: "rejected",
      reason: "no_libraries",
    });
    expect(auditRejection).toHaveBeenCalledTimes(1);
  });

  it("fails open on audit sink capacity errors by default", async () => {
    const capacityError = Object.assign(new Error("disk full"), {
      code: "ENOSPC",
    });
    const auditRejection = vi.fn().mockRejectedValue(capacityError);

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.one,
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [],
      },
      { auditRejection }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "no_libraries",
    });
  });

  it("supports fail-closed mode for audit sink capacity errors", async () => {
    const capacityError = Object.assign(new Error("disk full"), {
      code: "ENOSPC",
    });
    const auditRejection = vi.fn().mockRejectedValue(capacityError);

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.one,
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [],
      },
      {
        auditRejection,
        auditSinkFailureMode: "fail_closed",
      }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "guardrail_failure",
    });
  });

  it("fails closed when rejection audit sink throws", async () => {
    const auditRejection = vi.fn().mockRejectedValue(new Error("audit backend unavailable"));

    const result = await logLibraryUsage(
      {
        session_id: SESSION_IDS.one,
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
        libraries: [],
      },
      { auditRejection }
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "guardrail_failure",
    });
    expect(auditRejection).toHaveBeenCalledTimes(1);
  });
});
