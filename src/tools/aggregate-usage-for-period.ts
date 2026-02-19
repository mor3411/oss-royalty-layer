import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  LibraryUsageLoggedEnvelopeSchema,
  type LibraryUsageEventStore,
} from "./library-usage-ingestion.js";
import { type CanonicalLibraryReference, type LibraryIdResolver, toCanonicalLibraryId } from "./library-registry.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const AGGREGATION_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_AGGREGATION_SNAPSHOTS = 256;

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
  total_calls: z.number().int().nonnegative(),
  unique_sessions: z.number().int().nonnegative(),
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
};

type AggregationCursor = {
  snapshot_id: string;
  offset: number;
};

type AggregationSnapshot = {
  aggregates: AggregatedLibraryUsage[];
  expiresAtMs: number;
};

const aggregationSnapshotStore = new Map<string, AggregationSnapshot>();

function encodeCursor(cursor: AggregationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
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

function storeSnapshot(aggregates: AggregatedLibraryUsage[], nowMs: number): string {
  cleanupAggregationSnapshots(nowMs);
  const snapshotId = randomUUID();
  aggregationSnapshotStore.set(snapshotId, {
    aggregates,
    expiresAtMs: nowMs + AGGREGATION_SNAPSHOT_TTL_MS,
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

  for (const envelope of envelopes) {
    const eventTsMs = Date.parse(envelope.event.ts);
    if (eventTsMs < periodStartMs || eventTsMs >= periodEndMs) {
      continue;
    }

    const libraryId = await resolveLibraryId({
      ecosystem: envelope.event.library.ecosystem,
      name: envelope.event.library.name,
    });

    const existing = byLibrary.get(libraryId) ?? {
      totalCalls: 0,
      sessionIds: new Set<string>(),
    };
    existing.totalCalls += envelope.event.library.calls;
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
  const parsedInput = AggregateUsageForPeriodInputSchema.parse(input);
  const nowMs = options.now?.() ?? Date.now();
  cleanupAggregationSnapshots(nowMs);

  const resolveLibraryId =
    options.resolveLibraryId ??
    ((reference: CanonicalLibraryReference) => toCanonicalLibraryId(reference));

  const decodedCursor = parsedInput.cursor ? decodeCursor(parsedInput.cursor) : null;

  let aggregatesSource: AggregatedLibraryUsage[];
  let snapshotIdForNextPage: string | null = null;
  let offset = 0;

  if (decodedCursor) {
    const snapshot = aggregationSnapshotStore.get(decodedCursor.snapshot_id);
    if (!snapshot || snapshot.expiresAtMs <= nowMs) {
      aggregationSnapshotStore.delete(decodedCursor.snapshot_id);
      throw new Error("invalid or expired cursor");
    }
    snapshot.expiresAtMs = nowMs + AGGREGATION_SNAPSHOT_TTL_MS;
    aggregatesSource = snapshot.aggregates;
    snapshotIdForNextPage = decodedCursor.snapshot_id;
    offset = decodedCursor.offset;
  } else {
    aggregatesSource = await buildAggregates(parsedInput, options.eventStore, resolveLibraryId);
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
    return { aggregates };
  }

  if (!snapshotIdForNextPage) {
    snapshotIdForNextPage = storeSnapshot(aggregatesSource, nowMs);
  }

  const nextCursor = encodeCursor({
    snapshot_id: snapshotIdForNextPage,
    offset: pageEnd,
  });

  return {
    aggregates,
    next_cursor: nextCursor,
  };
}
