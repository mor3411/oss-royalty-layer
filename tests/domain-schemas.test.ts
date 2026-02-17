import { describe, expect, it } from "vitest";

import {
  AllocationSchema,
  DOMAIN_SCHEMA_VERSION,
  DomainSchemaRegistry,
  LibrarySchema,
  MaintainerSchema,
  PayoutSchema,
  RoyaltyPoolSchema,
  UsageRecordSchema,
} from "../src/domain/index.js";

describe("domain schemas", () => {
  it("validates canonical entities", () => {
    const library = LibrarySchema.parse({
      id: "lib-1",
      name: "zod",
      ecosystem: "npm",
      repo_url: "https://github.com/colinhacks/zod",
      maintainer_ids: ["mnt-1"],
      risk_score: 0.1,
    });

    const maintainer = MaintainerSchema.parse({
      id: "mnt-1",
      payout_account: {
        provider: "stripe",
        account_id: "acct_123",
      },
      verification_status: "verified",
      trust_score: 0.9,
    });

    const usageRecord = UsageRecordSchema.parse({
      id: "use-1",
      agent_session_id: "sess-1",
      library_id: library.id,
      version: "3.23.8",
      call_count: 12,
      source: "ide",
      ts: "2026-02-17T12:00:00.000Z",
    });

    const royaltyPool = RoyaltyPoolSchema.parse({
      period: "2026-02",
      total_amount: 1000,
      policy: {
        max_share_per_library: 0.25,
        min_floor_amount: 5,
        long_tail_weight: 1.1,
      },
    });

    const allocation = AllocationSchema.parse({
      id: "all-1",
      period: "2026-02",
      library_id: library.id,
      maintainer_id: maintainer.id,
      amount: 120.5,
      confidence_score: 0.8,
      flags: [],
    });

    const payout = PayoutSchema.parse({
      id: "pay-1",
      period: "2026-02",
      maintainer_id: maintainer.id,
      amount: 120.5,
      currency: "usd",
      status: "queued",
    });

    expect(usageRecord.call_count).toBe(12);
    expect(royaltyPool.period).toBe("2026-02");
    expect(allocation.amount).toBe(120.5);
    expect(payout.currency).toBe("USD");
  });

  it("enforces schema version in registry", () => {
    const registry = DomainSchemaRegistry.parse({
      schema_version: DOMAIN_SCHEMA_VERSION,
      library: {
        id: "lib-1",
        name: "zod",
        ecosystem: "npm",
        maintainer_ids: [],
        risk_score: 0,
      },
      maintainer: {
        id: "mnt-1",
        verification_status: "pending",
        trust_score: 0.2,
      },
      usage_record: {
        id: "use-1",
        agent_session_id: "sess-1",
        library_id: "lib-1",
        version: "1.0.0",
        call_count: 1,
        source: "api",
        ts: "2026-02-17T12:00:00.000Z",
      },
      royalty_pool: {
        period: "2026-02",
        total_amount: 20,
        policy: {
          max_share_per_library: 0.2,
          min_floor_amount: 0,
          long_tail_weight: 1,
        },
      },
      allocation: {
        id: "all-1",
        period: "2026-02",
        library_id: "lib-1",
        maintainer_id: "mnt-1",
        amount: 10,
        confidence_score: 0.7,
      },
      payout: {
        id: "pay-1",
        period: "2026-02",
        maintainer_id: "mnt-1",
        amount: 10,
        currency: "USD",
        status: "processing",
      },
    });

    expect(registry.schema_version).toBe(DOMAIN_SCHEMA_VERSION);
  });

  it("rejects invalid domain payloads", () => {
    expect(() =>
      RoyaltyPoolSchema.parse({
        period: "2026-13",
        total_amount: 10,
        policy: {
          max_share_per_library: 0.2,
          min_floor_amount: 1,
          long_tail_weight: 1,
        },
      })
    ).toThrowError();

    expect(() =>
      AllocationSchema.parse({
        id: "all-2",
        period: "2026-02",
        library_id: "lib-1",
        maintainer_id: "mnt-1",
        amount: 10,
        confidence_score: 1.2,
      })
    ).toThrowError();
  });
});
