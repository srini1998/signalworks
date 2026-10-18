export type Sample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};
export type Family = { name: string; type: string; samples: Sample[] };
export type Contract = {
  name: string;
  type: string;
  labels: string[];
  cap: number;
};
export type Check = {
  name: string;
  status: "pass" | "fail" | "unknown";
  message: string;
};
export function parse(text: string) {
  if (text.length > 250000) throw new Error("Maximum 250 KB per check");
  const map = new Map<string, Family>(),
    errors: string[] = [];
  let samples = 0;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const l = line.trim();
    if (!l) continue;
    const type = l.match(
      /^# TYPE ([a-zA-Z_:][\w:]*) (counter|gauge|histogram|summary|untyped)$/,
    );
    if (type) {
      if (map.has(type[1]))
        errors.push(`Line ${i + 1}: duplicate or late TYPE`);
      map.set(type[1], { name: type[1], type: type[2], samples: [] });
      continue;
    }
    if (l.startsWith("#")) continue;
    const m = l.match(
      /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Inf|NaN)(?:\s+\d+)?$/,
    );
    if (!m) {
      errors.push(`Line ${i + 1}: unsupported or malformed sample`);
      continue;
    }
    const labels: Record<string, string> = Object.create(null);
    let rest = m[2] ?? "",
      valid = true;
    while (rest) {
      const pair = rest.match(
        /^([a-zA-Z_][\w]*)="((?:[^"\\]|\\[\\"n])*)"(?:,\s*|$)/,
      );
      if (!pair || Object.hasOwn(labels, pair?.[1] ?? "")) {
        valid = false;
        break;
      }
      labels[pair[1]] = pair[2]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      rest = rest.slice(pair[0].length);
    }
    if (!valid) {
      errors.push(`Line ${i + 1}: invalid or duplicate label`);
      continue;
    }
    if (++samples > 5000) throw new Error("Maximum 5000 samples per check");
    let family = m[1];
    for (const suffix of ["_bucket", "_sum", "_count"])
      if (family.endsWith(suffix)) {
        const base = family.slice(0, -suffix.length);
        if (["histogram", "summary"].includes(map.get(base)?.type ?? "")) {
          family = base;
          break;
        }
      }
    if (!map.has(family))
      map.set(family, { name: family, type: "untyped", samples: [] });
    map
      .get(family)!
      .samples.push({
        name: m[1],
        labels,
        value: Number(
          m[3].replace("+Inf", "Infinity").replace("-Inf", "-Infinity"),
        ),
      });
  }
  return { families: [...map.values()], errors, samples };
}
export function check(text: string, c: Contract) {
  if (
    !/^[a-zA-Z_:][\w:]*$/.test(c.name) ||
    !["counter", "gauge", "histogram", "summary", "untyped"].includes(c.type) ||
    !Number.isInteger(c.cap) ||
    c.cap < 1 ||
    c.cap > 5000 ||
    c.labels.some((l) => !/^[a-zA-Z_]\w*$/.test(l))
  )
    throw new Error("Invalid contract");
  const p = parse(text),
    f = p.families.find((f) => f.name === c.name),
    checks: Check[] = [
      {
        name: "Parse completeness",
        status: p.errors.length ? "fail" : "pass",
        message: p.errors.length
          ? p.errors.slice(0, 5).join("; ")
          : `${p.samples} sample lines parsed`,
      },
    ];
  checks.push({
    name: "Metric present",
    status: f?.samples.length ? "pass" : "fail",
    message: f
      ? `${f.samples.length} samples exposed`
      : "Required metric missing",
  });
  if (f?.samples.length) {
    checks.push({
      name: "Declared type",
      status: f.type === c.type ? "pass" : "fail",
      message: `Expected ${c.type}, observed ${f.type}`,
    });
    const missing = [
      ...new Set(
        f.samples.flatMap((s) =>
          c.labels.filter((l) => !Object.hasOwn(s.labels, l)),
        ),
      ),
    ];
    checks.push({
      name: "Required labels on every sample",
      status: missing.length ? "fail" : "pass",
      message: missing.length
        ? `Missing: ${missing.join(", ")}`
        : `All samples have ${c.labels.join(", ") || "no required labels"}`,
    });
    const keys = f.samples.map((s) =>
        JSON.stringify([s.name, Object.entries(s.labels).sort()]),
      ),
      n = new Set(keys).size;
    checks.push({
      name: "Exposed series budget",
      status: n <= c.cap ? "pass" : "fail",
      message: `${n} unique exposed series; cap ${c.cap}. Not ingested Prometheus cardinality.`,
    });
    checks.push({
      name: "No duplicate samples",
      status: n === keys.length ? "pass" : "fail",
      message:
        n === keys.length
          ? "No repeated series keys"
          : "Repeated series keys in the same exposition",
    });
    checks.push({
      name: "Finite sample values",
      status: f.samples.every((s) => Number.isFinite(s.value))
        ? "pass"
        : "unknown",
      message: "NaN/Inf need domain-specific interpretation.",
    });
  }
  checks.push({
    name: "Units and alert behavior",
    status: "unknown",
    message:
      "Text alone cannot prove seconds vs milliseconds, ingestion, alert timing or notification delivery.",
  });
  return {
    checks,
    parsed: p,
    contract: c,
    verdict: checks.some((x) => x.status === "fail")
      ? "fail"
      : "structure_checked",
  };
}
export function vectorText(x: any) {
  if (x.status !== "success" || x.data?.resultType !== "vector")
    throw new Error("Public demo returned no vector");
  const allowed = ["up", "scrape_duration_seconds", "scrape_samples_scraped"];
  const out: string[] = [];
  for (const name of allowed) {
    out.push(`# TYPE ${name} gauge`);
    for (const r of x.data.result.filter(
      (v: any) => v.metric?.__name__ === name,
    )) {
      const labels = Object.entries(r.metric)
        .filter(([k]) => k !== "__name__")
        .sort()
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(",");
      out.push(`${name}{${labels}} ${r.value[1]}`);
    }
  }
  return out.join("\n") + "\n";
}
