import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PeriodSchema } from "../domain/index.js";
import {
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

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const RoyaltyCycleAuditEventTypeSchema = z.enum([
  "cycle_no_usage",
  "allocation_proposal_persisted",
  "payout_approval_required",
  "payout_approval_resolved",
  "payout_anomaly_detected",
  "payout_execution_skipped",
  "payout_execution_executed",
]);

export const RoyaltyCycleAuditPayloadSchema = z.record(z.string().min(1), z.unknown());

export const RoyaltyCycleAuditRecordSchema = z.object({
  event_id: z.string().min(1),
  period: PeriodSchema,
  run_id: z.string().min(1),
  event_type: RoyaltyCycleAuditEventTypeSchema,
  payload: RoyaltyCycleAuditPayloadSchema,
  payload_hash: HashSchema,
  previous_event_hash: HashSchema.nullable(),
  event_hash: HashSchema,
  observed_at: z.string().datetime(),
});

export const AppendRoyaltyCycleAuditEventInputSchema = z.object({
  period: PeriodSchema,
  run_id: z.string().min(1),
  event_type: RoyaltyCycleAuditEventTypeSchema,
  payload: RoyaltyCycleAuditPayloadSchema.default({}),
});

export const AppendRoyaltyCycleAuditEventOutputSchema = z.object({
  status: z.literal("recorded"),
  event_id: z.string().min(1),
  period: PeriodSchema,
  run_id: z.string().min(1),
  event_hash: HashSchema,
  previous_event_hash: HashSchema.nullable(),
  observed_at: z.string().datetime(),
});

export const VerifyRoyaltyCycleAuditTrailOutputSchema = z.object({
  status: z.enum(["valid", "invalid"]),
  period: PeriodSchema,
  checked_events: z.number().int().nonnegative(),
  reason: z.string().min(1).optional(),
});

export type RoyaltyCycleAuditEventType = z.infer<
  typeof RoyaltyCycleAuditEventTypeSchema
>;
export type RoyaltyCycleAuditPayload = z.infer<typeof RoyaltyCycleAuditPayloadSchema>;
export type RoyaltyCycleAuditRecord = z.infer<typeof RoyaltyCycleAuditRecordSchema>;
export type AppendRoyaltyCycleAuditEventInput = z.infer<
  typeof AppendRoyaltyCycleAuditEventInputSchema
>;
export type AppendRoyaltyCycleAuditEventOutput = z.infer<
  typeof AppendRoyaltyCycleAuditEventOutputSchema
>;
export type VerifyRoyaltyCycleAuditTrailOutput = z.infer<
  typeof VerifyRoyaltyCycleAuditTrailOutputSchema
>;

export type RoyaltyCycleAuditStore = {
  readLatestByPeriod:
    (period: string) => Promise<RoyaltyCycleAuditRecord | null> | RoyaltyCycleAuditRecord | null;
  appendRecord: (record: RoyaltyCycleAuditRecord) => Promise<void> | void;
  readByPeriod:
    (period: string) => Promise<RoyaltyCycleAuditRecord[]> | RoyaltyCycleAuditRecord[];
  clear?: () => Promise<void> | void;
};

type AppendRoyaltyCycleAuditEventOptions = {
  store?: RoyaltyCycleAuditStore;
  now?: () => number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
  eventIdGenerator?: (period: string, runId: string, nowMs: number) => string;
};

const inMemoryAuditRecordsByPeriod = new Map<string, RoyaltyCycleAuditRecord[]>();

function cloneAuditRecord(record: RoyaltyCycleAuditRecord): RoyaltyCycleAuditRecord {
  return {
    ...record,
    payload: { ...record.payload },
  };
}

const inMemoryRoyaltyCycleAuditStore: RoyaltyCycleAuditStore = {
  readLatestByPeriod(period: string): RoyaltyCycleAuditRecord | null {
    const events = inMemoryAuditRecordsByPeriod.get(period);
    if (!events || events.length === 0) {
      return null;
    }
    const latest = events[events.length - 1];
    return latest ? cloneAuditRecord(latest) : null;
  },

  appendRecord(record: RoyaltyCycleAuditRecord): void {
    const current = inMemoryAuditRecordsByPeriod.get(record.period) ?? [];
    current.push(cloneAuditRecord(record));
    inMemoryAuditRecordsByPeriod.set(record.period, current);
  },

  readByPeriod(period: string): RoyaltyCycleAuditRecord[] {
    const records = inMemoryAuditRecordsByPeriod.get(period) ?? [];
    return records.map((record) => cloneAuditRecord(record));
  },

  clear(): void {
    inMemoryAuditRecordsByPeriod.clear();
  },
};

function defaultEventIdGenerator(period: string, runId: string, nowMs: number): string {
  const digest = createHash("sha256")
    .update("royalty-cycle-audit:")
    .update(period)
    .update(":")
    .update(runId)
    .update(":")
    .update(String(nowMs))
    .update(":")
    .update(randomUUID())
    .digest("hex");
  return `rca_${digest.slice(0, 24)}`;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForHash(entry));
  }
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort((left, right) =>
      left.localeCompare(right)
    );
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      normalized[key] = normalizeForHash(objectValue[key]);
    }
    return normalized;
  }
  return value;
}

function computePayloadHash(payload: RoyaltyCycleAuditPayload): string {
  const normalizedPayload = normalizeForHash(payload);
  return createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");
}

function computeEventHash(input: {
  eventId: string;
  period: string;
  runId: string;
  eventType: RoyaltyCycleAuditEventType;
  payloadHash: string;
  previousEventHash: string | null;
  observedAt: string;
}): string {
  return createHash("sha256")
    .update(input.eventId)
    .update(":")
    .update(input.period)
    .update(":")
    .update(input.runId)
    .update(":")
    .update(input.eventType)
    .update(":")
    .update(input.payloadHash)
    .update(":")
    .update(input.previousEventHash ?? "null")
    .update(":")
    .update(input.observedAt)
    .digest("hex");
}

export function clearInMemoryRoyaltyCycleAudits(): void {
  inMemoryAuditRecordsByPeriod.clear();
}

export function getInMemoryRoyaltyCycleAuditsByPeriod(
  period: string
): RoyaltyCycleAuditRecord[] {
  return (inMemoryAuditRecordsByPeriod.get(period) ?? []).map((record) =>
    cloneAuditRecord(record)
  );
}

export function getInMemoryRoyaltyCycleAudits(): RoyaltyCycleAuditRecord[] {
  const periods = [...inMemoryAuditRecordsByPeriod.keys()].sort((left, right) =>
    left.localeCompare(right)
  );
  const allRecords: RoyaltyCycleAuditRecord[] = [];
  for (const period of periods) {
    const periodRecords = inMemoryAuditRecordsByPeriod.get(period) ?? [];
    for (const record of periodRecords) {
      allRecords.push(cloneAuditRecord(record));
    }
  }
  return allRecords;
}

export function verifyRoyaltyCycleAuditTrail(period: string): VerifyRoyaltyCycleAuditTrailOutput {
  PeriodSchema.parse(period);
  const events = getInMemoryRoyaltyCycleAuditsByPeriod(period);
  let previousHash: string | null = null;

  for (const event of events) {
    if (event.previous_event_hash !== previousHash) {
      return {
        status: "invalid",
        period,
        checked_events: events.length,
        reason: `hash chain mismatch at event ${event.event_id}`,
      };
    }

    const expectedPayloadHash = computePayloadHash(event.payload);
    if (expectedPayloadHash !== event.payload_hash) {
      return {
        status: "invalid",
        period,
        checked_events: events.length,
        reason: `payload hash mismatch at event ${event.event_id}`,
      };
    }

    const expectedEventHash = computeEventHash({
      eventId: event.event_id,
      period: event.period,
      runId: event.run_id,
      eventType: event.event_type,
      payloadHash: event.payload_hash,
      previousEventHash: event.previous_event_hash,
      observedAt: event.observed_at,
    });
    if (expectedEventHash !== event.event_hash) {
      return {
        status: "invalid",
        period,
        checked_events: events.length,
        reason: `event hash mismatch at event ${event.event_id}`,
      };
    }

    previousHash = event.event_hash;
  }

  return {
    status: "valid",
    period,
    checked_events: events.length,
  };
}

export async function appendRoyaltyCycleAuditEvent(
  input: unknown,
  options: AppendRoyaltyCycleAuditEventOptions = {}
): Promise<AppendRoyaltyCycleAuditEventOutput> {
  assertToolAuthorized({
    toolName: "append_royalty_cycle_audit",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "append_royalty_cycle_audit",
    maxAllowedRisk: options.maxAllowedRisk ?? "medium",
  });
  assertToolInputVetting("append_royalty_cycle_audit", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = AppendRoyaltyCycleAuditEventInputSchema.parse(input);
  const store = options.store ?? inMemoryRoyaltyCycleAuditStore;
  const nowMs = options.now?.() ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const latest = await store.readLatestByPeriod(parsedInput.period);
  const previousEventHash = latest?.event_hash ?? null;

  const payloadHash = computePayloadHash(parsedInput.payload);
  const eventIdGenerator = options.eventIdGenerator ?? defaultEventIdGenerator;
  const eventId = eventIdGenerator(parsedInput.period, parsedInput.run_id, nowMs);
  const eventHash = computeEventHash({
    eventId,
    period: parsedInput.period,
    runId: parsedInput.run_id,
    eventType: parsedInput.event_type,
    payloadHash,
    previousEventHash,
    observedAt,
  });

  const record: RoyaltyCycleAuditRecord = {
    event_id: eventId,
    period: parsedInput.period,
    run_id: parsedInput.run_id,
    event_type: parsedInput.event_type,
    payload: parsedInput.payload,
    payload_hash: payloadHash,
    previous_event_hash: previousEventHash,
    event_hash: eventHash,
    observed_at: observedAt,
  };
  await store.appendRecord(record);

  const output: AppendRoyaltyCycleAuditEventOutput = {
    status: "recorded",
    event_id: eventId,
    period: parsedInput.period,
    run_id: parsedInput.run_id,
    event_hash: eventHash,
    previous_event_hash: previousEventHash,
    observed_at: observedAt,
  };
  assertToolOutputSanity("append_royalty_cycle_audit", output);
  return output;
}
