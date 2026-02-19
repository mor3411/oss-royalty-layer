import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { LibraryUsageLoggedEventSchema, type EnqueueLibraryUsageEvent } from "./log-library-usage.js";

export const MAX_IN_MEMORY_INGESTED_EVENTS = 50_000;

export const LibraryUsageLoggedEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  ingested_at: z.string().datetime(),
  event: LibraryUsageLoggedEventSchema,
});

export const LibraryUsageIngestionMetricsSchema = z.object({
  events_received: z.number().int().nonnegative(),
  events_persisted: z.number().int().nonnegative(),
  events_failed: z.number().int().nonnegative(),
  last_event_id: z.string().optional(),
  last_ingested_at: z.string().datetime().optional(),
  last_error: z.string().optional(),
});

export type LibraryUsageLoggedEnvelope = z.infer<typeof LibraryUsageLoggedEnvelopeSchema>;
export type LibraryUsageIngestionMetrics = z.infer<typeof LibraryUsageIngestionMetricsSchema>;

export type LibraryUsageEventStore = {
  append: (envelope: LibraryUsageLoggedEnvelope) => Promise<void> | void;
  readAll: () => Promise<LibraryUsageLoggedEnvelope[]> | LibraryUsageLoggedEnvelope[];
  clear?: () => Promise<void> | void;
};

type LibraryUsageIngestionPipelineOptions = {
  eventStore?: LibraryUsageEventStore;
  now?: () => number;
  eventIdGenerator?: (
    event: z.infer<typeof LibraryUsageLoggedEventSchema>,
    ingestIndex: number,
    nowMs: number
  ) => string;
};

export type LibraryUsageIngestionPipeline = {
  enqueueEvent: EnqueueLibraryUsageEvent;
  getMetrics: () => LibraryUsageIngestionMetrics;
  readIngestedEvents: () => Promise<LibraryUsageLoggedEnvelope[]>;
};

const inMemoryIngestedEvents: LibraryUsageLoggedEnvelope[] = [];

function defaultEventIdGenerator(
  event: z.infer<typeof LibraryUsageLoggedEventSchema>,
  ingestIndex: number,
  nowMs: number
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(event))
    .update(":")
    .update(String(nowMs))
    .update(":")
    .update(String(ingestIndex))
    .digest("hex");
  return `evt_${digest.slice(0, 24)}`;
}

const inMemoryLibraryUsageEventStore: LibraryUsageEventStore = {
  append(envelope: LibraryUsageLoggedEnvelope): void {
    while (inMemoryIngestedEvents.length >= MAX_IN_MEMORY_INGESTED_EVENTS) {
      inMemoryIngestedEvents.shift();
    }
    inMemoryIngestedEvents.push(envelope);
  },
  readAll(): LibraryUsageLoggedEnvelope[] {
    return [...inMemoryIngestedEvents];
  },
  clear(): void {
    inMemoryIngestedEvents.length = 0;
  },
};

export function clearInMemoryLibraryUsageIngestionEvents(): void {
  inMemoryIngestedEvents.length = 0;
}

export function getInMemoryLibraryUsageIngestionEvents(): LibraryUsageLoggedEnvelope[] {
  return [...inMemoryIngestedEvents];
}

export function createNdjsonLibraryUsageEventStore(filePath: string): LibraryUsageEventStore {
  return {
    async append(envelope: LibraryUsageLoggedEnvelope): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(envelope)}\n`, "utf8");
    },

    async readAll(): Promise<LibraryUsageLoggedEnvelope[]> {
      let contents = "";
      try {
        contents = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      const lines = contents
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return lines.map((line, index) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return LibraryUsageLoggedEnvelopeSchema.parse(parsed);
        } catch {
          throw new Error(`invalid envelope at line ${index + 1} in ${filePath}`);
        }
      });
    },
  };
}

export function createLibraryUsageIngestionPipeline(
  options: LibraryUsageIngestionPipelineOptions = {}
): LibraryUsageIngestionPipeline {
  const now = options.now ?? Date.now;
  const eventStore = options.eventStore ?? inMemoryLibraryUsageEventStore;
  const eventIdGenerator = options.eventIdGenerator ?? defaultEventIdGenerator;

  let ingestIndex = 0;
  const metrics: LibraryUsageIngestionMetrics = {
    events_received: 0,
    events_persisted: 0,
    events_failed: 0,
  };

  const enqueueEvent: EnqueueLibraryUsageEvent = async (event) => {
    metrics.events_received += 1;

    try {
      const nowMs = now();
      const parsedEvent = LibraryUsageLoggedEventSchema.parse(event);
      const envelope: LibraryUsageLoggedEnvelope = {
        event_id: eventIdGenerator(parsedEvent, ingestIndex, nowMs),
        ingested_at: new Date(nowMs).toISOString(),
        event: parsedEvent,
      };
      ingestIndex += 1;

      await eventStore.append(envelope);
      metrics.events_persisted += 1;
      metrics.last_event_id = envelope.event_id;
      metrics.last_ingested_at = envelope.ingested_at;
      delete metrics.last_error;
    } catch (error) {
      metrics.events_failed += 1;
      metrics.last_error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const getMetrics = (): LibraryUsageIngestionMetrics => ({ ...metrics });

  const readIngestedEvents = async (): Promise<LibraryUsageLoggedEnvelope[]> => {
    const events = await eventStore.readAll();
    return events.map((event) => LibraryUsageLoggedEnvelopeSchema.parse(event));
  };

  return {
    enqueueEvent,
    getMetrics,
    readIngestedEvents,
  };
}
