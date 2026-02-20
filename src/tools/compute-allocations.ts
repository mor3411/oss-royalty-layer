import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertToolAuthorized,
  type AuthorizationRuntimeEnvironment,
} from "./authz.js";
import {
  DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  assertToolInputVetting,
  assertToolOutputSanity,
  assertToolRiskAllowed,
  type ToolRiskLevel,
} from "./guardrails.js";
import { validateAllocationConstraints } from "./allocation-constraints.js";

const SAFE_INTEGER_SCHEMA = z.number().int().safe();

const PeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const UsageStatSchema = z.object({
  library_id: z.string().min(1),
  total_calls: SAFE_INTEGER_SCHEMA.nonnegative(),
  unique_sessions: SAFE_INTEGER_SCHEMA.nonnegative(),
});

export const ComputeAllocationsPolicySchema = z.object({
  max_share_per_library: z.number().min(0).max(1).default(0.2),
  min_floor_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative().default(0),
  long_tail_weight: z.number().positive().default(1),
});

export const ComputeAllocationsInputSchema = z.object({
  period: PeriodSchema,
  pool_amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  usage_stats: z.array(UsageStatSchema).min(1),
  policy_config: ComputeAllocationsPolicySchema.optional(),
});

export const AllocationProposalSchema = z.object({
  library_id: z.string().min(1),
  maintainer_id: z.string().min(1),
  amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
  confidence_score: z.number().min(0).max(1),
  flags: z.array(z.string().min(1)),
});

export const AppliedAllocationPolicySchema = z.object({
  configured_max_share_per_library: z.number().min(0).max(1),
  effective_max_share_per_library: z.number().min(0).max(1),
  min_floor_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
  long_tail_weight: z.number().positive(),
});

export const ComputeAllocationsOutputSchema = z.object({
  period: PeriodSchema,
  pool_amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  policy_applied: AppliedAllocationPolicySchema,
  allocations: z.array(AllocationProposalSchema),
  notes: z.string().min(1),
});

export type UsageStat = z.infer<typeof UsageStatSchema>;
export type ComputeAllocationsPolicy = z.infer<typeof ComputeAllocationsPolicySchema>;
export type ComputeAllocationsInput = z.infer<typeof ComputeAllocationsInputSchema>;
export type AllocationProposal = z.infer<typeof AllocationProposalSchema>;
export type AppliedAllocationPolicy = z.infer<typeof AppliedAllocationPolicySchema>;
export type ComputeAllocationsOutput = z.infer<typeof ComputeAllocationsOutputSchema>;

type ComputeAllocationsOptions = {
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
  resolveMaintainerId?: (libraryId: string) => Promise<string> | string;
};

type RankedUsage = UsageStat & {
  score: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toDeterministicMaintainerId(libraryId: string): string {
  const digest = createHash("sha256")
    .update("maintainer:")
    .update(libraryId)
    .digest("hex");
  return `mnt_${digest.slice(0, 24)}`;
}

function scoreUsage(
  usage: UsageStat,
  longTailWeight: number
): number {
  const callsWeight = Math.log1p(usage.total_calls);
  const sessionsWeight = Math.log1p(usage.unique_sessions);
  const longTailBoost = 1 + longTailWeight / Math.sqrt(usage.unique_sessions + 1);
  const score = callsWeight * longTailBoost + sessionsWeight;
  return score > 0 ? score : 1;
}

/**
 * Converts float weights to integer-scaled values suitable for BigInt
 * arithmetic.  Each weight is multiplied by a large scaling factor and
 * rounded, which preserves relative proportions while allowing all
 * subsequent division to happen in BigInt (no float precision loss on
 * monetary amounts).
 */
function toScaledBigIntWeights(weights: number[]): bigint[] {
  // Scale factor: 10^12 – enough precision for log-based scores
  return weights.map((w) => {
    const scaled = Math.round(w * 1e12);
    return scaled > 0 ? BigInt(scaled) : 0n;
  });
}

function distributeProportionally(
  total: number,
  weights: number[],
  tieBreakerKeys: string[]
): number[] {
  if (total <= 0 || weights.length === 0) {
    return weights.map(() => 0);
  }

  const sanitizedWeights = weights.map((weight) => (weight > 0 ? weight : 0));
  const totalWeight = sanitizedWeights.reduce((sum, weight) => sum + weight, 0);
  const effectiveWeights =
    totalWeight > 0
      ? sanitizedWeights
      : sanitizedWeights.map(() => 1);

  // Use BigInt arithmetic to avoid float precision loss on monetary values.
  const bigTotal = BigInt(total);
  const scaledWeights = toScaledBigIntWeights(effectiveWeights);
  const bigTotalWeight = scaledWeights.reduce((sum, w) => sum + w, 0n);

  if (bigTotalWeight === 0n) {
    return effectiveWeights.map(() => 0);
  }

  const allocations = scaledWeights.map((w) =>
    Number((bigTotal * w) / bigTotalWeight)
  );
  let remainder = total - allocations.reduce((sum, amount) => sum + amount, 0);
  if (remainder <= 0) {
    return allocations;
  }

  // Rank by fractional remainder (computed via BigInt modular arithmetic) to
  // distribute the leftover units one-at-a-time in largest-remainder order.
  const rankedRemainders = scaledWeights
    .map((w, index) => {
      const rem = (bigTotal * w) % bigTotalWeight;
      return {
        index,
        // Scale remainder to a comparable float; precision loss here is
        // acceptable because we only need a ranking, not an exact value.
        fractional: Number(rem) / Number(bigTotalWeight),
        tieBreaker: tieBreakerKeys[index] ?? "",
      };
    })
    .sort((left, right) => {
      if (right.fractional !== left.fractional) {
        return right.fractional - left.fractional;
      }
      return left.tieBreaker.localeCompare(right.tieBreaker);
    });

  for (let index = 0; index < rankedRemainders.length && remainder > 0; index += 1) {
    const ranked = rankedRemainders[index];
    if (!ranked) {
      continue;
    }
    allocations[ranked.index] = (allocations[ranked.index] ?? 0) + 1;
    remainder -= 1;
  }

  return allocations;
}

function enforceMaxShareCap(
  amounts: number[],
  capAmount: number,
  scores: number[],
  libraryIds: string[]
): { amounts: number[]; cappedIndices: Set<number> } {
  const nextAmounts = [...amounts];
  const cappedIndices = new Set<number>();
  let excess = 0;

  for (let index = 0; index < nextAmounts.length; index += 1) {
    const amount = nextAmounts[index] ?? 0;
    if (amount <= capAmount) {
      continue;
    }
    excess += amount - capAmount;
    nextAmounts[index] = capAmount;
    cappedIndices.add(index);
  }

  const maxIterations = nextAmounts.length * 4;
  let iteration = 0;
  while (excess > 0 && iteration < maxIterations) {
    iteration += 1;
    const eligibleIndices: number[] = [];
    const eligibleWeights: number[] = [];
    const eligibleIds: string[] = [];

    for (let index = 0; index < nextAmounts.length; index += 1) {
      const amount = nextAmounts[index] ?? 0;
      if (amount >= capAmount) {
        continue;
      }
      eligibleIndices.push(index);
      eligibleWeights.push(scores[index] ?? 1);
      eligibleIds.push(libraryIds[index] ?? `idx-${index}`);
    }

    if (eligibleIndices.length === 0) {
      break;
    }

    const proposed = distributeProportionally(excess, eligibleWeights, eligibleIds);
    let distributed = 0;
    for (let index = 0; index < eligibleIndices.length; index += 1) {
      const targetIndex = eligibleIndices[index];
      if (targetIndex === undefined) {
        continue;
      }

      const currentAmount = nextAmounts[targetIndex] ?? 0;
      const maxIncrement = capAmount - currentAmount;
      if (maxIncrement <= 0) {
        continue;
      }

      const proposedIncrement = proposed[index] ?? 0;
      const appliedIncrement = Math.min(maxIncrement, proposedIncrement);
      nextAmounts[targetIndex] = currentAmount + appliedIncrement;
      distributed += appliedIncrement;

      if ((nextAmounts[targetIndex] ?? 0) >= capAmount) {
        cappedIndices.add(targetIndex);
      }
    }

    if (distributed <= 0) {
      break;
    }
    excess -= distributed;
  }

  if (excess > 0) {
    throw new Error("unable to satisfy max_share_per_library cap while allocating full pool");
  }

  return { amounts: nextAmounts, cappedIndices };
}

function toConfidenceScore(
  usage: UsageStat,
  flags: string[]
): number {
  let confidence =
    0.4 +
    Math.min(0.35, Math.log10(usage.total_calls + 1) / 3) +
    Math.min(0.25, Math.log10(usage.unique_sessions + 1) / 3);
  if (flags.includes("low_usage_signal")) {
    confidence -= 0.2;
  }
  if (flags.includes("effective_max_share_relaxed")) {
    confidence -= 0.1;
  }
  if (flags.includes("max_share_capped")) {
    confidence -= 0.05;
  }
  return Number(clamp(confidence, 0.05, 0.99).toFixed(4));
}

export async function computeAllocations(
  input: unknown,
  options: ComputeAllocationsOptions = {}
): Promise<ComputeAllocationsOutput> {
  assertToolAuthorized({
    toolName: "compute_allocations",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "compute_allocations",
    ...(options.maxAllowedRisk === undefined
      ? {}
      : { maxAllowedRisk: options.maxAllowedRisk }),
  });
  assertToolInputVetting("compute_allocations", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = ComputeAllocationsInputSchema.parse(input);
  const policy = ComputeAllocationsPolicySchema.parse(parsedInput.policy_config ?? {});
  const activeUsage = parsedInput.usage_stats.filter((usage) => usage.total_calls > 0);
  if (activeUsage.length === 0) {
    throw new Error("usage_stats must include at least one library with positive total_calls");
  }

  const rankedUsage: RankedUsage[] = activeUsage
    .map((usage) => ({
      ...usage,
      score: scoreUsage(usage, policy.long_tail_weight),
    }))
    .sort((left, right) => left.library_id.localeCompare(right.library_id));

  const minFeasibleShare = 1 / rankedUsage.length;
  const effectiveMaxShare = Math.max(policy.max_share_per_library, minFeasibleShare);
  const maxShareRelaxed = effectiveMaxShare !== policy.max_share_per_library;

  const capAmount = Math.max(1, Math.floor(parsedInput.pool_amount_minor * effectiveMaxShare));
  const floorAmount = Math.min(
    policy.min_floor_amount_minor,
    Math.floor(parsedInput.pool_amount_minor / rankedUsage.length),
    capAmount
  );
  const amounts = rankedUsage.map(() => floorAmount);
  const remaining = parsedInput.pool_amount_minor - floorAmount * rankedUsage.length;
  const proportional = distributeProportionally(
    remaining,
    rankedUsage.map((usage) => usage.score),
    rankedUsage.map((usage) => usage.library_id)
  );
  for (let index = 0; index < amounts.length; index += 1) {
    amounts[index] = (amounts[index] ?? 0) + (proportional[index] ?? 0);
  }

  const { amounts: cappedAmounts, cappedIndices } = enforceMaxShareCap(
    amounts,
    capAmount,
    rankedUsage.map((usage) => usage.score),
    rankedUsage.map((usage) => usage.library_id)
  );

  const resolver = options.resolveMaintainerId ?? toDeterministicMaintainerId;
  const allocations: AllocationProposal[] = [];
  for (let index = 0; index < rankedUsage.length; index += 1) {
    const usage = rankedUsage[index];
    if (!usage) {
      continue;
    }
    const flags: string[] = [];
    if (usage.total_calls < 5 || usage.unique_sessions < 2) {
      flags.push("low_usage_signal");
    }
    if (cappedIndices.has(index)) {
      flags.push("max_share_capped");
    }
    if (maxShareRelaxed) {
      flags.push("effective_max_share_relaxed");
    }

    const maintainerId = await resolver(usage.library_id);
    allocations.push({
      library_id: usage.library_id,
      maintainer_id: maintainerId,
      amount_minor: cappedAmounts[index] ?? 0,
      confidence_score: toConfidenceScore(usage, flags),
      flags,
    });
  }

  const totalAllocated = allocations.reduce(
    (sum, allocation) => sum + BigInt(allocation.amount_minor),
    0n
  );
  if (totalAllocated !== BigInt(parsedInput.pool_amount_minor)) {
    throw new Error(
      `allocation total ${totalAllocated} does not equal pool ${parsedInput.pool_amount_minor}`
    );
  }

  const constraintResult = validateAllocationConstraints(
    {
      pool_amount_minor: parsedInput.pool_amount_minor,
      max_share_per_library: effectiveMaxShare,
      allocations: allocations.map((allocation) => ({
        library_id: allocation.library_id,
        maintainer_id: allocation.maintainer_id,
        amount_minor: allocation.amount_minor,
      })),
    },
    {
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.runtimeEnvironment === undefined
        ? {}
        : { runtimeEnvironment: options.runtimeEnvironment }),
      ...(options.allowTestAuthBypass === undefined
        ? {}
        : { allowTestAuthBypass: options.allowTestAuthBypass }),
    }
  );
  if (constraintResult.status !== "valid") {
    const details = constraintResult.violations
      .map((violation) => violation.message)
      .join("; ");
    throw new Error(`computed allocations failed constraints: ${details}`);
  }

  const policyApplied: AppliedAllocationPolicy = {
    configured_max_share_per_library: policy.max_share_per_library,
    effective_max_share_per_library: effectiveMaxShare,
    min_floor_amount_minor: floorAmount,
    long_tail_weight: policy.long_tail_weight,
  };
  const notesParts = [
    `computed ${allocations.length} allocations for period ${parsedInput.period}`,
    `pool=${parsedInput.pool_amount_minor}`,
    `effective_max_share=${policyApplied.effective_max_share_per_library.toFixed(6)}`,
    `floor=${policyApplied.min_floor_amount_minor}`,
  ];
  if (maxShareRelaxed) {
    notesParts.push("max_share_per_library relaxed to satisfy feasible distribution");
  }

  const output: ComputeAllocationsOutput = {
    period: parsedInput.period,
    pool_amount_minor: parsedInput.pool_amount_minor,
    policy_applied: policyApplied,
    allocations,
    notes: notesParts.join("; "),
  };
  assertToolOutputSanity("compute_allocations", output);
  return output;
}
