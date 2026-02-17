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
  session_id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SESSION_ID_REGEX),
  source: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(UsageSourceSchema),
  ts: z.string().datetime(),
  libraries: z.array(LibraryUsagePayloadSchema).min(1).max(MAX_LIBRARIES_PER_CALL),
});

export const LogLibraryUsageOutputSchema = z.object({
  status: z.enum(["ok", "rejected"]),
  recorded_count: z.number().int().nonnegative().optional(),
  reason: z
    .enum([
      "invalid_payload",
      "too_many_libraries",
      "no_libraries",
      "rate_limited",
      "duplicate_event",
    ])
    .optional(),
});

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

export type EnqueueLibraryUsageEvent = (
  event: LibraryUsageLoggedEvent
) => Promise<void> | void;

export type LogLibraryUsageOptions = {
  enqueueEvent?: EnqueueLibraryUsageEvent;
  replayWindowMs?: number;
  rateLimitWindowMs?: number;
  maxRequestsPerWindow?: number;
  maxLibrariesPerWindow?: number;
  now?: () => number;
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

function getRejectionReason(error: z.ZodError): "invalid_payload" | "too_many_libraries" | "no_libraries" {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid_payload";
  }

  if (
    firstIssue.path.length === 1 &&
    firstIssue.path[0] === "libraries" &&
    firstIssue.code === "too_big"
  ) {
    return "too_many_libraries";
  }

  if (
    firstIssue.path.length === 1 &&
    firstIssue.path[0] === "libraries" &&
    firstIssue.code === "too_small"
  ) {
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

function fingerprintEvent(event: LibraryUsageLoggedEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export async function logLibraryUsage(
  input: unknown,
  options: LogLibraryUsageOptions = {}
): Promise<LogLibraryUsageOutput> {
  const nowMs = options.now?.() ?? Date.now();
  const replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxRequestsPerWindow =
    options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxLibrariesPerWindow =
    options.maxLibrariesPerWindow ?? DEFAULT_MAX_LIBRARIES_PER_WINDOW;

  cleanupReplayCache(nowMs, replayWindowMs);
  cleanupRateLimitState(nowMs, rateLimitWindowMs);

  const parsedInput = LogLibraryUsageInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "rejected",
      reason: getRejectionReason(parsedInput.error),
    };
  }

  const enqueueEvent = options.enqueueEvent ?? defaultEnqueueLibraryUsageEvent;

  const allowedByRateLimit = checkAndConsumeRateLimit(
    parsedInput.data.session_id,
    parsedInput.data.libraries.length,
    nowMs,
    rateLimitWindowMs,
    maxRequestsPerWindow,
    maxLibrariesPerWindow
  );

  if (!allowedByRateLimit) {
    return {
      status: "rejected",
      reason: "rate_limited",
    };
  }

  const normalizedEvents = parsedInput.data.libraries.map((library) => ({
    session_id: parsedInput.data.session_id,
    source: parsedInput.data.source,
    ts: parsedInput.data.ts,
    library,
  }));

  for (const event of normalizedEvents) {
    const fingerprint = fingerprintEvent(event);
    if (replayCache.has(fingerprint)) {
      return {
        status: "rejected",
        reason: "duplicate_event",
      };
    }
  }

  for (const event of normalizedEvents) {
    const fingerprint = fingerprintEvent(event);
    replayCache.set(fingerprint, nowMs);
  }

  for (const library of parsedInput.data.libraries) {
    await enqueueEvent({
      session_id: parsedInput.data.session_id,
      source: parsedInput.data.source,
      ts: parsedInput.data.ts,
      library,
    });
  }

  return {
    status: "ok",
    recorded_count: parsedInput.data.libraries.length,
  };
}
