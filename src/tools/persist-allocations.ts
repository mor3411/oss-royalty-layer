import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
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
import {
  AllocationProposalSchema,
  AppliedAllocationPolicySchema,
} from "./compute-allocations.js";
import { validateAllocationConstraints } from "./allocation-constraints.js";

const SAFE_INTEGER_SCHEMA = z.number().int().safe();
const PeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const PayloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const MAX_IN_MEMORY_PERSISTED_ALLOCATION_RECORDS = 5_000;
export const MAX_IN_MEMORY_ALLOCATION_PERSISTENCE_AUDITS = 20_000;

export const PersistAllocationsInputSchema = z.object({
  period: PeriodSchema,
  pool_amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  policy_applied: AppliedAllocationPolicySchema,
  allocations: z.array(AllocationProposalSchema).min(1),
  notes: z.string().min(1),
});

export const PersistedAllocationRecordSchema = z.object({
  record_id: z.string().min(1),
  period: PeriodSchema,
  pool_amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  policy_applied: AppliedAllocationPolicySchema,
  allocations: z.array(AllocationProposalSchema).min(1),
  notes: z.string().min(1),
  payload_hash: PayloadHashSchema,
  persisted_at: z.string().datetime(),
});

export const AllocationPersistenceAuditSchema = z.object({
  audit_event_id: z.string().min(1),
  period: PeriodSchema,
  action: z.enum(["created", "duplicate_ignored"]),
  record_id: z.string().min(1),
  payload_conflict: z.boolean(),
  incoming_payload_hash: PayloadHashSchema,
  existing_payload_hash: PayloadHashSchema,
  observed_at: z.string().datetime(),
});

export const PersistAllocationsOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    period: PeriodSchema,
    record_id: z.string().min(1),
    persisted_at: z.string().datetime(),
    saved_count: SAFE_INTEGER_SCHEMA.positive(),
    audit_event_id: z.string().min(1),
  }),
  z.object({
    status: z.literal("already_exists"),
    period: PeriodSchema,
    record_id: z.string().min(1),
    persisted_at: z.string().datetime(),
    saved_count: z.literal(0),
    duplicate_conflict: z.boolean(),
    audit_event_id: z.string().min(1),
  }),
]);

export type PersistAllocationsInput = z.infer<typeof PersistAllocationsInputSchema>;
export type PersistedAllocationRecord = z.infer<typeof PersistedAllocationRecordSchema>;
export type AllocationPersistenceAudit = z.infer<typeof AllocationPersistenceAuditSchema>;
export type PersistAllocationsOutput = z.infer<typeof PersistAllocationsOutputSchema>;

export type AllocationPersistenceStore = {
  readByPeriod:
    (period: string) =>
      | Promise<PersistedAllocationRecord | null>
      | PersistedAllocationRecord
      | null;
  appendRecord: (record: PersistedAllocationRecord) => Promise<void> | void;
  appendAudit: (audit: AllocationPersistenceAudit) => Promise<void> | void;
  readAllRecords?: () => Promise<PersistedAllocationRecord[]> | PersistedAllocationRecord[];
  readAllAudits?: () => Promise<AllocationPersistenceAudit[]> | AllocationPersistenceAudit[];
  clear?: () => Promise<void> | void;
};

type PersistAllocationsOptions = {
  store?: AllocationPersistenceStore;
  now?: () => number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
  recordIdGenerator?: (period: string, payloadHash: string, nowMs: number) => string;
  auditEventIdGenerator?: (
    action: "created" | "duplicate_ignored",
    period: string,
    payloadHash: string,
    nowMs: number
  ) => string;
};

type PersistAllocationsHashablePayload = {
  period: string;
  pool_amount_minor: number;
  policy_applied: z.infer<typeof AppliedAllocationPolicySchema>;
  allocations: Array<z.infer<typeof AllocationProposalSchema>>;
  notes: string;
};

const inMemoryRecordsByPeriod = new Map<string, PersistedAllocationRecord>();
const inMemoryAllocationPersistenceAudits: AllocationPersistenceAudit[] = [];

function cloneAllocationRecord(record: PersistedAllocationRecord): PersistedAllocationRecord {
  return {
    ...record,
    policy_applied: { ...record.policy_applied },
    allocations: record.allocations.map((allocation) => ({
      ...allocation,
      flags: [...allocation.flags],
    })),
  };
}

function cloneAudit(audit: AllocationPersistenceAudit): AllocationPersistenceAudit {
  return { ...audit };
}

const inMemoryAllocationPersistenceStore: AllocationPersistenceStore = {
  readByPeriod(period: string): PersistedAllocationRecord | null {
    const record = inMemoryRecordsByPeriod.get(period);
    return record ? cloneAllocationRecord(record) : null;
  },

  appendRecord(record: PersistedAllocationRecord): void {
    if (inMemoryRecordsByPeriod.has(record.period)) {
      throw new Error(`allocation record for period ${record.period} already exists`);
    }

    while (inMemoryRecordsByPeriod.size >= MAX_IN_MEMORY_PERSISTED_ALLOCATION_RECORDS) {
      const oldestPeriod = inMemoryRecordsByPeriod.keys().next().value;
      if (!oldestPeriod) {
        break;
      }
      inMemoryRecordsByPeriod.delete(oldestPeriod);
    }
    inMemoryRecordsByPeriod.set(record.period, cloneAllocationRecord(record));
  },

  appendAudit(audit: AllocationPersistenceAudit): void {
    while (
      inMemoryAllocationPersistenceAudits.length >=
      MAX_IN_MEMORY_ALLOCATION_PERSISTENCE_AUDITS
    ) {
      inMemoryAllocationPersistenceAudits.shift();
    }
    inMemoryAllocationPersistenceAudits.push(cloneAudit(audit));
  },

  readAllRecords(): PersistedAllocationRecord[] {
    return [...inMemoryRecordsByPeriod.values()].map((record) => cloneAllocationRecord(record));
  },

  readAllAudits(): AllocationPersistenceAudit[] {
    return inMemoryAllocationPersistenceAudits.map((audit) => cloneAudit(audit));
  },

  clear(): void {
    inMemoryRecordsByPeriod.clear();
    inMemoryAllocationPersistenceAudits.length = 0;
  },
};

function defaultRecordIdGenerator(period: string, payloadHash: string, nowMs: number): string {
  const digest = createHash("sha256")
    .update("allocation-record:")
    .update(period)
    .update(":")
    .update(payloadHash)
    .update(":")
    .update(String(nowMs))
    .digest("hex");
  return `alr_${digest.slice(0, 24)}`;
}

function defaultAuditEventIdGenerator(
  action: "created" | "duplicate_ignored",
  period: string,
  payloadHash: string,
  nowMs: number
): string {
  const digest = createHash("sha256")
    .update("allocation-audit:")
    .update(action)
    .update(":")
    .update(period)
    .update(":")
    .update(payloadHash)
    .update(":")
    .update(String(nowMs))
    .update(":")
    .update(randomUUID())
    .digest("hex");
  return `ala_${digest.slice(0, 24)}`;
}

function buildHashablePayload(
  input: PersistAllocationsInput
): PersistAllocationsHashablePayload {
  const normalizedAllocations = input.allocations
    .map((allocation) => ({
      library_id: allocation.library_id,
      maintainer_id: allocation.maintainer_id,
      amount_minor: allocation.amount_minor,
      confidence_score: allocation.confidence_score,
      flags: [...allocation.flags].sort(),
    }))
    .sort((left, right) => {
      const byLibrary = left.library_id.localeCompare(right.library_id);
      if (byLibrary !== 0) {
        return byLibrary;
      }
      return left.maintainer_id.localeCompare(right.maintainer_id);
    });

  return {
    period: input.period,
    pool_amount_minor: input.pool_amount_minor,
    policy_applied: {
      configured_max_share_per_library:
        input.policy_applied.configured_max_share_per_library,
      effective_max_share_per_library:
        input.policy_applied.effective_max_share_per_library,
      min_floor_amount_minor: input.policy_applied.min_floor_amount_minor,
      long_tail_weight: input.policy_applied.long_tail_weight,
    },
    allocations: normalizedAllocations,
    notes: input.notes,
  };
}

function computePayloadHash(payload: PersistAllocationsHashablePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function clearInMemoryPersistedAllocations(): void {
  inMemoryRecordsByPeriod.clear();
  inMemoryAllocationPersistenceAudits.length = 0;
}

export function getInMemoryPersistedAllocations(): PersistedAllocationRecord[] {
  return [...inMemoryRecordsByPeriod.values()].map((record) => cloneAllocationRecord(record));
}

export function getInMemoryPersistedAllocationByPeriod(
  period: string
): PersistedAllocationRecord | null {
  const record = inMemoryRecordsByPeriod.get(period);
  return record ? cloneAllocationRecord(record) : null;
}

export function getInMemoryAllocationPersistenceAudits(): AllocationPersistenceAudit[] {
  return inMemoryAllocationPersistenceAudits.map((audit) => cloneAudit(audit));
}

export async function persistAllocations(
  input: unknown,
  options: PersistAllocationsOptions = {}
): Promise<PersistAllocationsOutput> {
  assertToolAuthorized({
    toolName: "persist_allocations",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "persist_allocations",
    ...(options.maxAllowedRisk === undefined
      ? {}
      : { maxAllowedRisk: options.maxAllowedRisk }),
  });
  assertToolInputVetting("persist_allocations", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = PersistAllocationsInputSchema.parse(input);
  const hashablePayload = buildHashablePayload(parsedInput);
  const payloadHash = computePayloadHash(hashablePayload);

  const constraintResult = validateAllocationConstraints(
    {
      pool_amount_minor: parsedInput.pool_amount_minor,
      max_share_per_library: parsedInput.policy_applied.effective_max_share_per_library,
      allocations: parsedInput.allocations.map((allocation) => ({
        library_id: allocation.library_id,
        maintainer_id: allocation.maintainer_id,
        amount_minor: allocation.amount_minor,
      })),
    },
    {
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestAuthBypass: options.allowTestAuthBypass }),
    }
  );
  if (constraintResult.status !== "valid") {
    const details = constraintResult.violations
      .map((violation) => violation.message)
      .join("; ");
    throw new Error(`allocation persistence rejected invalid constraints: ${details}`);
  }

  const store = options.store ?? inMemoryAllocationPersistenceStore;
  const nowMs = options.now?.() ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const recordIdGenerator = options.recordIdGenerator ?? defaultRecordIdGenerator;
  const auditEventIdGenerator =
    options.auditEventIdGenerator ?? defaultAuditEventIdGenerator;

  const existingRecord = await store.readByPeriod(parsedInput.period);
  if (existingRecord) {
    const payloadConflict = existingRecord.payload_hash !== payloadHash;
    const auditEventId = auditEventIdGenerator(
      "duplicate_ignored",
      parsedInput.period,
      payloadHash,
      nowMs
    );
    await store.appendAudit({
      audit_event_id: auditEventId,
      period: parsedInput.period,
      action: "duplicate_ignored",
      record_id: existingRecord.record_id,
      payload_conflict: payloadConflict,
      incoming_payload_hash: payloadHash,
      existing_payload_hash: existingRecord.payload_hash,
      observed_at: observedAt,
    });

    const output: PersistAllocationsOutput = {
      status: "already_exists",
      period: existingRecord.period,
      record_id: existingRecord.record_id,
      persisted_at: existingRecord.persisted_at,
      saved_count: 0,
      duplicate_conflict: payloadConflict,
      audit_event_id: auditEventId,
    };
    assertToolOutputSanity("persist_allocations", output);
    return output;
  }

  const recordId = recordIdGenerator(parsedInput.period, payloadHash, nowMs);
  const record: PersistedAllocationRecord = {
    record_id: recordId,
    period: parsedInput.period,
    pool_amount_minor: parsedInput.pool_amount_minor,
    policy_applied: parsedInput.policy_applied,
    allocations: parsedInput.allocations,
    notes: parsedInput.notes,
    payload_hash: payloadHash,
    persisted_at: observedAt,
  };
  await store.appendRecord(record);

  const auditEventId = auditEventIdGenerator("created", parsedInput.period, payloadHash, nowMs);
  await store.appendAudit({
    audit_event_id: auditEventId,
    period: parsedInput.period,
    action: "created",
    record_id: recordId,
    payload_conflict: false,
    incoming_payload_hash: payloadHash,
    existing_payload_hash: payloadHash,
    observed_at: observedAt,
  });

  const output: PersistAllocationsOutput = {
    status: "ok",
    period: parsedInput.period,
    record_id: recordId,
    persisted_at: observedAt,
    saved_count: parsedInput.allocations.length,
    audit_event_id: auditEventId,
  };
  assertToolOutputSanity("persist_allocations", output);
  return output;
}
