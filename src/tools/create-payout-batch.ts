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
import { MaintainerSchema, PeriodSchema } from "../domain/index.js";
import { CurrencyCodeSchema } from "../shared/currency.js";
import {
  type AllocationPersistenceStore,
  getInMemoryPersistedAllocationByPeriod,
} from "./persist-allocations.js";

const SAFE_INTEGER_SCHEMA = z.number().int().safe();

const MaintainerPayoutProfileSchema = MaintainerSchema.pick({
  id: true,
  payout_account: true,
  verification_status: true,
});

export const PayoutBatchEntrySchema = z.object({
  maintainer_id: z.string().min(1),
  amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  currency: CurrencyCodeSchema,
  payout_account: z.object({
    provider: z.enum(["stripe", "adyen", "other"]),
    account_id: z.string().min(1),
  }),
  allocation_count: SAFE_INTEGER_SCHEMA.positive(),
});

export const PayoutBatchFlagSchema = z.object({
  maintainer_id: z.string().min(1),
  amount_minor: SAFE_INTEGER_SCHEMA.positive(),
  allocation_count: SAFE_INTEGER_SCHEMA.positive(),
  reason: z.enum([
    "maintainer_not_found",
    "maintainer_not_verified",
    "payout_account_missing",
  ]),
  verification_status: z.enum(["unverified", "pending", "verified", "rejected"]).optional(),
});

export const CreatePayoutBatchInputSchema = z.object({
  period: PeriodSchema,
  currency: CurrencyCodeSchema.default("USD"),
});

export const CreatePayoutBatchOutputSchema = z.object({
  period: PeriodSchema,
  currency: CurrencyCodeSchema,
  payouts: z.array(PayoutBatchEntrySchema),
  flagged: z.array(PayoutBatchFlagSchema),
  totals: z.object({
    total_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
    eligible_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
    flagged_amount_minor: SAFE_INTEGER_SCHEMA.nonnegative(),
  }),
  notes: z.string().min(1),
});

export type MaintainerPayoutProfile = z.infer<typeof MaintainerPayoutProfileSchema>;
export type PayoutBatchEntry = z.infer<typeof PayoutBatchEntrySchema>;
export type PayoutBatchFlag = z.infer<typeof PayoutBatchFlagSchema>;
export type CreatePayoutBatchInput = z.infer<typeof CreatePayoutBatchInputSchema>;
export type CreatePayoutBatchOutput = z.infer<typeof CreatePayoutBatchOutputSchema>;

type CreatePayoutBatchOptions = {
  allocationStore?: Pick<AllocationPersistenceStore, "readByPeriod">;
  resolveMaintainer?:
    (maintainerId: string) => Promise<MaintainerPayoutProfile | null> | MaintainerPayoutProfile | null;
  principal?: unknown;
  runtimeEnvironment?: AuthorizationRuntimeEnvironment;
  allowTestAuthBypass?: boolean;
  maxAllowedRisk?: ToolRiskLevel;
  maxGuardrailInputBytes?: number;
};

const inMemoryMaintainerProfiles = new Map<string, MaintainerPayoutProfile>();

function toSafeIntegerSum(left: number, right: number): number | null {
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(sum);
}

function cloneMaintainerProfile(profile: MaintainerPayoutProfile): MaintainerPayoutProfile {
  return {
    ...profile,
    ...(profile.payout_account === undefined
      ? {}
      : {
          payout_account:
            profile.payout_account === null ? null : { ...profile.payout_account },
        }),
  };
}

function getDefaultMaintainerProfile(maintainerId: string): MaintainerPayoutProfile | null {
  const profile = inMemoryMaintainerProfiles.get(maintainerId);
  return profile ? cloneMaintainerProfile(profile) : null;
}

export function clearInMemoryMaintainerProfiles(): void {
  inMemoryMaintainerProfiles.clear();
}

export function upsertInMemoryMaintainerProfile(input: unknown): MaintainerPayoutProfile {
  const profile = MaintainerPayoutProfileSchema.parse(input);
  inMemoryMaintainerProfiles.set(profile.id, cloneMaintainerProfile(profile));
  return cloneMaintainerProfile(profile);
}

export function getInMemoryMaintainerProfiles(): MaintainerPayoutProfile[] {
  return [...inMemoryMaintainerProfiles.values()]
    .map((profile) => cloneMaintainerProfile(profile))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function defaultReadAllocationByPeriod(period: string) {
  return getInMemoryPersistedAllocationByPeriod(period);
}

export async function createPayoutBatch(
  input: unknown,
  options: CreatePayoutBatchOptions = {}
): Promise<CreatePayoutBatchOutput> {
  assertToolAuthorized({
    toolName: "create_payout_batch",
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.runtimeEnvironment === undefined
      ? {}
      : { runtimeEnvironment: options.runtimeEnvironment }),
    ...(options.allowTestAuthBypass === undefined
      ? {}
      : { allowTestBypass: options.allowTestAuthBypass }),
  });
  assertToolRiskAllowed({
    toolName: "create_payout_batch",
    maxAllowedRisk: options.maxAllowedRisk ?? "high",
  });
  assertToolInputVetting("create_payout_batch", input, {
    maxBytes: options.maxGuardrailInputBytes ?? DEFAULT_MAX_GUARDRAIL_INPUT_BYTES,
  });

  const parsedInput = CreatePayoutBatchInputSchema.parse(input);
  const allocationStore = options.allocationStore ?? {
    readByPeriod: defaultReadAllocationByPeriod,
  };
  const allocationRecord = await allocationStore.readByPeriod(parsedInput.period);
  if (!allocationRecord) {
    throw new Error(`no persisted allocations found for period ${parsedInput.period}`);
  }

  const byMaintainer = new Map<string, { amount_minor: number; allocation_count: number }>();
  for (const allocation of allocationRecord.allocations) {
    const current = byMaintainer.get(allocation.maintainer_id) ?? {
      amount_minor: 0,
      allocation_count: 0,
    };
    const nextAmountMinor = toSafeIntegerSum(current.amount_minor, allocation.amount_minor);
    const nextAllocationCount = toSafeIntegerSum(current.allocation_count, 1);
    if (nextAmountMinor === null || nextAllocationCount === null) {
      throw new Error(
        `allocation aggregation overflow for maintainer ${allocation.maintainer_id}`
      );
    }
    byMaintainer.set(allocation.maintainer_id, {
      amount_minor: nextAmountMinor,
      allocation_count: nextAllocationCount,
    });
  }

  const resolveMaintainer = options.resolveMaintainer ?? getDefaultMaintainerProfile;
  const payouts: PayoutBatchEntry[] = [];
  const flagged: PayoutBatchFlag[] = [];

  const orderedMaintainerIds = [...byMaintainer.keys()].sort((left, right) =>
    left.localeCompare(right)
  );
  for (const maintainerId of orderedMaintainerIds) {
    const aggregate = byMaintainer.get(maintainerId);
    if (!aggregate || aggregate.amount_minor <= 0) {
      continue;
    }

    const profile = await resolveMaintainer(maintainerId);
    if (!profile) {
      flagged.push({
        maintainer_id: maintainerId,
        amount_minor: aggregate.amount_minor,
        allocation_count: aggregate.allocation_count,
        reason: "maintainer_not_found",
      });
      continue;
    }

    if (profile.verification_status !== "verified") {
      flagged.push({
        maintainer_id: maintainerId,
        amount_minor: aggregate.amount_minor,
        allocation_count: aggregate.allocation_count,
        reason: "maintainer_not_verified",
        verification_status: profile.verification_status,
      });
      continue;
    }

    if (!profile.payout_account) {
      flagged.push({
        maintainer_id: maintainerId,
        amount_minor: aggregate.amount_minor,
        allocation_count: aggregate.allocation_count,
        reason: "payout_account_missing",
        verification_status: profile.verification_status,
      });
      continue;
    }

    payouts.push({
      maintainer_id: maintainerId,
      amount_minor: aggregate.amount_minor,
      currency: parsedInput.currency,
      payout_account: profile.payout_account,
      allocation_count: aggregate.allocation_count,
    });
  }

  let totalAmountMinor = 0;
  for (const entry of byMaintainer.values()) {
    const next = toSafeIntegerSum(totalAmountMinor, entry.amount_minor);
    if (next === null) {
      throw new Error("payout total_amount_minor overflow");
    }
    totalAmountMinor = next;
  }
  let eligibleAmountMinor = 0;
  for (const payout of payouts) {
    const next = toSafeIntegerSum(eligibleAmountMinor, payout.amount_minor);
    if (next === null) {
      throw new Error("payout eligible_amount_minor overflow");
    }
    eligibleAmountMinor = next;
  }
  let flaggedAmountMinor = 0;
  for (const item of flagged) {
    const next = toSafeIntegerSum(flaggedAmountMinor, item.amount_minor);
    if (next === null) {
      throw new Error("payout flagged_amount_minor overflow");
    }
    flaggedAmountMinor = next;
  }

  const recomputedTotal = toSafeIntegerSum(eligibleAmountMinor, flaggedAmountMinor);
  if (recomputedTotal === null || recomputedTotal !== totalAmountMinor) {
    throw new Error("payout batch totals are inconsistent");
  }

  const output: CreatePayoutBatchOutput = {
    period: parsedInput.period,
    currency: parsedInput.currency,
    payouts,
    flagged,
    totals: {
      total_amount_minor: totalAmountMinor,
      eligible_amount_minor: eligibleAmountMinor,
      flagged_amount_minor: flaggedAmountMinor,
    },
    notes: `grouped ${allocationRecord.allocations.length} allocations into ${payouts.length} eligible payouts and ${flagged.length} flagged maintainer entries`,
  };
  assertToolOutputSanity("create_payout_batch", output);
  return output;
}
