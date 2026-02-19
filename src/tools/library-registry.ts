import { createHash } from "node:crypto";
import { z } from "zod";

import { EcosystemSchema } from "../domain/index.js";

export const MAX_CANONICAL_LIBRARY_NAME_LENGTH = 128;

export const CanonicalLibraryReferenceSchema = z.object({
  ecosystem: z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(EcosystemSchema),
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CANONICAL_LIBRARY_NAME_LENGTH)
    .transform((value) => value.toLowerCase()),
});

export const LibraryRegistryEntrySchema = z.object({
  key: z.string().min(1),
  library_id: z.string().min(1),
  ecosystem: EcosystemSchema,
  name: z.string().min(1),
  created_at: z.string().datetime(),
});

export type CanonicalLibraryReference = z.infer<typeof CanonicalLibraryReferenceSchema>;
export type LibraryRegistryEntry = z.infer<typeof LibraryRegistryEntrySchema>;

export type LibraryIdResolver = (
  reference: CanonicalLibraryReference
) => Promise<string> | string;

export type InMemoryLibraryRegistry = {
  resolveLibraryId: (reference: unknown) => LibraryRegistryEntry;
  getByLibraryId: (libraryId: string) => LibraryRegistryEntry | undefined;
  listEntries: () => LibraryRegistryEntry[];
  clear: () => void;
};

type InMemoryLibraryRegistryOptions = {
  now?: () => number;
};

export function canonicalizeLibraryReference(reference: unknown): CanonicalLibraryReference {
  return CanonicalLibraryReferenceSchema.parse(reference);
}

export function getCanonicalLibraryKey(reference: CanonicalLibraryReference): string {
  return `${reference.ecosystem}:${reference.name}`;
}

export function toCanonicalLibraryId(reference: unknown): string {
  const canonicalReference = canonicalizeLibraryReference(reference);
  const canonicalKey = getCanonicalLibraryKey(canonicalReference);
  const digest = createHash("sha256").update(canonicalKey).digest("hex");
  return `lib_${digest.slice(0, 24)}`;
}

export function createInMemoryLibraryRegistry(
  options: InMemoryLibraryRegistryOptions = {}
): InMemoryLibraryRegistry {
  const now = options.now ?? Date.now;
  const entriesByKey = new Map<string, LibraryRegistryEntry>();
  const entriesByLibraryId = new Map<string, LibraryRegistryEntry>();

  return {
    resolveLibraryId(reference: unknown): LibraryRegistryEntry {
      const canonicalReference = canonicalizeLibraryReference(reference);
      const key = getCanonicalLibraryKey(canonicalReference);
      const existing = entriesByKey.get(key);
      if (existing) {
        return existing;
      }

      const libraryId = toCanonicalLibraryId(canonicalReference);
      const collision = entriesByLibraryId.get(libraryId);
      if (collision && collision.key !== key) {
        throw new Error(`library_id collision detected for ${libraryId}`);
      }

      const entry: LibraryRegistryEntry = {
        key,
        library_id: libraryId,
        ecosystem: canonicalReference.ecosystem,
        name: canonicalReference.name,
        created_at: new Date(now()).toISOString(),
      };

      entriesByKey.set(key, entry);
      entriesByLibraryId.set(entry.library_id, entry);
      return entry;
    },

    getByLibraryId(libraryId: string): LibraryRegistryEntry | undefined {
      return entriesByLibraryId.get(libraryId);
    },

    listEntries(): LibraryRegistryEntry[] {
      return [...entriesByKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    },

    clear(): void {
      entriesByKey.clear();
      entriesByLibraryId.clear();
    },
  };
}
