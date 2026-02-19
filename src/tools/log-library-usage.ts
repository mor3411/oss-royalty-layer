import { createHash } from "node:crypto";
import { z } from "zod";

import { EcosystemSchema, UsageSourceSchema } from "../domain/index.js";

export const MAX_LIBRARIES_PER_CALL = 1000;
export const MAX_IN_MEMORY_EVENTS = 10_000;
export const MAX_REPLAY_CACHE_ENTRIES = 50_000;
export const MAX_RATE_LIMIT_ENTRIES = 20_000;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_MAX_REQUESTS_PER_WINDOW = 60;
export const DEFAULT_MAX_LIBRARIES_PER_WINDOW = 10_000;

const SESSION_ID_REGEX = /^[a-f0-9]{32,128}$/;
const RuntimeEnvironmentSchema = z.enum(["development", "test", "production"]);

export const LibraryUsagePayloadSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .transform((value) => value.toLowerCase()),
  ecosystem: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(EcosystemSchema),
  version: z.string().trim().min(1).max(64),
  calls: z.number().int().nonnegative(),
});

export const LogLibraryUsageInputSchema = z.object({
  session_id: z.string().trim().toLowerCase().regex(SESSION_ID_REGEX),
  source: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(UsageSourceSchema),
  ts: z.string().datetime(),
  libraries: z.array(LibraryUsagePayloadSchema).min(1).max(MAX_LIBRARIES_PER_CALL),
});

const LogLibraryUsageRejectionReasonSchema = z.enum([
  "invalid_payload",
  "too_many_libraries",
  "no_libraries",
  "rate_limited",
  "duplicate_event",
  "enqueue_failed",
  "guardrails_not_configured",
  "guardrail_failure",
]);

export const LogLibraryUsageOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    recorded_count: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: LogLibraryUsageRejectionReasonSchema,
    recorded_count: z.number().int().nonnegative().optional(),
  }),
]);

export const LibraryUsageLoggedEventSchema = z.object({
  session_id: z.string(),
  source: UsageSourceSchema,
  ts: z.string().datetime(),
  library: LibraryUsagePayloadSchema,
});

export type LibraryUsagePayload = z.infer<typeof LibraryUsagePayloadSchema>;
export type LogLibraryUsageInput = z.infer<typeof LogLibraryUsageInputSchema>;
export type LogLibraryUsageOutput = z.infer<typeof LogLibraryUsageOutputSchema>;
export type LibraryUsageLoggedEvent = z.infer<typeof LibraryUsageLoggedEventSchema>;

export type EnqueueLibraryUsageEvent = (event: LibraryUsageLoggedEvent) => Promise<void> | void;

export type LogLibraryUsageOptions = {
  enqueueEvent?: EnqueueLibraryUsageEvent;
  replayWindowMs?: number;
  rateLimitWindowMs?: number;
  maxRequestsPerWindow?: number;
  maxLibrariesPerWindow?: number;
  now?: () => number;
  replayProtection?: ReplayProtection;
  rateLimiter?: SessionRateLimiter;
  allowInMemoryGuardsInProduction?: boolean;
  runtimeEnvironment?: "development" | "test" | "production";
};

const inMemoryLibraryUsageEvents: LibraryUsageLoggedEvent[] = [];
const replayCache = new Map<string, number>();
const sessionRateLimitState = new Map<
  string,
  {
    windowStartMs: number;
    requests: number;
    libraries: number;
  }
>();

type ReplayProtection = {
  cleanup: (nowMs: number, replayWindowMs: number) => Promise<void> | void;
  reserve: (fingerprint: string, nowMs: number) => Promise<boolean> | boolean;
  release: (fingerprint: string) => Promise<void> | void;
};

type SessionRateLimiter = {
  cleanup: (nowMs: number, windowMs: number) => Promise<void> | void;
  consume: (
    sessionId: string,
    librariesCount: number,
    nowMs: number,
    windowMs: number,
    maxRequestsPerWindow: number,
    maxLibrariesPerWindow: number
  ) => Promise<boolean> | boolean;
  refund: (
    sessionId: string,
    requests: number,
    libraries: number,
    nowMs: number,
    windowMs: number
  ) => Promise<void> | void;
};

export function clearLibraryUsageEvents(): void {
  inMemoryLibraryUsageEvents.length = 0;
  replayCache.clear();
  sessionRateLimitState.clear();
}

export function getLibraryUsageEvents(): LibraryUsageLoggedEvent[] {
  return [...inMemoryLibraryUsageEvents];
}

function defaultEnqueueLibraryUsageEvent(event: LibraryUsageLoggedEvent): void {
  while (inMemoryLibraryUsageEvents.length >= MAX_IN_MEMORY_EVENTS) {
    inMemoryLibraryUsageEvents.shift();
  }
  inMemoryLibraryUsageEvents.push(event);
}

function getRejectionReason(
  error: z.ZodError
): "invalid_payload" | "too_many_libraries" | "no_libraries" {
  const hasTooManyLibrariesIssue = error.issues.some(
    (issue) => issue.path.length === 1 && issue.path[0] === "libraries" && issue.code === "too_big"
  );
  if (hasTooManyLibrariesIssue) {
    return "too_many_libraries";
  }

  const hasNoLibrariesIssue = error.issues.some(
    (issue) =>
      issue.path.length === 1 && issue.path[0] === "libraries" && issue.code === "too_small"
  );
  if (hasNoLibrariesIssue) {
    return "no_libraries";
  }

  return "invalid_payload";
}

function cleanupReplayCache(nowMs: number, replayWindowMs: number): void {
  for (const [fingerprint, seenAtMs] of replayCache) {
    if (nowMs - seenAtMs > replayWindowMs) {
      replayCache.delete(fingerprint);
    }
  }

  while (replayCache.size > MAX_REPLAY_CACHE_ENTRIES) {
    const oldestKey = replayCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    replayCache.delete(oldestKey);
  }
}

function cleanupRateLimitState(nowMs: number, windowMs: number): void {
  for (const [sessionId, state] of sessionRateLimitState) {
    if (nowMs - state.windowStartMs > windowMs * 2) {
      sessionRateLimitState.delete(sessionId);
    }
  }

  while (sessionRateLimitState.size > MAX_RATE_LIMIT_ENTRIES) {
    const oldestKey = sessionRateLimitState.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionRateLimitState.delete(oldestKey);
  }
}

function checkAndConsumeRateLimit(
  sessionId: string,
  librariesCount: number,
  nowMs: number,
  windowMs: number,
  maxRequestsPerWindow: number,
  maxLibrariesPerWindow: number
): boolean {
  const existingState = sessionRateLimitState.get(sessionId);
  if (!existingState || nowMs - existingState.windowStartMs >= windowMs) {
    if (1 > maxRequestsPerWindow) {
      return false;
    }
    if (librariesCount > maxLibrariesPerWindow) {
      return false;
    }
    sessionRateLimitState.set(sessionId, {
      windowStartMs: nowMs,
      requests: 1,
      libraries: librariesCount,
    });
    return true;
  }

  if (existingState.requests + 1 > maxRequestsPerWindow) {
    return false;
  }

  if (existingState.libraries + librariesCount > maxLibrariesPerWindow) {
    return false;
  }

  existingState.requests += 1;
  existingState.libraries += librariesCount;
  return true;
}

function refundRateLimit(
  sessionId: string,
  requests: number,
  libraries: number,
  nowMs: number,
  windowMs: number
): void {
  const state = sessionRateLimitState.get(sessionId);
  if (!state) {
    return;
  }

  if (nowMs - state.windowStartMs >= windowMs) {
    sessionRateLimitState.delete(sessionId);
    return;
  }

  state.requests = Math.max(0, state.requests - requests);
  state.libraries = Math.max(0, state.libraries - libraries);

  if (state.requests === 0 && state.libraries === 0) {
    sessionRateLimitState.delete(sessionId);
  }
}

function fingerprintEvent(event: LibraryUsageLoggedEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function resolveRuntimeEnvironment(
  override: LogLibraryUsageOptions["runtimeEnvironment"]
): "development" | "test" | "production" {
  if (override) {
    return override;
  }
  const parsedEnvironment = RuntimeEnvironmentSchema.safeParse(process.env.NODE_ENV);
  if (parsedEnvironment.success) {
    return parsedEnvironment.data;
  }
  // Unknown or missing runtime mode should fail closed.
  return "production";
}

const inMemoryReplayProtection: ReplayProtection = {
  cleanup(nowMs: number, replayWindowMs: number): void {
    cleanupReplayCache(nowMs, replayWindowMs);
  },
  reserve(fingerprint: string, nowMs: number): boolean {
    if (replayCache.has(fingerprint)) {
      return false;
    }
    replayCache.set(fingerprint, nowMs);
    return true;
  },
  release(fingerprint: string): void {
    replayCache.delete(fingerprint);
  },
};

const inMemorySessionRateLimiter: SessionRateLimiter = {
  cleanup(nowMs: number, windowMs: number): void {
    cleanupRateLimitState(nowMs, windowMs);
  },
  consume(
    sessionId: string,
    librariesCount: number,
    nowMs: number,
    windowMs: number,
    maxRequestsPerWindow: number,
    maxLibrariesPerWindow: number
  ): boolean {
    return checkAndConsumeRateLimit(
      sessionId,
      librariesCount,
      nowMs,
      windowMs,
      maxRequestsPerWindow,
      maxLibrariesPerWindow
    );
  },
  refund(
    sessionId: string,
    requests: number,
    libraries: number,
    nowMs: number,
    windowMs: number
  ): void {
    refundRateLimit(sessionId, requests, libraries, nowMs, windowMs);
  },
};

async function releaseReservedFingerprints(
  replayProtection: ReplayProtection,
  fingerprints: string[]
): Promise<boolean> {
  try {
    for (const fingerprint of fingerprints) {
      await replayProtection.release(fingerprint);
    }
    return true;
  } catch {
    return false;
  }
}

export async function logLibraryUsage(
  input: unknown,
  options: LogLibraryUsageOptions = {}
): Promise<LogLibraryUsageOutput> {
  const nowMs = options.now?.() ?? Date.now();
  const replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxRequestsPerWindow = options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxLibrariesPerWindow = options.maxLibrariesPerWindow ?? DEFAULT_MAX_LIBRARIES_PER_WINDOW;
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnvironment);
  const replayProtection = options.replayProtection ?? inMemoryReplayProtection;
  const rateLimiter = options.rateLimiter ?? inMemorySessionRateLimiter;
  const usesInMemoryGuardrails =
    replayProtection === inMemoryReplayProtection || rateLimiter === inMemorySessionRateLimiter;

  if (
    !isPositiveInteger(replayWindowMs) ||
    !isPositiveInteger(rateLimitWindowMs) ||
    !isPositiveInteger(maxRequestsPerWindow) ||
    !isPositiveInteger(maxLibrariesPerWindow)
  ) {
    return {
      status: "rejected",
      reason: "guardrail_failure",
    };
  }

  if (
    runtimeEnvironment === "production" &&
    usesInMemoryGuardrails &&
    !options.allowInMemoryGuardsInProduction
  ) {
    return {
      status: "rejected",
      reason: "guardrails_not_configured",
    };
  }

  try {
    await replayProtection.cleanup(nowMs, replayWindowMs);
    await rateLimiter.cleanup(nowMs, rateLimitWindowMs);
  } catch {
    return {
      status: "rejected",
      reason: "guardrail_failure",
    };
  }

  const parsedInput = LogLibraryUsageInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "rejected",
      reason: getRejectionReason(parsedInput.error),
    };
  }

  const enqueueEvent = options.enqueueEvent ?? defaultEnqueueLibraryUsageEvent;

  const normalizedEvents = parsedInput.data.libraries.map((library) => ({
    session_id: parsedInput.data.session_id,
    source: parsedInput.data.source,
    ts: parsedInput.data.ts,
    library,
  }));

  const candidateEvents: Array<{ event: LibraryUsageLoggedEvent; fingerprint: string }> = [];
  const seenFingerprints = new Set<string>();

  try {
    for (const event of normalizedEvents) {
      const fingerprint = fingerprintEvent(event);
      if (seenFingerprints.has(fingerprint)) {
        continue;
      }
      seenFingerprints.add(fingerprint);
      if (!(await replayProtection.reserve(fingerprint, nowMs))) {
        continue;
      }
      candidateEvents.push({ event, fingerprint });
    }
  } catch {
    await releaseReservedFingerprints(
      replayProtection,
      candidateEvents.map((candidate) => candidate.fingerprint)
    );
    return {
      status: "rejected",
      reason: "guardrail_failure",
    };
  }

  if (candidateEvents.length === 0) {
    return {
      status: "rejected",
      reason: "duplicate_event",
    };
  }

  let allowedByRateLimit: boolean;
  try {
    allowedByRateLimit = await rateLimiter.consume(
      parsedInput.data.session_id,
      candidateEvents.length,
      nowMs,
      rateLimitWindowMs,
      maxRequestsPerWindow,
      maxLibrariesPerWindow
    );
  } catch {
    await releaseReservedFingerprints(
      replayProtection,
      candidateEvents.map((candidate) => candidate.fingerprint)
    );
    return {
      status: "rejected",
      reason: "guardrail_failure",
    };
  }

  if (!allowedByRateLimit) {
    const released = await releaseReservedFingerprints(
      replayProtection,
      candidateEvents.map((candidate) => candidate.fingerprint)
    );
    if (!released) {
      return {
        status: "rejected",
        reason: "guardrail_failure",
      };
    }
    return {
      status: "rejected",
      reason: "rate_limited",
    };
  }

  let recordedCount = 0;
  for (let index = 0; index < candidateEvents.length; index += 1) {
    const candidate = candidateEvents[index];
    if (!candidate) {
      continue;
    }

    try {
      await enqueueEvent(candidate.event);
      recordedCount += 1;
    } catch {
      const pendingFingerprints: string[] = [];
      for (let releaseIndex = index; releaseIndex < candidateEvents.length; releaseIndex += 1) {
        const pending = candidateEvents[releaseIndex];
        if (!pending) {
          continue;
        }
        pendingFingerprints.push(pending.fingerprint);
      }

      const released = await releaseReservedFingerprints(replayProtection, pendingFingerprints);

      try {
        await rateLimiter.refund(
          parsedInput.data.session_id,
          recordedCount === 0 ? 1 : 0,
          candidateEvents.length - recordedCount,
          nowMs,
          rateLimitWindowMs
        );
      } catch {
        return {
          status: "rejected",
          reason: "guardrail_failure",
          recorded_count: recordedCount,
        };
      }

      if (!released) {
        return {
          status: "rejected",
          reason: "guardrail_failure",
          recorded_count: recordedCount,
        };
      }

      return {
        status: "rejected",
        reason: "enqueue_failed",
        recorded_count: recordedCount,
      };
    }
  }

  return {
    status: "ok",
    recorded_count: recordedCount,
  };
}
