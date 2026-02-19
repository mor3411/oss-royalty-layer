import { z } from "zod";

const INVALID_CONSTRAINTS_PAYLOAD_MESSAGE = "invalid allocation constraint payload";
const SAFE_INTEGER_SCHEMA = z.number().int().safe();
export const MAX_ALLOCATION_CANDIDATES = 10_000;

export const AllocationConstraintCandidateSchema = z.object({
  library_id: z.string().min(1),
  maintainer_id: z.string().min(1),
  amount_minor: SAFE_INTEGER_SCHEMA,
});

export const ValidateAllocationConstraintsInputSchema = z.object({
  pool_amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  max_share_per_library: z.number().min(0).max(1).default(0.2),
  sum_tolerance_minor: SAFE_INTEGER_SCHEMA.nonnegative().default(0),
  allocations: z.array(AllocationConstraintCandidateSchema).max(MAX_ALLOCATION_CANDIDATES),
});

export const AllocationConstraintViolationSchema = z.object({
  code: z.enum([
    "schema_validation_failed",
    "negative_amount",
    "pool_sum_mismatch",
    "library_share_exceeded",
  ]),
  message: z.string().min(1),
  library_id: z.string().min(1).optional(),
  maintainer_id: z.string().min(1).optional(),
});

export const ValidateAllocationConstraintsResultSchema = z.object({
  status: z.enum(["valid", "invalid"]),
  total_allocated_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
  expected_pool_minor: SAFE_INTEGER_SCHEMA.positive(),
  violations: z.array(AllocationConstraintViolationSchema),
});

export type AllocationConstraintCandidate = z.infer<typeof AllocationConstraintCandidateSchema>;
export type ValidateAllocationConstraintsInput = z.infer<typeof ValidateAllocationConstraintsInputSchema>;
export type AllocationConstraintViolation = z.infer<typeof AllocationConstraintViolationSchema>;
export type ValidateAllocationConstraintsResult = z.infer<
  typeof ValidateAllocationConstraintsResultSchema
>;

function formatMinorRatio(amountMinor: number, poolAmountMinor: number): number {
  if (poolAmountMinor === 0) {
    return 0;
  }
  return amountMinor / poolAmountMinor;
}

function toSafeIntegerSum(left: number, right: number): number | null {
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(sum);
}

export function validateAllocationConstraints(
  input: unknown
): ValidateAllocationConstraintsResult {
  const parsedInput = ValidateAllocationConstraintsInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      status: "invalid",
      total_allocated_minor: 0,
      expected_pool_minor: 1,
      violations: [
        {
          code: "schema_validation_failed",
          message: INVALID_CONSTRAINTS_PAYLOAD_MESSAGE,
        },
      ],
    };
  }

  const values = parsedInput.data;
  const violations: AllocationConstraintViolation[] = [];
  const byLibrary = new Map<string, number>();

  let totalAllocatedMinor = 0;
  for (const allocation of values.allocations) {
    const nextTotalAllocatedMinor = toSafeIntegerSum(totalAllocatedMinor, allocation.amount_minor);
    if (nextTotalAllocatedMinor === null) {
      return {
        status: "invalid",
        total_allocated_minor: 0,
        expected_pool_minor: values.pool_amount_minor,
        violations: [
          {
            code: "schema_validation_failed",
            message: INVALID_CONSTRAINTS_PAYLOAD_MESSAGE,
          },
        ],
      };
    }
    totalAllocatedMinor = nextTotalAllocatedMinor;

    if (allocation.amount_minor < 0) {
      violations.push({
        code: "negative_amount",
        message: "allocation amount_minor must be non-negative",
        library_id: allocation.library_id,
        maintainer_id: allocation.maintainer_id,
      });
    }

    const currentLibraryAmount = byLibrary.get(allocation.library_id) ?? 0;
    const nextLibraryAmount = toSafeIntegerSum(currentLibraryAmount, allocation.amount_minor);
    if (nextLibraryAmount === null) {
      return {
        status: "invalid",
        total_allocated_minor: 0,
        expected_pool_minor: values.pool_amount_minor,
        violations: [
          {
            code: "schema_validation_failed",
            message: INVALID_CONSTRAINTS_PAYLOAD_MESSAGE,
          },
        ],
      };
    }

    byLibrary.set(allocation.library_id, nextLibraryAmount);
  }

  const poolDelta = Math.abs(totalAllocatedMinor - values.pool_amount_minor);
  if (poolDelta > values.sum_tolerance_minor) {
    violations.push({
      code: "pool_sum_mismatch",
      message: `allocations total ${totalAllocatedMinor} differs from pool ${values.pool_amount_minor} by ${poolDelta}`,
    });
  }

  const maxLibraryAmount = values.pool_amount_minor * values.max_share_per_library;
  for (const [libraryId, amountMinor] of byLibrary) {
    if (amountMinor > maxLibraryAmount) {
      const share = formatMinorRatio(amountMinor, values.pool_amount_minor);
      violations.push({
        code: "library_share_exceeded",
        library_id: libraryId,
        message: `library allocation share ${share.toFixed(6)} exceeds max share ${values.max_share_per_library.toFixed(
          6
        )}`,
      });
    }
  }

  return {
    status: violations.length === 0 ? "valid" : "invalid",
    total_allocated_minor: Math.max(0, totalAllocatedMinor),
    expected_pool_minor: values.pool_amount_minor,
    violations,
  };
}

export function assertAllocationConstraints(input: unknown): void {
  const result = validateAllocationConstraints(input);
  if (result.status === "valid") {
    return;
  }

  const details = result.violations.map((violation) => violation.message).join("; ");
  throw new Error(`allocation constraints violated: ${details}`);
}
