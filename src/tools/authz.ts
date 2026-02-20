import { z } from "zod";
import { type GuardrailedToolName } from "./guardrails.js";

export const AuthorizationRuntimeEnvironmentSchema = z.enum([
  "development",
  "test",
  "production",
]);
export type AuthorizationRuntimeEnvironment = z.infer<
  typeof AuthorizationRuntimeEnvironmentSchema
>;

export const ToolPrincipalRoleSchema = z.enum([
  "admin",
  "manager",
  "analyst",
  "viewer",
  "service",
]);
export type ToolPrincipalRole = z.infer<typeof ToolPrincipalRoleSchema>;

export const ToolPrincipalSchema = z.object({
  principal_id: z.string().min(1),
  role: ToolPrincipalRoleSchema,
  scopes: z.array(z.string().min(1)).default([]),
});
export type ToolPrincipal = z.infer<typeof ToolPrincipalSchema>;

export const DEFAULT_ALLOW_TEST_AUTH_BYPASS = false;

const INTERNAL_TOOL_NAMES = new Set<GuardrailedToolName>([
  "aggregate_usage_for_period",
  "validate_allocation_constraints",
  "compute_allocations",
  "persist_allocations",
  "create_payout_batch",
  "append_royalty_cycle_audit",
  "record_royalty_observability",
  "get_royalty_observability_dashboard",
  "record_payout_batch_approval",
  "execute_payouts",
]);

const AUTHORIZED_ROLES_BY_TOOL: Record<GuardrailedToolName, ToolPrincipalRole[]> = {
  log_library_usage: ["viewer", "analyst", "manager", "admin", "service"],
  aggregate_usage_for_period: ["analyst", "manager", "admin", "service"],
  validate_allocation_constraints: ["analyst", "manager", "admin", "service"],
  compute_allocations: ["manager", "admin", "service"],
  persist_allocations: ["manager", "admin", "service"],
  create_payout_batch: ["manager", "admin", "service"],
  append_royalty_cycle_audit: ["manager", "admin", "service"],
  record_royalty_observability: ["analyst", "manager", "admin", "service"],
  get_royalty_observability_dashboard: ["analyst", "manager", "admin", "service"],
  record_payout_batch_approval: ["manager", "admin", "service"],
  execute_payouts: ["admin", "service"],
};

function resolveRuntimeEnvironment(
  override: AuthorizationRuntimeEnvironment | undefined
): AuthorizationRuntimeEnvironment {
  const parsedProcessEnv = AuthorizationRuntimeEnvironmentSchema.safeParse(
    process.env.NODE_ENV
  );
  // In production, ignore overrides to prevent downgrade attacks.
  if (parsedProcessEnv.success && parsedProcessEnv.data === "production") {
    return "production";
  }
  if (override !== undefined) {
    return override;
  }
  if (parsedProcessEnv.success) {
    return parsedProcessEnv.data;
  }
  // Unknown runtime mode should fail closed.
  return "production";
}

function resolveAllowTestBypass(override: boolean | undefined): boolean {
  const parsedEnv = AuthorizationRuntimeEnvironmentSchema.safeParse(
    process.env.NODE_ENV
  );
  if (parsedEnv.success && parsedEnv.data === "production") {
    return false;
  }
  if (override !== undefined) {
    return override;
  }
  const envValue = process.env.ALLOW_TEST_AUTH_BYPASS;
  return envValue === "1" || envValue === "true";
}

export function requiresToolAuthorization(toolName: GuardrailedToolName): boolean {
  return INTERNAL_TOOL_NAMES.has(toolName);
}

export function assertToolAuthorized(options: {
  toolName: GuardrailedToolName;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestBypass?: boolean;
}): ToolPrincipal {
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnvironment);
  const allowTestBypass = resolveAllowTestBypass(options.allowTestBypass);
  if (
    runtimeEnvironment === "test" &&
    allowTestBypass &&
    options.principal === undefined
  ) {
    return {
      principal_id: "test-auth-bypass",
      role: "service",
      scopes: [],
    };
  }

  if (!requiresToolAuthorization(options.toolName)) {
    if (options.principal === undefined) {
      return {
        principal_id: "anonymous",
        role: "viewer",
        scopes: [],
      };
    }
    return ToolPrincipalSchema.parse(options.principal);
  }

  if (options.principal === undefined) {
    throw new Error(`authorization required for tool ${options.toolName}`);
  }
  const principal = ToolPrincipalSchema.parse(options.principal);
  const allowedRoles = AUTHORIZED_ROLES_BY_TOOL[options.toolName];
  if (!allowedRoles.includes(principal.role)) {
    throw new Error(
      `principal role ${principal.role} is not authorized for tool ${options.toolName}`
    );
  }
  return principal;
}
