import { describe, expect, it } from "vitest";

import {
  MAX_ALLOCATION_CANDIDATES,
  assertAllocationConstraints,
  validateAllocationConstraints,
} from "../src/tools/allocation-constraints.js";

describe("allocation constraints", () => {
  it("returns valid result when allocations satisfy all deterministic constraints", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      max_share_per_library: 0.6,
      allocations: [
        {
          library_id: "lib-a",
          maintainer_id: "mnt-1",
          amount_minor: 4_000,
        },
        {
          library_id: "lib-b",
          maintainer_id: "mnt-2",
          amount_minor: 6_000,
        },
      ],
    });

    expect(result).toEqual({
      status: "valid",
      total_allocated_minor: 10_000,
      expected_pool_minor: 10_000,
      violations: [],
    });
  });

  it("flags sum mismatch when total differs beyond tolerance", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      sum_tolerance_minor: 5,
      allocations: [
        {
          library_id: "lib-a",
          maintainer_id: "mnt-1",
          amount_minor: 4_000,
        },
        {
          library_id: "lib-b",
          maintainer_id: "mnt-2",
          amount_minor: 5_990,
        },
      ],
    });

    expect(result.status).toBe("invalid");
    expect(result.violations.some((violation) => violation.code === "pool_sum_mismatch")).toBe(true);
  });

  it("flags negative amounts and per-library share overages", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      max_share_per_library: 0.5,
      allocations: [
        {
          library_id: "lib-a",
          maintainer_id: "mnt-1",
          amount_minor: 6_000,
        },
        {
          library_id: "lib-a",
          maintainer_id: "mnt-2",
          amount_minor: -500,
        },
        {
          library_id: "lib-b",
          maintainer_id: "mnt-3",
          amount_minor: 4_500,
        },
      ],
    });

    expect(result.status).toBe("invalid");
    expect(result.violations.some((violation) => violation.code === "negative_amount")).toBe(true);
    expect(
      result.violations.some(
        (violation) =>
          violation.code === "library_share_exceeded" && violation.library_id === "lib-a"
      )
    ).toBe(true);
  });

  it("fails schema validation when required fields are missing", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      allocations: [
        {
          maintainer_id: "mnt-1",
          amount_minor: 1_000,
        },
      ],
    });

    expect(result.status).toBe("invalid");
    expect(result.violations[0]?.code).toBe("schema_validation_failed");
    expect(result.violations[0]?.message).toBe("invalid allocation constraint payload");
  });

  it("fails schema validation when allocations exceed maximum candidate limit", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      allocations: Array.from({ length: MAX_ALLOCATION_CANDIDATES + 1 }, (_, idx) => ({
        library_id: `lib-${idx}`,
        maintainer_id: `mnt-${idx}`,
        amount_minor: 1,
      })),
    });

    expect(result.status).toBe("invalid");
    expect(result.violations[0]?.code).toBe("schema_validation_failed");
    expect(result.violations[0]?.message).toBe("invalid allocation constraint payload");
  });

  it("fails schema validation when payload contains unsafe integer amounts", () => {
    const result = validateAllocationConstraints({
      pool_amount_minor: 10_000,
      allocations: [
        {
          library_id: "lib-a",
          maintainer_id: "mnt-1",
          amount_minor: Number.MAX_SAFE_INTEGER + 1,
        },
      ],
    });

    expect(result.status).toBe("invalid");
    expect(result.violations[0]?.code).toBe("schema_validation_failed");
    expect(result.violations[0]?.message).toBe("invalid allocation constraint payload");
  });

  it("asserts by throwing when constraints are violated", () => {
    expect(() =>
      assertAllocationConstraints({
        pool_amount_minor: 10_000,
        allocations: [
          {
            library_id: "lib-a",
            maintainer_id: "mnt-1",
            amount_minor: 1_000,
          },
        ],
      })
    ).toThrowError("allocation constraints violated");
  });
});
