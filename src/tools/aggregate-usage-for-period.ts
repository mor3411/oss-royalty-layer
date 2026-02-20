import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertToolAuthorized,
  type AuthorizationRuntimeEnvironment,
} from "./authz.js";
import {
  MAX_GUARDRAIL_AGGREGATE_OUTPUT_ROWS,
  assertToolInputVetting,
  assertToolOutputSanity,
  assertToolRiskAllowed,
  type ToolRiskLevel,
} from "./guardrails.js";

import {
  LibraryUsageLoggedEnvelopeSchema,
  type LibraryUsageEventStore,
} from "./library-usage-ingestion.js";
import { type CanonicalLibraryReference, type LibraryIdResolver, toCanonicalLibraryId } from "./library-registry.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const AGGREGATION_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_AGGREGATION_SNAPSHOTS = 256;
export const MAX_AGGREGATION_SNAPSHOT_ROWS = MAX_GUARDRAIL_AGGREGATE_OUTPUT_ROWS;
const SAFE_INTEGER_SCHEMA = z.number().int().safe();

export const AggregateUsageForPeriodInputSchema = z
  .object({
    period_start: z.string().datetime(),
    period_end: z.string().datetime(),
    cursor: z.string().optional(),
    page_size: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .refine((value) => Date.parse(value.period_end) > Date.parse(value.period_start), {
    message: "period_end must be greater than period_start",
    path: ["period_end"],
  });

export const AggregatedLibraryUsageSchema = z.object({
  library_id: z.string().min(1),
  total_calls: SAFE_INTEGER_SCHEMA.nonnegative(),
  unique_sessions: SAFE_INTEGER_SCHEMA.nonnegative(),
});

export const AggregateUsageForPeriodOutputSchema = z.object({
  aggregates: z.array(AggregatedLibraryUsageSchema),
  next_cursor: z.string().optional(),
});

export type AggregateUsageForPeriodInput = z.infer<typeof AggregateUsageForPeriodInputSchema>;
export type AggregatedLibraryUsage = z.infer<typeof AggregatedLibraryUsageSchema>;
export type AggregateUsageForPeriodOutput = z.infer<typeof AggregateUsageForPeriodOutputSchema>;

type AggregateUsageForPeriodOptions = {
  eventStore: LibraryUsageEventStore;
  resolveLibraryId?: LibraryIdResolver;
  now?: () => number;
  maxAllowedRisk?: ToolRiskLevel;
  maxAggregationPeriodDays?: number;
  maxSnapshotRows?: number;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
};

type AggregationCursor = {
  snapshot_id: string;
  offset: number;
  query_hash: string;
};

type AggregationSnapshot = {
  aggregates: AggregatedLibraryUsage[];
  expiresAtMs: number;
  queryHash: string;
};

const aggregationSnapshotStore = new Map<string, AggregationSnapshot>();

function encodeCursor(cursor: AggregationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function computeQueryHash(periodStart: string, periodEnd: string): string {
  return createHash("sha256").update(periodStart).update(":").update(periodEnd).digest("hex");
}

function decodeCursor(cursor: string): AggregationCursor {
  let parsedValue: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    parsedValue = JSON.parse(decoded);
  } catch {
    throw new Error("invalid cursor");
  }

  const parsedCursor = z
    .object({
      snapshot_id: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      query_hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(parsedValue);
  if (!parsedCursor.success) {
    throw new Error("invalid cursor");
  }

  return parsedCursor.data;
}

function cleanupAggregationSnapshots(nowMs: number): void {
  for (const [snapshotId, snapshot] of aggregationSnapshotStore) {
    if (snapshot.expiresAtMs <= nowMs) {
      aggregationSnapshotStore.delete(snapshotId);
    }
  }

  while (aggregationSnapshotStore.size > MAX_AGGREGATION_SNAPSHOTS) {
    const oldest = aggregationSnapshotStore.keys().next().value;
    if (!oldest) {
      break;
    }
    aggregationSnapshotStore.delete(oldest);
  }
}

function toSafeIntegerSum(left: number, right: number): number | null {
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(sum);
}

function storeSnapshot(aggregates: AggregatedLibraryUsage[], nowMs: number, queryHash: string): string {
  cleanupAggregationSnapshots(nowMs);
  const snapshotId = randomUUID();
  aggregationSnapshotStore.set(snapshotId, {
    aggregates,
    expiresAtMs: nowMs + AGGREGATION_SNAPSHOT_TTL_MS,
    queryHash,
  });
  return snapshotId;
}

async function buildAggregates(
  parsedInput: AggregateUsageForPeriodInput,
  eventStore: LibraryUsageEventStore,
  resolveLibraryId: LibraryIdResolver
): Promise<AggregatedLibraryUsage[]> {
  const allEnvelopes = await eventStore.readAll();
  const envelopes = allEnvelopes.map((event) => LibraryUsageLoggedEnvelopeSchema.parse(event));

  const periodStartMs = Date.parse(parsedInput.period_start);
  const periodEndMs = Date.parse(parsedInput.period_end);
  const byLibrary = new Map<string, { totalCalls: number; sessionIds: Set<string> }>();
  const resolvedLibraryIdsByKey = new Map<string, Promise<string>>();

  for (const envelope of envelopes) {
    const eventTsMs = Date.parse(envelope.event.ts);
    if (eventTsMs < periodStartMs || eventTsMs >= periodEndMs) {
      continue;
    }

    const libraryKey = `${envelope.event.library.ecosystem}:${envelope.event.library.name}`;
    let libraryIdPromise = resolvedLibraryIdsByKey.get(libraryKey);
    if (!libraryIdPromise) {
      libraryIdPromise = Promise.resolve(
        resolveLibraryId({
          ecosystem: envelope.event.library.ecosystem,
          name: envelope.event.library.name,
        })
      );
      resolvedLibraryIdsByKey.set(libraryKey, libraryIdPromise);
    }
    const libraryId = await libraryIdPromise;

    const existing = byLibrary.get(libraryId) ?? {
      totalCalls: 0,
      sessionIds: new Set<string>(),
    };
    const nextTotalCalls = toSafeIntegerSum(existing.totalCalls, envelope.event.library.calls);
    if (nextTotalCalls === null) {
      throw new Error(`aggregate total_calls overflow for library ${libraryId}`);
    }
    existing.totalCalls = nextTotalCalls;
    existing.sessionIds.add(envelope.event.session_id);
    byLibrary.set(libraryId, existing);
  }

  return [...byLibrary.entries()]
    .map(([libraryId, aggregate]) => ({
      library_id: libraryId,
      total_calls: aggregate.totalCalls,
      unique_sessions: aggregate.sessionIds.size,
    }))
    .sort((a, b) => a.library_id.localeCompare(b.library_id));
}

export async function aggregateUsageForPeriod(
  input: unknown,
  options: AggregateUsageForPeriodOptions
): Promise<AggregateUsageForPeriodOutput> {
  assertToolAuthorized({
    toolName: "aggregate_usage_for_period",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "aggregate_usage_for_period",
    ...(options.maxAllowedRisk === undefined
      ? {}
      : { maxAllowedRisk: options.maxAllowedRisk }),
  });
  assertToolInputVetting("aggregate_usage_for_period", input, {
    ...(options.maxAggregationPeriodDays === undefined
      ? {}
      : { maxAggregationPeriodDays: options.maxAggregationPeriodDays }),
  });
  const parsedInput = AggregateUsageForPeriodInputSchema.parse(input);
  const nowMs = options.now?.() ?? Date.now();
  cleanupAggregationSnapshots(nowMs);
  const queryHash = computeQueryHash(parsedInput.period_start, parsedInput.period_end);
  const maxSnapshotRows = options.maxSnapshotRows ?? MAX_AGGREGATION_SNAPSHOT_ROWS;
  if (!Number.isInteger(maxSnapshotRows) || maxSnapshotRows <= 0) {
    throw new Error("maxSnapshotRows must be a positive integer");
  }

  const resolveLibraryId =
    options.resolveLibraryId ??
    ((reference: CanonicalLibraryReference) => toCanonicalLibraryId(reference));

  const decodedCursor = parsedInput.cursor ? decodeCursor(parsedInput.cursor) : null;

  let aggregatesSource: AggregatedLibraryUsage[];
  let snapshotIdForNextPage: string | null = null;
  let offset = 0;

  if (decodedCursor) {
    if (decodedCursor.query_hash !== queryHash) {
      throw new Error("cursor does not match query");
    }
    const snapshot = aggregationSnapshotStore.get(decodedCursor.snapshot_id);
    if (!snapshot || snapshot.expiresAtMs <= nowMs) {
      aggregationSnapshotStore.delete(decodedCursor.snapshot_id);
      throw new Error("invalid or expired cursor");
    }
    if (snapshot.queryHash !== queryHash) {
      throw new Error("cursor does not match query");
    }
    snapshot.expiresAtMs = nowMs + AGGREGATION_SNAPSHOT_TTL_MS;
    aggregatesSource = snapshot.aggregates;
    snapshotIdForNextPage = decodedCursor.snapshot_id;
    offset = decodedCursor.offset;
  } else {
    aggregatesSource = await buildAggregates(parsedInput, options.eventStore, resolveLibraryId);
    if (aggregatesSource.length > maxSnapshotRows) {
      throw new Error(
        `aggregate result set ${aggregatesSource.length} rows exceeds snapshot limit ${maxSnapshotRows}`
      );
    }
  }

  if (offset > aggregatesSource.length) {
    throw new Error("cursor offset is out of bounds");
  }

  const pageEnd = Math.min(offset + parsedInput.page_size, aggregatesSource.length);
  const aggregates = aggregatesSource.slice(offset, pageEnd);

  if (pageEnd >= aggregatesSource.length) {
    if (snapshotIdForNextPage) {
      aggregationSnapshotStore.delete(snapshotIdForNextPage);
    }
    const output = { aggregates };
    assertToolOutputSanity("aggregate_usage_for_period", output);
    return output;
  }

  if (!snapshotIdForNextPage) {
    snapshotIdForNextPage = storeSnapshot(aggregatesSource, nowMs, queryHash);
  }

  const nextCursor = encodeCursor({
    snapshot_id: snapshotIdForNextPage,
    offset: pageEnd,
    query_hash: queryHash,
  });

  const output = {
    aggregates,
    next_cursor: nextCursor,
  };
  assertToolOutputSanity("aggregate_usage_for_period", output);
  return output;
}
