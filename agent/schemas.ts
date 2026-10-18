import { createHash } from "node:crypto";
import { z } from "zod";

export const MODULES = ["alertscenario", "metriccontract", "routereplay", "serieswatch", "dashboardreplay", "filterproof"] as const;
export type Module = (typeof MODULES)[number];

export const Verdict = z.object({
  result: z.enum(["pass", "fail", "inconclusive", "unsupported", "not_evaluated"]),
  scope: z.string(),
  reasons: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type Verdict = z.infer<typeof Verdict>;

export const ExperimentSpec = z.object({
  version: z.literal(1),
  project_id: z.string().uuid(),
  module: z.enum(MODULES),
  contract_hash: z.string(),
  fixture_version: z.string(),
  seed: z.number().int(),
  supported_parameters: z.record(z.string(), z.unknown()),
  limits: z.object({ max_steps: z.number().int().min(1).max(40), deadline_seconds: z.number().int().min(10).max(1800), max_model_tokens: z.number().int() }),
});
export type ExperimentSpec = z.infer<typeof ExperimentSpec>;

export const AgentAction = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  // The summary is an explanation, not an action: long text is truncated rather than rejected.
  decision_summary: z.string().transform((s) => s.slice(0, 400)),
});
export type AgentAction = z.infer<typeof AgentAction>;

export const ToolResult = z.object({
  action_id: z.string(),
  status: z.enum(["succeeded", "failed", "rejected"]),
  observed_at: z.string(),
  evidence_refs: z.array(z.string()),
  structured_observations: z.record(z.string(), z.unknown()),
  error_category: z.enum(["validation", "infrastructure", "timeout", "domain", "cancelled"]).nullable(),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const Finding = z.object({
  invariant_id: z.string(),
  expected: z.unknown(),
  observed: z.unknown(),
  evidence_refs: z.array(z.string()),
  severity: z.enum(["info", "low", "medium", "high"]),
  provenance: z.enum(["seeded", "reproduced", "observed"]),
  reproduction_ref: z.string().nullable(),
});
export type Finding = z.infer<typeof Finding>;

/** Canonical JSON (sorted keys) so equal content always hashes equally. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha256 = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex");
