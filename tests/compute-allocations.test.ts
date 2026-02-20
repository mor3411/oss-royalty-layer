import { describe, expect, it } from "vitest";

import { computeAllocations } from "../src/tools/compute-allocations.js";

describe("computeAllocations", () => {
  it("returns allocation proposals with notes, confidence scores, and flags", async () => {
    const result = await computeAllocations({
      period: "2026-02",
      pool_amount_minor: 10_000,
      usage_stats: [
        {
          library_id: "lib.alpha",
          total_calls: 120,
          unique_sessions: 12,
        },
        {
          library_id: "lib.beta",
          total_calls: 4,
          unique_sessions: 1,
        },
      ],
      policy_config: {
        max_share_per_library: 0.6,
        min_floor_amount_minor: 25,
        long_tail_weight: 1.2,
      },
    });

    expect(result.period).toBe("2026-02");
    expect(result.notes).toContain("computed 2 allocations");
    expect(result.policy_applied.min_floor_amount_minor).toBe(25);

    const totalAllocated = result.allocations.reduce(
      (sum, allocation) => sum + allocation.amount_minor,
      0
    );
    expect(totalAllocated).toBe(10_000);

    for (const allocation of result.allocations) {
      expect(allocation.maintainer_id).toMatch(/^mnt_[a-f0-9]{24}$/);
      expect(allocation.confidence_score).toBeGreaterThanOrEqual(0);
      expect(allocation.confidence_score).toBeLessThanOrEqual(1);
      expect(Array.isArray(allocation.flags)).toBe(true);
    }

    const lowSignal = result.allocations.find(
      (allocation) => allocation.library_id === "lib.beta"
    );
    expect(lowSignal?.flags).toContain("low_usage_signal");
  });

  it("enforces max-share cap and flags capped allocations", async () => {
    const result = await computeAllocations({
      period: "2026-02",
      pool_amount_minor: 10_000,
      usage_stats: [
        {
          library_id: "lib.dominant",
          total_calls: 1_000,
          unique_sessions: 100,
        },
        {
          library_id: "lib.small",
          total_calls: 10,
          unique_sessions: 3,
        },
      ],
      policy_config: {
        max_share_per_library: 0.5,
        min_floor_amount_minor: 0,
        long_tail_weight: 1,
      },
    });

    const dominant = result.allocations.find(
      (allocation) => allocation.library_id === "lib.dominant"
    );
    expect(dominant).toBeDefined();
    expect(dominant?.amount_minor).toBe(5_000);
    expect(dominant?.flags).toContain("max_share_capped");
  });

  it("enforces authorization in production without principal", async () => {
    await expect(
      computeAllocations(
        {
          period: "2026-02",
          pool_amount_minor: 1_000,
          usage_stats: [
            {
              library_id: "lib.alpha",
              total_calls: 10,
              unique_sessions: 2,
            },
          ],
        },
        {
          runtimeEnvironment: "production",
          allowTestAuthBypass: false,
        }
      )
    ).rejects.toThrowError("authorization required");
  });

  it("enforces tool risk allowance", async () => {
    await expect(
      computeAllocations(
        {
          period: "2026-02",
          pool_amount_minor: 1_000,
          usage_stats: [
            {
              library_id: "lib.alpha",
              total_calls: 10,
              unique_sessions: 2,
            },
          ],
        },
        {
          maxAllowedRisk: "low",
        }
      )
    ).rejects.toThrowError("requires medium risk allowance");
  });

  it("handles pool_amount_minor=1 with 2 libraries", async () => {
    const result = await computeAllocations({
      period: "2026-02",
      pool_amount_minor: 1,
      usage_stats: [
        { library_id: "lib.a", total_calls: 10, unique_sessions: 2 },
        { library_id: "lib.b", total_calls: 5, unique_sessions: 1 },
      ],
    });

    const total = result.allocations.reduce((s, a) => s + a.amount_minor, 0);
    expect(total).toBe(1);
  });

  it("handles pool_amount_minor=2 with 3 libraries", async () => {
    const result = await computeAllocations({
      period: "2026-02",
      pool_amount_minor: 2,
      usage_stats: [
        { library_id: "lib.a", total_calls: 10, unique_sessions: 2 },
        { library_id: "lib.b", total_calls: 5, unique_sessions: 1 },
        { library_id: "lib.c", total_calls: 3, unique_sessions: 1 },
      ],
    });

    const total = result.allocations.reduce((s, a) => s + a.amount_minor, 0);
    expect(total).toBe(2);
  });

  it("handles pool_amount_minor=3 with 4 libraries (pool < N)", async () => {
    const result = await computeAllocations({
      period: "2026-02",
      pool_amount_minor: 3,
      usage_stats: [
        { library_id: "lib.a", total_calls: 10, unique_sessions: 2 },
        { library_id: "lib.b", total_calls: 5, unique_sessions: 1 },
        { library_id: "lib.c", total_calls: 3, unique_sessions: 1 },
        { library_id: "lib.d", total_calls: 1, unique_sessions: 1 },
      ],
    });

    const total = result.allocations.reduce((s, a) => s + a.amount_minor, 0);
    expect(total).toBe(3);
    for (const alloc of result.allocations) {
      expect(alloc.amount_minor).toBeGreaterThanOrEqual(0);
    }
  });

  it("supports custom maintainer resolver", async () => {
    const result = await computeAllocations(
      {
        period: "2026-02",
        pool_amount_minor: 1_000,
        usage_stats: [
          {
            library_id: "lib.alpha",
            total_calls: 10,
            unique_sessions: 2,
          },
        ],
      },
      {
        resolveMaintainerId: (libraryId) => `maintainer-for:${libraryId}`,
      }
    );

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.maintainer_id).toBe("maintainer-for:lib.alpha");
  });
});
