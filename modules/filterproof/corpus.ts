// FilterProof corpus v1: 30 deterministic synthetic log fixtures. Every secret-shaped value is
// generated from a seed, is nonfunctional, and is labeled synthetic. Nothing here is a real
// credential and no value is ever checked against a real service.
import { createHash } from "node:crypto";

export type Placement = "line" | "json_field" | "label";
export type Fixture = {
  id: string;
  seed: number;
  kind: "custom_secret" | "builtin_secret" | "benign" | "label_canary" | "long_line";
  rule_scope: "custom:sw-synthetic-token" | "builtin:aws-access-token" | "builtin:github-pat" | "none";
  placement: Placement;
  line: string;
  labels: Record<string, string>;
  /** Byte offsets of sensitive spans in `line` (or the label value for label canaries). */
  spans: { start: number; end: number; value: string; where: "line" | `label:${string}` }[];
  expected_delivery: "delivered";
  permitted_transformation: "full_mask" | "unchanged";
  json_fields?: string[]; // fields that must survive parsing when the line is JSON
  input_sha256: string;
};

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = (r: () => number, alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");

function make(id: string, seed: number, kind: Fixture["kind"], rule: Fixture["rule_scope"], placement: Placement, build: (r: () => number) => { line: string; secret?: string; labels?: Record<string, string>; json?: string[] }): Fixture {
  const r = rng(seed);
  const { line, secret, labels = {}, json } = build(r);
  const spans: Fixture["spans"] = [];
  if (secret && placement !== "label") {
    const start = line.indexOf(secret);
    spans.push({ start, end: start + secret.length, value: secret, where: "line" });
  }
  if (secret && placement === "label") {
    const key = Object.keys(labels).find((k) => labels[k] === secret)!;
    spans.push({ start: 0, end: secret.length, value: secret, where: `label:${key}` });
  }
  const full: Omit<Fixture, "input_sha256"> = {
    id, seed, kind, rule_scope: rule, placement, line: `fid=${id} ${line}`, labels: { fixture_id: id, ...labels }, spans: [],
    expected_delivery: "delivered", permitted_transformation: secret && placement !== "label" ? "full_mask" : "unchanged", json_fields: json,
  };
  full.spans = spans.map((s) => (s.where === "line" ? { ...s, start: s.start + `fid=${id} `.length, end: s.end + `fid=${id} `.length } : s));
  return { ...full, input_sha256: createHash("sha256").update(JSON.stringify([full.line, full.labels])).digest("hex") };
}

export function corpusV1(): Fixture[] {
  const out: Fixture[] = [];
  let n = 0;
  const id = () => `FP-${String(++n).padStart(3, "0")}`;
  // Custom rule matches (plain and JSON).
  for (let i = 0; i < 6; i++) {
    out.push(make(id(), 1000 + i, "custom_secret", "custom:sw-synthetic-token", i < 4 ? "line" : "json_field", (r) => {
      const secret = `swtok_${pick(r, ALNUM, 32)}`;
      if (i < 4) return { line: ["auth ok token=", "retrying with credential ", "worker loaded key ", "header x-sw-token: "][i] + secret + " status=200", secret };
      return { line: JSON.stringify({ msg: "session refreshed", user: `u${i}`, auth: secret, latency_ms: 40 + i }), secret, json: ["msg", "user", "latency_ms"] };
    }));
  }
  // A low-variety value that matches the custom regex. During setup on Alloy 1.20.1 a value like this
  // passed through unredacted while random-looking values were masked; kept as a probe, not a claim.
  out.push(make(id(), 1100, "custom_secret", "custom:sw-synthetic-token", "line", () => {
    const secret = "swtok_abcdefghijklmnopqrstuvwxyz012345";
    return { line: `fallback credential ${secret} used`, secret };
  }));
  // Built-in Gitleaks patterns verified on Alloy 1.20.1 (synthetic, nonfunctional).
  for (let i = 0; i < 5; i++) {
    out.push(make(id(), 2000 + i, "builtin_secret", "builtin:aws-access-token", "line", (r) => {
      const secret = `AKIA${pick(r, B32, 16)}`;
      return { line: `deploy step ${i} using access key ${secret} region=eu-west-1`, secret };
    }));
  }
  for (let i = 0; i < 3; i++) {
    out.push(make(id(), 3000 + i, "builtin_secret", "builtin:github-pat", "line", (r) => {
      const secret = `ghp_${pick(r, ALNUM, 36)}`;
      return { line: `ci clone with ${secret} succeeded`, secret };
    }));
  }
  // Benign lookalikes that must pass through unchanged.
  const benign = [
    "swtok_short is not a token",
    "request id 8f14e45f-ceea-467a-9c2b-1f0a3e4d5c6b completed",
    "sha256 9e107d9d372bb6826bd81d3542a419d6e3a7c4f2b1d8a0c5e6f7a8b9c0d1e2f3 verified",
    "token_id=4821 rotated by scheduler",
    "user clicked 'Generate API key' button",
    "AKIA prefix documented in runbook section 4",
    "password reset email queued for user 52",
    "ghp_ prefix tokens are rejected by policy",
  ];
  benign.forEach((line, i) => out.push(make(id(), 4000 + i, "benign", "none", "line", () => ({ line }))));
  out.push(make(id(), 4100, "benign", "none", "json_field", () => ({ line: JSON.stringify({ msg: "cache warm", keys: 128, region: "us" }), json: ["msg", "keys", "region"] })));
  // Label/metadata canaries: documented out of scope for a line filter.
  for (let i = 0; i < 3; i++) {
    out.push(make(id(), 5000 + i, "label_canary", "custom:sw-synthetic-token", "label", (r) => {
      const secret = `swtok_${pick(r, ALNUM, 32)}`;
      return { line: `request handled route=/pay attempt=${i}`, secret, labels: { session: secret } };
    }));
  }
  // Long lines for the stress case (bounded: 60 KB), secret placed near the end.
  for (let i = 0; i < 4; i++) {
    out.push(make(id(), 6000 + i, "long_line", "custom:sw-synthetic-token", "line", (r) => {
      const secret = `swtok_${pick(r, ALNUM, 32)}`;
      const filler = Array.from({ length: 1200 }, (_, k) => `k${k}=${pick(r, ALNUM, 40)}`).join(" ");
      return { line: `${filler} trailing token=${secret} end`, secret };
    }));
  }
  return out;
}

export const CORPUS_VERSION = "corpus-v1";
export function corpusHash(fx: Fixture[]): string {
  return createHash("sha256").update(fx.map((f) => f.input_sha256).join("")).digest("hex");
}

export const GITLEAKS_TOML = `title = "Signalworks FilterProof rules"
[extend]
useDefault = true
[[rules]]
id = "sw-synthetic-token"
description = "Signalworks synthetic token (nonfunctional test value)"
regex = '''swtok_[0-9a-zA-Z]{32}'''
keywords = ["swtok_"]
`;
