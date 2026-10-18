import type { z } from "zod";
import type { Finding, Module, Verdict } from "../agent/schemas.ts";

export type Observations = Record<string, unknown>;

export interface RunContext {
  runId: string;
  shortId: string; // first 8 chars of the run id; prefixes every owned external resource
  seed: number;
  contract: any;
  fixture: { name: string; version: string; manifest: any };
  /** Persist a named evidence artifact; returns its id for evidence_refs. */
  artifact(kind: string, name: string, content: unknown): Promise<string>;
  log(event: string, detail?: Record<string, unknown>): void;
  /** Throws if the run was cancelled or passed its deadline. */
  checkpoint(): Promise<void>;
  /** Shared, cross-tool memory for this run (scenario results etc.). Rebuilt from tool_calls on resume. */
  memory: Record<string, any>;
}

export interface ToolDef<A = any> {
  name: string; // namespaced: "<module>.<verb>"
  description: string;
  args: z.ZodType<A>;
  timeoutMs: number;
  /** Mutating tools change a system under test; read-only tools only observe. */
  mutating: boolean;
  /** Counts against the experiment budget even though it only observes (e.g. a costly probe). */
  budgeted?: boolean;
  run(ctx: RunContext, args: A): Promise<{ observations: Observations; evidence: string[] }>;
}

export interface FixtureDef {
  name: string;
  version: string;
  title: string;
  manifest: any; // public: what the candidate is and which inputs it supports
  fault: any | null; // private: seeded defect truth for evaluation; never shown to the agent
}

export interface EvalResult {
  verdict: Verdict;
  findings: Finding[];
  summary: Record<string, unknown>;
}

export interface ModuleDef {
  id: Module;
  title: string;
  tagline: string;
  plain: { job: string; example: string; howItWorks: string[]; notThis: string };
  contractSchema: z.ZodType<any>;
  defaultContract: any;
  fixtures: FixtureDef[];
  tools: ToolDef[];
  /** Fixed scenario matrix used by the deterministic baseline (same tools, same budget). */
  baselinePlan(contract: any): { tool: string; args: any }[];
  /** Budget in tool calls for both baseline and agent runs. */
  budget: number;
  /** Public summary the model sees each step: contract, results so far. Never private faults. */
  agentView(ctx: RunContext): Record<string, unknown>;
  evaluate(ctx: RunContext): EvalResult;
  /** Remove only resources owned by this run. */
  cleanup(ctx: RunContext): Promise<void>;
}
