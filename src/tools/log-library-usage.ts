import { z } from "zod";

import { EcosystemSchema, UsageSourceSchema } from "../domain/index.js";

export const MAX_LIBRARIES_PER_CALL = 1000;

export const LibraryUsagePayloadSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.toLowerCase()),
  ecosystem: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(EcosystemSchema),
  version: z.string().trim().min(1),
  calls: z.number().int().nonnegative(),
});

export const LogLibraryUsageInputSchema = z.object({
  session_id: z.string().trim().min(1),
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
  reason: z.enum(["invalid_payload", "too_many_libraries", "no_libraries"]).optional(),
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
};

const inMemoryLibraryUsageEvents: LibraryUsageLoggedEvent[] = [];

export function clearLibraryUsageEvents(): void {
  inMemoryLibraryUsageEvents.length = 0;
}

export function getLibraryUsageEvents(): LibraryUsageLoggedEvent[] {
  return [...inMemoryLibraryUsageEvents];
}

function defaultEnqueueLibraryUsageEvent(event: LibraryUsageLoggedEvent): void {
  inMemoryLibraryUsageEvents.push(event);
}

function getRejectionReason(error: z.ZodError): "invalid_payload" | "too_many_libraries" | "no_libraries" {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid_payload";
  }

  if (firstIssue.path[0] === "libraries" && firstIssue.code === "too_big") {
    return "too_many_libraries";
  }

  if (firstIssue.path[0] === "libraries" && firstIssue.code === "too_small") {
    return "no_libraries";
  }

  return "invalid_payload";
}

export async function logLibraryUsage(
  input: unknown,
  options: LogLibraryUsageOptions = {}
): Promise<LogLibraryUsageOutput> {
  const parsedInput = LogLibraryUsageInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "rejected",
      reason: getRejectionReason(parsedInput.error),
    };
  }

  const enqueueEvent = options.enqueueEvent ?? defaultEnqueueLibraryUsageEvent;

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
