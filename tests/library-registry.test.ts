import { describe, expect, it } from "vitest";

import {
  canonicalizeLibraryReference,
  createInMemoryLibraryRegistry,
  getCanonicalLibraryKey,
  toCanonicalLibraryId,
} from "../src/tools/library-registry.js";

describe("library registry", () => {
  it("canonicalizes ecosystem/name and builds stable key", () => {
    const canonical = canonicalizeLibraryReference({
      ecosystem: "NPM",
      name: " Zod ",
    });

    expect(canonical).toEqual({
      ecosystem: "npm",
      name: "zod",
    });
    expect(getCanonicalLibraryKey(canonical)).toBe("npm:zod");
  });

  it("returns deterministic IDs for equivalent references", () => {
    const idA = toCanonicalLibraryId({
      ecosystem: "npm",
      name: "zod",
    });
    const idB = toCanonicalLibraryId({
      ecosystem: "NPM",
      name: " Zod ",
    });

    expect(idA).toBe(idB);
    expect(idA).toMatch(/^lib_[a-f0-9]{24}$/);
  });

  it("creates and reuses entries in the in-memory registry", () => {
    const registry = createInMemoryLibraryRegistry({
      now: () => Date.parse("2026-02-19T22:00:00.000Z"),
    });

    const first = registry.resolveLibraryId({
      ecosystem: "npm",
      name: "zod",
    });
    const second = registry.resolveLibraryId({
      ecosystem: "NPM",
      name: " ZOD ",
    });
    const third = registry.resolveLibraryId({
      ecosystem: "pypi",
      name: "zod",
    });

    expect(first.library_id).toBe(second.library_id);
    expect(first.library_id).not.toBe(third.library_id);
    expect(registry.listEntries()).toHaveLength(2);
    expect(registry.getByLibraryId(first.library_id)).toEqual(first);
  });
});
