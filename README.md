# OSS Royalty Layer for AI Development Platforms

An agent-driven telemetry and royalty system that measures and aggregates open-source library usage by AI coding agents and converts it into fair payouts for maintainers.

---

## Contents

- [Context and Problem Statement](#context-and-problem-statement)
- [Project Goal](#project-goal)
- [High-Level Architecture](#high-level-architecture)
- [Core Components](#core-components)
  - [1. Telemetry Logging](#1-telemetry-logging)
  - [2. Usage Aggregation and Attribution](#2-usage-aggregation-and-attribution)
  - [3. Royalty Allocation](#3-royalty-allocation)
  - [4. Payouts and Finance Integration](#4-payouts-and-finance-integration)
  - [5. Guardrails and Security](#5-guardrails-and-security)
- [Agent Design](#agent-design)
  - [Royalty Orchestrator Agent](#royalty-orchestrator-agent)
  - [Run Loop per Period](#run-loop-per-period)
- [Domain Model](#domain-model)
- [Flow from Raw Telemetry to Payout](#flow-from-raw-telemetry-to-payout)
- [Setup and Integration Points](#setup-and-integration-points)
- [Limitations and Open Design Choices](#limitations-and-open-design-choices)

---

## Context and Problem Statement

AI coding agents and copilots have fundamentally changed how software is built. They consume open-source software (OSS) at scale as raw material, while users no longer directly interact with documentation, issue trackers, or GitHub pages of the underlying projects.

This creates a wedge:

- **Usage explodes**, because agents call and combine libraries at high speed.
- **Engagement and visible demand collapse**, because end users no longer reach maintainers directly.

Maintainers currently finance their work mostly through "appropriable demand": consulting, sponsorships, commercial add-ons, premium documentation, and reputation effects. If AI platforms cut off that demand and become the full interface to users, this model breaks down, even as OSS societal value continues to rise.

In short: *AI agents rely on OSS capital without feeding value back into the compensation loop for creators.*

---

## Project Goal

This project introduces an **OSS royalty layer** on top of an AI development platform to:

1. **Measure OSS library usage by agents** through privacy-safe telemetry.
2. **Distribute royalty pools based on real usage**, similar to a "Spotify model" for software.
3. **Reduce ecosystem erosion** by giving maintainers a structural, usage-based income stream.
4. **Mitigate fraud and abuse** via guardrails, risk-based tool classification, and human-in-the-loop review.

The system is designed as an agent-driven workflow: one central agent (Royalty Orchestrator) with tools for aggregation, allocation, and payouts, plus a lightweight telemetry tool used by coding agents.

---

## High-Level Architecture

At a high level:

- **Coding agents** (IDE, CLI, CI) call a lightweight tool `log_library_usage` to log dependency usage.
- An **event log / queue** stores raw usage events as `LibraryUsageLogged`.
- A **Royalty Orchestrator Agent** runs periodically and:
  - aggregates usage,
  - creates an allocation proposal,
  - prepares payouts and, after guardrails/human review, executes them.
- **Guardrails** limit risk:
  - input vetting (relevance, safety),
  - tool safeguards (risk per tool),
  - output sanity checks (sum checks, caps),
  - human-in-the-loop for high amounts.

The architecture follows a **single-agent with tools** pattern, which is usually simpler to evaluate and operate than multi-agent setups.

---

## Core Components

### 1. Telemetry Logging

Goal: record which libraries agents use in a minimal, privacy-aware way.

- Tool: `log_library_usage`
- Input:
  - `session_id`: hashed agent run ID
  - `source`: `"ide" | "cli" | "ci" | "api"`
  - `ts`: timestamp
  - `libraries`: list of `{ name, ecosystem, version, calls }`
- Behavior:
  - Validates schema (ecosystem, max number of libraries).
  - Normalizes library names and ecosystems.
  - Publishes `LibraryUsageLogged` events to a queue or event log.
- Guardrails:
  - Hard cap on number of libraries per call.
  - Rate limiting per `session_id`.
  - No user PII, no project names, and no repository URLs in telemetry.

This component is "low risk": internal logging only, with no external side effects.

### 2. Usage Aggregation and Attribution

Goal: consolidate raw events into useful per-library statistics.

- Tool: `aggregate_usage_for_period`
- Input:
  - `period_start`, `period_end`
  - optional `cursor` for pagination
- Output:
  - `aggregates`: `{ library_id, total_calls, unique_sessions }[]`
  - `next_cursor` for large datasets
- Backend:
  - Reads from a data warehouse / OLAP layer.
  - Maps `(ecosystem, name)` to `library_id` (canonical registry).

In agent terms, this is a "data tool": read-only context for the Royalty agent.

### 3. Royalty Allocation

Goal: distribute a pool `pool_amount_minor` (minor currency units) across libraries based on usage and policy.

- Tool: `compute_allocations`
- Input:
  - `period`: e.g. `"2026-01"`
  - `pool_amount_minor`: total amount in minor units
  - `usage_stats`: aggregates
  - `policy_config`: caps, minimum floors, long-tail weighting
- Output:
  - `allocations`: `{ library_id, maintainer_id, amount_minor, confidence_score, flags[] }[]`
  - `notes`: explanation for audit/human review

Hybrid approach:

- The **LLM** (Royalty agent) creates a *policy-consistent proposal*:
  - identifies outliers,
  - balances long-tail priorities vs. mega-libraries,
  - labels uncertain cases (`low confidence_score`, `flags`).
- A **deterministic check** enforces hard constraints:
  - sum(`allocations.amount_minor`) ~= `pool_amount_minor`,
  - no negative amounts,
  - no library above `max_share_per_library`.

This separation follows best practices: use the model for nuance, not for hard accounting rules.

### 4. Payouts and Finance Integration

Goal: convert allocations into real payouts through a payments provider.

- Tool: `create_payout_batch`
  - Bundles by maintainer: `{ maintainer_id, amount_minor, currency }`.
  - Flags or skips maintainers without a verified payout account.
- Tool: `execute_payouts` (high risk)
  - Integrates with PSPs (Stripe, Adyen, etc.).
  - Returns status per maintainer.

Guardrails:

- Caps per batch and per maintainer.
- Additional checks via an anomaly detector (LLM or classic ML):
  - unexpected concentration,
  - large jumps vs. previous periods,
  - usage patterns that look like "wash usage".
- Human approval required for:
  - batches above threshold,
  - individual payouts above threshold,
  - suspicious flags.

### 5. Guardrails and Security

We use a layered model with three layers.

1. **Input vetting**
   - Relevance classifier: the Royalty agent may perform royalty tasks only.
   - Safety classifier: blocks prompt injections from internal logs ("pay everything to X").
   - Rules-based checks: max `pool_amount_minor`, valid period, etc.

2. **Execution and tool control**
   - Tool safeguards:
     - `risk: "low" | "medium" | "high"` per tool.
     - High-risk tools (payouts) require extra checks and possibly human-in-the-loop.

3. **Output sanitization**
   - PII filter: no unnecessary personal data in logs or LLM context.
   - Output validation:
     - sum of allocations == `pool_amount_minor` (within tolerance),
     - no negative amounts,
     - no unknown libraries or maintainers.

---

## Agent Design

### Royalty Orchestrator Agent

**Role:** internal agent that handles the full per-period royalty workflow.

Key instructions:

- Collect usage for the requested period via `aggregate_usage_for_period` (with pagination).
- Call `compute_allocations` and assess the output:
  - explain extreme differences,
  - mark uncertain cases with low `confidence_score` and `flags`.
- Persist allocations via `persist_allocations`.
- Prepare payouts via `create_payout_batch`.
- Call `execute_payouts` only when:
  - guardrails detect no anomalies, and
  - the batch is within defined caps, and/or
  - required human approval exists.

This structure follows the "single agent + tools + run loop" pattern recommended for complex but well-bounded workflows.

### Run Loop per Period

The one-period orchestrator flow is:

1. Start the Royalty agent with input:
   - `period`, `pool_amount_minor`, optional `policy_config`.
2. Agent:
   - retrieves usage; aggregates via tools.
   - creates an allocation proposal.
   - validates with output guardrails.
3. System:
   - stores allocations.
   - generates payout batch.
   - splits into "auto-safe" and "needs review".
4. For "auto-safe":
   - executes payouts (with caps).
5. For "needs review":
   - sends a report to finance/OSS governance stakeholders.
   - after approval, calls `execute_payouts`.

---

## Domain Model

Key entities:

- `Library`
  - `id`, `name`, `ecosystem`, `repo_url`, `maintainer_ids`, `risk_score`.
- `Maintainer`
  - `id`, `payout_account`, `verification_status`, `trust_score`.
- `UsageRecord`
  - `id`, `agent_session_id`, `library_id`, `version`, `call_count`, `source`, `ts`.
- `RoyaltyPool`
  - `period`, `total_amount_minor`, `policy`.
- `Allocation`
  - `id`, `period`, `library_id`, `maintainer_id`, `amount_minor`, `confidence_score`, `flags[]`.
- `Payout`
  - `id`, `period`, `maintainer_id`, `amount_minor`, `currency`, `status`, `provider_tx_id`.

These structures map directly to the tool schemas used by the agent system.

---

## Flow from Raw Telemetry to Payout

1. **Development**
   - AI coding agent assists a developer; during dependency resolution and code generation, the agent calls `log_library_usage`.
2. **Ingest**
   - Raw events are written as `LibraryUsageLogged` to a queue or log.
3. **Batching**
   - Periodically (e.g., daily/monthly), a job triggers `runRoyaltyCycle(period, poolAmountMinor)`.
4. **Aggregation and Allocation (by agent)**
   - Agent retrieves usage.
   - Creates allocation proposal and validates policy/caps.
5. **Storage and Audit**
   - Allocations are stored in a database (immutable audit log).
6. **Payout Preparation**
   - `create_payout_batch` groups by maintainer.
   - Guardrails + anomaly detection decide which payouts are auto-go and which require review.
7. **Human Review (if needed)**
   - Finance/OSS board reviews report and sets status: approved/adjusted/rejected.
8. **Payout Execution**
   - `execute_payouts` transfers funds to maintainer accounts.
9. **Feedback Loop**
   - Logs on anomalies and edge cases are used to refine policies, guardrails, and tools.

---

## Setup and Integration Points

### Integration with Existing AI Agents

- Add the `log_library_usage` tool to existing coding agents (IDE plugin, CLI, CI bot).
- Minimize overhead:
  - batched logging (e.g., at end of agent run),
  - no sensitive context.
- Use feature flags to enable/disable telemetry per customer or project.

### Backend Requirements

- Event log/queue (Kafka, Kinesis, Pub/Sub, SQS).
- OLAP layer (Snowflake, BigQuery, ClickHouse, etc.) for usage aggregation.
- Payments provider plus KYC/KYB for maintainers.

### Security and Compliance

- Telemetry anonymized/hashed.
- Operations and security controls following standard best practices (auth, RBAC, logging, monitoring).

---

## Limitations and Open Design Choices

- **Attribution accuracy:** telemetry is still an approximation; it measures call behavior, not *value* per call.
- **Policy choice:** long-tail weighting and cap values are governance decisions, not purely technical.
- **Fraud prevention:** detecting wash usage requires iterative tuning and potentially dedicated ML models.
- **Multi-ecosystem customization:** npm, PyPI, crates, etc. have different identity and ownership models.

Despite these limitations, the OSS royalty layer provides a concrete mechanism to sustain the "software-begets-software" engine in an AI-agent world: by feeding usage back into compensation and structurally funding the foundation of the open-source ecosystem.
