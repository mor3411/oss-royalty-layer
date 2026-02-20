import { describe, expect, it } from "vitest";

import {
  assertToolAuthorized,
  requiresToolAuthorization,
} from "../src/tools/authz.js";

describe("tool authorization", () => {
  it("identifies internal tools that require authorization", () => {
    expect(requiresToolAuthorization("aggregate_usage_for_period")).toBe(true);
    expect(requiresToolAuthorization("append_royalty_cycle_audit")).toBe(true);
    expect(requiresToolAuthorization("record_royalty_observability")).toBe(true);
    expect(requiresToolAuthorization("get_royalty_observability_dashboard")).toBe(true);
    expect(requiresToolAuthorization("record_payout_batch_approval")).toBe(true);
    expect(requiresToolAuthorization("execute_payouts")).toBe(true);
    expect(requiresToolAuthorization("log_library_usage")).toBe(false);
  });

  it("fails closed in production without principal for internal tools", () => {
    expect(() =>
      assertToolAuthorized({
        toolName: "aggregate_usage_for_period",
        runtimeEnvironment: "production",
      })
    ).toThrowError("authorization required");
  });

  it("rejects unauthorized principal roles for high-risk tools", () => {
    expect(() =>
      assertToolAuthorized({
        toolName: "execute_payouts",
        runtimeEnvironment: "production",
        principal: {
          principal_id: "mgr-1",
          role: "manager",
        },
      })
    ).toThrowError("not authorized");
  });

  it("accepts authorized service principals for high-risk tools", () => {
    const principal = assertToolAuthorized({
      toolName: "execute_payouts",
      runtimeEnvironment: "production",
      principal: {
        principal_id: "svc-1",
        role: "service",
      },
    });
    expect(principal.role).toBe("service");
  });

  it("allows explicit test bypass for test runtime", () => {
    const principal = assertToolAuthorized({
      toolName: "aggregate_usage_for_period",
      runtimeEnvironment: "test",
      allowTestBypass: true,
    });
    expect(principal.principal_id).toBe("test-auth-bypass");
  });

  it("rejects test bypass when explicitly disabled", () => {
    expect(() =>
      assertToolAuthorized({
        toolName: "aggregate_usage_for_period",
        runtimeEnvironment: "test",
        allowTestBypass: false,
      })
    ).toThrowError("authorization required");
  });
});
