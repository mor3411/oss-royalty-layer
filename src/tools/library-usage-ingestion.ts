import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, appendFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

import { LibraryUsageLoggedEventSchema, type EnqueueLibraryUsageEvent } from "./log-library-usage.js";

export const MAX_IN_MEMORY_INGESTED_EVENTS = 50_000;
export const DEFAULT_NDJSON_EVENT_STORE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_NDJSON_EVENT_STORE_MAX_FILES = 5;

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

export type NdjsonLibraryUsageEventStoreOptions = {
  strictRead?: boolean;
  onInvalidLine?: (line: number, message: string) => void;
  maxBytes?: number;
  maxFiles?: number;
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

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function rotateNdjsonEventStoreIfNeeded(
  filePath: string,
  maxBytes: number,
  maxFiles: number
): Promise<void> {
  let currentSize = 0;
  try {
    const fileStats = await stat(filePath);
    currentSize = fileStats.size;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (currentSize < maxBytes) {
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

function toReadPaths(filePath: string, maxFiles: number): string[] {
  const paths: string[] = [];
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    paths.push(`${filePath}.${index}`);
  }
  paths.push(filePath);
  return paths;
}

export function createNdjsonLibraryUsageEventStore(
  filePath: string,
  options: NdjsonLibraryUsageEventStoreOptions = {}
): LibraryUsageEventStore {
  const strictRead = options.strictRead ?? true;
  const maxBytes = options.maxBytes ?? DEFAULT_NDJSON_EVENT_STORE_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_NDJSON_EVENT_STORE_MAX_FILES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("maxFiles must be a positive integer");
  }

  return {
    async append(envelope: LibraryUsageLoggedEnvelope): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await rotateNdjsonEventStoreIfNeeded(filePath, maxBytes, maxFiles);
      await appendFile(filePath, `${JSON.stringify(envelope)}\n`, "utf8");
    },

    async readAll(): Promise<LibraryUsageLoggedEnvelope[]> {
      const parsedEnvelopes: LibraryUsageLoggedEnvelope[] = [];
      let lineNumber = 0;
      const readPaths = toReadPaths(filePath, maxFiles);

      for (const path of readPaths) {
        try {
          await stat(path);
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) {
            continue;
          }
          throw error;
        }

        const stream = createReadStream(path, { encoding: "utf8" });
        const reader = createInterface({
          input: stream,
          crlfDelay: Infinity,
        });
        try {
          for await (const rawLine of reader) {
            const line = rawLine.trim();
            if (line.length === 0) {
              continue;
            }
            lineNumber += 1;
            try {
              const parsed = JSON.parse(line) as unknown;
              parsedEnvelopes.push(LibraryUsageLoggedEnvelopeSchema.parse(parsed));
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : `invalid envelope at line ${lineNumber}`;
              options.onInvalidLine?.(lineNumber, message);
              if (strictRead) {
                throw new Error(`invalid envelope at line ${lineNumber} in ${path}`);
              }
            }
          }
        } finally {
          reader.close();
        }
      }

      return parsedEnvelopes;
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
