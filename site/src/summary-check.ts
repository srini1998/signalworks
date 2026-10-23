// Deterministic checks on the optional cloud summary of live metrics.
import type { Check, Sample } from "./contract";
const label = (s: Sample) =>
  Object.entries(s.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
export function summaryPrompt(metric: string, samples: Sample[], checks: Check[], provenance: string) {
  return `Live metric ${metric} (${provenance}). Samples:
${samples.slice(0, 20).map((s) => `- ${label(s)}: ${s.value}`).join("\n")}
Contract check results:
${checks.map((c) => `- ${c.name}: ${c.status.toUpperCase()} (${c.message})`).join("\n")}
Write at most 4 short sentences for an on-call developer: what the live values show (copy numbers exactly, no rounding, no derived totals or percentages) and name every FAIL or UNKNOWN check. Do not claim units, ingestion or production behavior were verified.`;
}
const numbers = (s: string) =>
  (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replaceAll(",", ""));
export function checkSummary(text: string, samples: Sample[], checks: Check[]) {
  const allowed = new Set<string>([
    ...samples.map((s) => String(s.value)),
    ...samples.flatMap((s) => numbers(Object.values(s.labels).join(" "))),
    ...checks.flatMap((c) => numbers(c.name + " " + c.message)),
  ]);
  const quoted = numbers(text);
  const unknown = quoted.filter((n) => !allowed.has(n) && !(Number(n) <= 10 && Number.isInteger(Number(n))));
  const lower = text.toLowerCase();
  const missed = checks
    .filter((c) => c.status !== "pass")
    .filter((c) => !lower.includes(c.name.toLowerCase()))
    .map((c) => c.name);
  return { quoted, unknown, missed, ok: !unknown.length && !missed.length };
}
