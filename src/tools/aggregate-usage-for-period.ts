import { z } from "zod";

import {
  LibraryUsageLoggedEnvelopeSchema,
  type LibraryUsageEventStore,
} from "./library-usage-ingestion.js";
import {
  createInMemoryLibraryRegistry,
  type CanonicalLibraryReference,
  type LibraryIdResolver,
} from "./library-registry.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

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
};

type AggregationCursor = {
  offset: number;
};

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

  const parsedCursor = z.object({ offset: z.number().int().nonnegative() }).safeParse(parsedValue);
  if (!parsedCursor.success) {
    throw new Error("invalid cursor");
  }

  return parsedCursor.data;
}

const defaultRegistry = createInMemoryLibraryRegistry();

export async function aggregateUsageForPeriod(
  input: unknown,
  options: AggregateUsageForPeriodOptions
): Promise<AggregateUsageForPeriodOutput> {
  const parsedInput = AggregateUsageForPeriodInputSchema.parse(input);
  const allEnvelopes = await options.eventStore.readAll();
  const envelopes = allEnvelopes.map((event) => LibraryUsageLoggedEnvelopeSchema.parse(event));

  const periodStartMs = Date.parse(parsedInput.period_start);
  const periodEndMs = Date.parse(parsedInput.period_end);
  const libraryIdResolver =
    options.resolveLibraryId ??
    ((reference: CanonicalLibraryReference) => defaultRegistry.resolveLibraryId(reference).library_id);

  const byLibrary = new Map<string, { totalCalls: number; sessionIds: Set<string> }>();

  for (const envelope of envelopes) {
    const eventTsMs = Date.parse(envelope.event.ts);
    if (eventTsMs < periodStartMs || eventTsMs >= periodEndMs) {
      continue;
    }

    const libraryId = await libraryIdResolver({
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

  const sortedAggregates: AggregatedLibraryUsage[] = [...byLibrary.entries()]
    .map(([libraryId, aggregate]) => ({
      library_id: libraryId,
      total_calls: aggregate.totalCalls,
      unique_sessions: aggregate.sessionIds.size,
    }))
    .sort((a, b) => a.library_id.localeCompare(b.library_id));

  const offset = parsedInput.cursor ? decodeCursor(parsedInput.cursor).offset : 0;
  if (offset > sortedAggregates.length) {
    throw new Error("cursor offset is out of bounds");
  }

  const pageEnd = Math.min(offset + parsedInput.page_size, sortedAggregates.length);
  const aggregates = sortedAggregates.slice(offset, pageEnd);
  const nextCursor = pageEnd < sortedAggregates.length ? encodeCursor({ offset: pageEnd }) : undefined;

  return {
    aggregates,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}
