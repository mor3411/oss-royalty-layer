import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  RESERVED_PRINCIPAL_IDS,
  assertToolAuthorized,
  type AuthorizationRuntimeEnvironment,
} from "./authz.js";
import {
  DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  assertToolInputVetting,
  assertToolOutputSanity,
  assertToolRiskAllowed,
  type ToolRiskLevel,
} from "./guardrails.js";

import { EcosystemSchema, UsageSourceSchema } from "../domain/index.js";

export const MAX_LIBRARIES_PER_CALL = 1000;
export const MAX_IN_MEMORY_EVENTS = 10_000;
export const MAX_IN_MEMORY_REJECTION_AUDITS = 10_000;
export const MAX_REPLAY_CACHE_ENTRIES = 50_000;
export const MAX_RATE_LIMIT_ENTRIES = 20_000;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_MAX_REQUESTS_PER_WINDOW = 60;
export const DEFAULT_MAX_LIBRARIES_PER_WINDOW = 10_000;
export const IN_MEMORY_CLEANUP_INTERVAL_MS = 1_000;
export const DEFAULT_REJECTION_AUDIT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REJECTION_AUDIT_LOG_PATH = ".data/library-usage-rejection-audits.ndjson";
export const DEFAULT_REJECTION_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_REJECTION_AUDIT_MAX_FILES = 5;
export const DEFAULT_INVALID_REJECTION_AUDIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_MAX_INVALID_REJECTION_AUDITS_PER_WINDOW = 200;

const SESSION_ID_REGEX = /^[a-f0-9]{32,128}$/;
const RuntimeEnvironmentSchema = z.enum(["development", "test", "production"]);
const AuditSinkFailureModeSchema = z.enum(["fail_open", "fail_closed"]);
const SAFE_INTEGER_SCHEMA = z.number().int().safe();
const THROTTLED_REJECTION_REASONS = new Set<string>([
  "invalid_payload",
  "too_many_libraries",
  "no_libraries",
]);

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
  calls: SAFE_INTEGER_SCHEMA.nonnegative(),
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
  "authorization_failed",
]);

export const LibraryUsageRejectionAuditSchema = z.object({
  observed_at: z.string().datetime(),
  runtime_environment: RuntimeEnvironmentSchema,
  reason: LogLibraryUsageRejectionReasonSchema,
  session_id: z.string().optional(),
  source: z.string().optional(),
  ts: z.string().optional(),
  libraries_count: z.number().int().nonnegative().optional(),
  candidate_events_count: z.number().int().nonnegative().optional(),
  recorded_count: z.number().int().nonnegative().optional(),
});

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
export type LogLibraryUsageRejectionReason = z.infer<typeof LogLibraryUsageRejectionReasonSchema>;
export type LibraryUsageRejectionAudit = z.infer<typeof LibraryUsageRejectionAuditSchema>;

export type EnqueueLibraryUsageEvent = (event: LibraryUsageLoggedEvent) => Promise<void> | void;
export type AuditLibraryUsageRejection = (
  event: LibraryUsageRejectionAudit
) => Promise<void> | void;

export type LogLibraryUsageOptions = {
  enqueueEvent?: EnqueueLibraryUsageEvent;
  replayWindowMs?: number;
  rateLimitWindowMs?: number;
  maxRequestsPerWindow?: number;
  maxLibrariesPerWindow?: number;
  now?: () => number;
  replayProtection?: ReplayProtection;
  rateLimiter?: SessionRateLimiter;
  auditRejection?: AuditLibraryUsageRejection;
  rejectionAuditFilePath?: string;
  rejectionAuditMaxBytes?: number;
  rejectionAuditMaxFiles?: number;
  auditSinkFailureMode?: "fail_open" | "fail_closed";
  invalidRejectionAuditWindowMs?: number;
  maxInvalidRejectionAuditsPerWindow?: number;
  maxGuardrailInputBytes?: number;
  maxAllowedRisk?: ToolRiskLevel;
  allowInMemoryGuardsInProduction?: boolean;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  principal?: unknown;
  allowTestAuthBypass?: boolean;
};

const inMemoryLibraryUsageEvents: LibraryUsageLoggedEvent[] = [];
const inMemoryLibraryUsageRejectionAudits: LibraryUsageRejectionAudit[] = [];
const replayCache = new Map<string, number>();
let lastReplayCacheCleanupMs = Number.NEGATIVE_INFINITY;
let lastRejectionAuditCleanupMs = Number.NEGATIVE_INFINITY;
const throttledRejectionAuditCounters = new Map<string, { windowStartMs: number; count: number }>();
const sessionRateLimitState = new Map<
  string,
  {
    windowStartMs: number;
    requests: number;
    libraries: number;
  }
>();
let lastRateLimitCleanupMs = Number.NEGATIVE_INFINITY;

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
  inMemoryLibraryUsageRejectionAudits.length = 0;
  replayCache.clear();
  lastReplayCacheCleanupMs = Number.NEGATIVE_INFINITY;
  lastRejectionAuditCleanupMs = Number.NEGATIVE_INFINITY;
  throttledRejectionAuditCounters.clear();
  sessionRateLimitState.clear();
  lastRateLimitCleanupMs = Number.NEGATIVE_INFINITY;
}

export function getLibraryUsageEvents(): LibraryUsageLoggedEvent[] {
  return [...inMemoryLibraryUsageEvents];
}

export function getLibraryUsageRejectionAudits(): LibraryUsageRejectionAudit[] {
  return [...inMemoryLibraryUsageRejectionAudits];
}

function defaultEnqueueLibraryUsageEvent(event: LibraryUsageLoggedEvent): void {
  while (inMemoryLibraryUsageEvents.length >= MAX_IN_MEMORY_EVENTS) {
    inMemoryLibraryUsageEvents.shift();
  }
  inMemoryLibraryUsageEvents.push(event);
}

function defaultAuditLibraryUsageRejection(event: LibraryUsageRejectionAudit): void {
  cleanupRejectionAuditStore(Date.parse(event.observed_at), DEFAULT_REJECTION_AUDIT_TTL_MS);

  while (inMemoryLibraryUsageRejectionAudits.length >= MAX_IN_MEMORY_REJECTION_AUDITS) {
    inMemoryLibraryUsageRejectionAudits.shift();
  }
  inMemoryLibraryUsageRejectionAudits.push(event);
}

function cleanupRejectionAuditStore(nowMs: number, ttlMs: number): void {
  if (nowMs - lastRejectionAuditCleanupMs < IN_MEMORY_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastRejectionAuditCleanupMs = nowMs;

  const retained = inMemoryLibraryUsageRejectionAudits.filter((audit) => {
    const observedAtMs = Date.parse(audit.observed_at);
    return nowMs - observedAtMs <= ttlMs;
  });
  inMemoryLibraryUsageRejectionAudits.splice(
    0,
    inMemoryLibraryUsageRejectionAudits.length,
    ...retained
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isAuditSinkCapacityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}

async function rotateAuditFileIfNeeded(
  filePath: string,
  maxBytes: number,
  maxFiles: number
): Promise<void> {
  let currentFileSize = 0;
  try {
    const fileStats = await stat(filePath);
    currentFileSize = fileStats.size;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (currentFileSize < maxBytes) {
    return;
  }

  if (maxFiles <= 1) {
    await unlink(filePath).catch((error) => {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
    return;
  }

  const oldestBackupPath = `${filePath}.${maxFiles - 1}`;
  await unlink(oldestBackupPath).catch((error) => {
    if (!isErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });

  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const sourcePath = `${filePath}.${index}`;
    const destinationPath = `${filePath}.${index + 1}`;
    await rename(sourcePath, destinationPath).catch((error) => {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
  }

  await rename(filePath, `${filePath}.1`);
}

function shouldAuditRejectedEvent(
  reason: LogLibraryUsageRejectionReason,
  nowMs: number,
  windowMs: number,
  maxEventsPerWindow: number
): boolean {
  if (!THROTTLED_REJECTION_REASONS.has(reason)) {
    return true;
  }

  const existingCounter = throttledRejectionAuditCounters.get(reason);
  if (!existingCounter || nowMs - existingCounter.windowStartMs >= windowMs) {
    throttledRejectionAuditCounters.set(reason, { windowStartMs: nowMs, count: 1 });
    return true;
  }

  if (existingCounter.count >= maxEventsPerWindow) {
    return false;
  }

  existingCounter.count += 1;
  return true;
}

function createNdjsonAuditSink(
  filePath: string,
  options: {
    maxBytes: number;
    maxFiles: number;
  }
): AuditLibraryUsageRejection {
  return async (event: LibraryUsageRejectionAudit) => {
    await mkdir(dirname(filePath), { recursive: true });
    await rotateAuditFileIfNeeded(filePath, options.maxBytes, options.maxFiles);
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  };
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
  if (nowMs - lastReplayCacheCleanupMs < IN_MEMORY_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastReplayCacheCleanupMs = nowMs;

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
  if (nowMs - lastRateLimitCleanupMs < IN_MEMORY_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastRateLimitCleanupMs = nowMs;

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

function toAuditSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SESSION_ID_REGEX.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function toAuditSource(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!UsageSourceSchema.safeParse(normalized).success) {
    return undefined;
  }
  return normalized;
}

function toAuditTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!z.string().datetime().safeParse(value).success) {
    return undefined;
  }
  return value;
}

function toAuditLibraryCount(value: unknown): number | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.length;
}

function resolveRuntimeEnvironment(
  override: LogLibraryUsageOptions["runtimeEnvironment"]
): "development" | "test" | "production" {
  const parsedEnvironment = RuntimeEnvironmentSchema.safeParse(process.env.NODE_ENV);
  // In production, ignore overrides to prevent environment downgrade attacks.
  if (parsedEnvironment.success && parsedEnvironment.data === "production") {
    return "production";
  }
  if (override) {
    return override;
  }
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
  const finalizeOutput = (output: LogLibraryUsageOutput): LogLibraryUsageOutput => {
    try {
      assertToolOutputSanity("log_library_usage", output);
      return output;
    } catch {
      return {
        status: "rejected",
        reason: "guardrail_failure",
        ...(output.status === "rejected" && output.recorded_count !== undefined
          ? { recorded_count: output.recorded_count }
          : {}),
      };
    }
  };

  const nowMs = options.now?.() ?? Date.now();
  const replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxRequestsPerWindow = options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxLibrariesPerWindow = options.maxLibrariesPerWindow ?? DEFAULT_MAX_LIBRARIES_PER_WINDOW;
  const rejectionAuditMaxBytes = options.rejectionAuditMaxBytes ?? DEFAULT_REJECTION_AUDIT_MAX_BYTES;
  const rejectionAuditMaxFiles = options.rejectionAuditMaxFiles ?? DEFAULT_REJECTION_AUDIT_MAX_FILES;
  const invalidRejectionAuditWindowMs =
    options.invalidRejectionAuditWindowMs ?? DEFAULT_INVALID_REJECTION_AUDIT_WINDOW_MS;
  const maxInvalidRejectionAuditsPerWindow =
    options.maxInvalidRejectionAuditsPerWindow ?? DEFAULT_MAX_INVALID_REJECTION_AUDITS_PER_WINDOW;
  const maxGuardrailInputBytes =
    options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES;
  const auditSinkFailureMode = options.auditSinkFailureMode ?? "fail_open";
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnvironment);
  const replayProtection = options.replayProtection ?? inMemoryReplayProtection;
  const rateLimiter = options.rateLimiter ?? inMemorySessionRateLimiter;
  const defaultAuditRejection =
    runtimeEnvironment === "test"
      ? defaultAuditLibraryUsageRejection
      : createNdjsonAuditSink(options.rejectionAuditFilePath ?? DEFAULT_REJECTION_AUDIT_LOG_PATH, {
          maxBytes: rejectionAuditMaxBytes,
          maxFiles: rejectionAuditMaxFiles,
        });
  const auditRejection = options.auditRejection ?? defaultAuditRejection;
  const usesInMemoryGuardrails =
    replayProtection === inMemoryReplayProtection ||
    rateLimiter === inMemorySessionRateLimiter ||
    auditRejection === defaultAuditLibraryUsageRejection;

  const rawAuditContext =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null;

  const defaultAuditContext = {
    sessionId: toAuditSessionId(rawAuditContext?.session_id),
    source: toAuditSource(rawAuditContext?.source),
    timestamp: toAuditTimestamp(rawAuditContext?.ts),
    librariesCount: toAuditLibraryCount(rawAuditContext?.libraries),
  };

  const reject = async (
    reason: LogLibraryUsageRejectionReason,
    context: {
      sessionId?: string;
      source?: string;
      timestamp?: string;
      librariesCount?: number;
      candidateEventsCount?: number;
      recordedCount?: number;
    } = {}
  ): Promise<LogLibraryUsageOutput> => {
    const rejectedOutput: LogLibraryUsageOutput = {
      status: "rejected",
      reason,
      ...(context.recordedCount === undefined ? {} : { recorded_count: context.recordedCount }),
    };
    const shouldAudit = shouldAuditRejectedEvent(
      reason,
      nowMs,
      invalidRejectionAuditWindowMs,
      maxInvalidRejectionAuditsPerWindow
    );
    if (!shouldAudit) {
      return finalizeOutput(rejectedOutput);
    }

    const auditEvent: LibraryUsageRejectionAudit = {
      observed_at: new Date(nowMs).toISOString(),
      runtime_environment: runtimeEnvironment,
      reason,
    };

    const sessionId = context.sessionId ?? defaultAuditContext.sessionId;
    if (sessionId) {
      auditEvent.session_id = sessionId;
    }

    const source = context.source ?? defaultAuditContext.source;
    if (source) {
      auditEvent.source = source;
    }

    const timestamp = context.timestamp ?? defaultAuditContext.timestamp;
    if (timestamp) {
      auditEvent.ts = timestamp;
    }

    const librariesCount = context.librariesCount ?? defaultAuditContext.librariesCount;
    if (librariesCount !== undefined) {
      auditEvent.libraries_count = librariesCount;
    }

    if (context.candidateEventsCount !== undefined) {
      auditEvent.candidate_events_count = context.candidateEventsCount;
    }

    if (context.recordedCount !== undefined) {
      auditEvent.recorded_count = context.recordedCount;
    }

    try {
      await auditRejection(auditEvent);
    } catch (error) {
      if (
        auditSinkFailureMode === "fail_open" &&
        isAuditSinkCapacityError(error)
      ) {
        return finalizeOutput(rejectedOutput);
      }
      return finalizeOutput({
        status: "rejected",
        reason: "guardrail_failure",
        ...(context.recordedCount === undefined ? {} : { recorded_count: context.recordedCount }),
      });
    }

    return finalizeOutput(rejectedOutput);
  };

  try {
    assertToolRiskAllowed({
      toolName: "log_library_usage",
      ...(options.maxAllowedRisk === undefined ? {} : { maxAllowedRisk: options.maxAllowedRisk }),
    });
    assertToolInputVetting("log_library_usage", input, {
      maxBytes: maxGuardrailInputBytes,
    });
  } catch {
    return reject("guardrail_failure");
  }

  if (
    !isPositiveInteger(replayWindowMs) ||
    !isPositiveInteger(rateLimitWindowMs) ||
    !isPositiveInteger(maxRequestsPerWindow) ||
    !isPositiveInteger(maxLibrariesPerWindow) ||
    !isPositiveInteger(rejectionAuditMaxBytes) ||
    !isPositiveInteger(rejectionAuditMaxFiles) ||
    !isPositiveInteger(invalidRejectionAuditWindowMs) ||
    !isPositiveInteger(maxInvalidRejectionAuditsPerWindow) ||
    !isPositiveInteger(maxGuardrailInputBytes) ||
    !AuditSinkFailureModeSchema.safeParse(auditSinkFailureMode).success
  ) {
    return reject("guardrail_failure");
  }

  if (
    runtimeEnvironment === "production" &&
    usesInMemoryGuardrails &&
    !options.allowInMemoryGuardsInProduction
  ) {
    return reject("guardrails_not_configured");
  }

  try {
    const principal = assertToolAuthorized({
      toolName: "log_library_usage",
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      runtimeEnvironment,
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestBypass: options.allowTestAuthBypass }),
    });
    if (
      runtimeEnvironment === "production" &&
      (principal.principal_id === RESERVED_PRINCIPAL_IDS.ANONYMOUS ||
        principal.principal_id === RESERVED_PRINCIPAL_IDS.TEST_AUTH_BYPASS)
    ) {
      return reject("authorization_failed");
    }
  } catch {
    return reject("authorization_failed");
  }

  try {
    await replayProtection.cleanup(nowMs, replayWindowMs);
    await rateLimiter.cleanup(nowMs, rateLimitWindowMs);
  } catch {
    return reject("guardrail_failure");
  }

  const parsedInput = LogLibraryUsageInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return reject(getRejectionReason(parsedInput.error));
  }

  const parsedAuditContext = {
    sessionId: parsedInput.data.session_id,
    source: parsedInput.data.source,
    timestamp: parsedInput.data.ts,
    librariesCount: parsedInput.data.libraries.length,
  };

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
    return reject("guardrail_failure", parsedAuditContext);
  }

  if (candidateEvents.length === 0) {
    return reject("duplicate_event", {
      ...parsedAuditContext,
      candidateEventsCount: 0,
    });
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
    return reject("guardrail_failure", {
      ...parsedAuditContext,
      candidateEventsCount: candidateEvents.length,
    });
  }

  if (!allowedByRateLimit) {
    const released = await releaseReservedFingerprints(
      replayProtection,
      candidateEvents.map((candidate) => candidate.fingerprint)
    );
    if (!released) {
      return reject("guardrail_failure", {
        ...parsedAuditContext,
        candidateEventsCount: candidateEvents.length,
      });
    }
    return reject("rate_limited", {
      ...parsedAuditContext,
      candidateEventsCount: candidateEvents.length,
    });
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
        return reject("guardrail_failure", {
          ...parsedAuditContext,
          candidateEventsCount: candidateEvents.length,
          recordedCount,
        });
      }

      if (!released) {
        return reject("guardrail_failure", {
          ...parsedAuditContext,
          candidateEventsCount: candidateEvents.length,
          recordedCount,
        });
      }

      return reject("enqueue_failed", {
        ...parsedAuditContext,
        candidateEventsCount: candidateEvents.length,
        recordedCount,
      });
    }
  }

  return finalizeOutput({
    status: "ok",
    recorded_count: recordedCount,
  });
}
