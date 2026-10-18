const MODEL = "openai/gpt-oss-20b";
// Provider Free Plan quotas are authoritative. Never enable with a billed account.
const enabled = () =>
  Boolean(
    process.env.GROQ_API_KEY && process.env.GROQ_FREE_PLAN_CONFIRMED === "true",
  );
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET")
    return res.status(200).json({ enabled: enabled(), model: MODEL });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!enabled())
    return res
      .status(503)
      .json({
        error:
          "Free cloud generation is not connected. No model request was made.",
      });
  const { messages, maxTokens } = req.body ?? {};
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 10 ||
    messages.some(
      (m) =>
        !m ||
        !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string",
    ) ||
    messages.reduce((n, m) => n + m.content.length, 0) > 16000
  )
    return res
      .status(400)
      .json({
        error: "Use 1–10 text messages, at most 16,000 characters total.",
      });
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512)
    return res
      .status(400)
      .json({ error: "Output limit must be 1–512 tokens." });
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) {
      if (r.status === 429)
        res.setHeader("Retry-After", r.headers.get("retry-after") || "60");
      return res
        .status(r.status === 429 ? 429 : 502)
        .json({
          error:
            r.status === 429
              ? "The free provider quota is reached. Try later; there is no paid fallback."
              : "The cloud provider could not complete this request.",
        });
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim())
      return res
        .status(502)
        .json({ error: "The cloud provider returned no answer." });
    return res.status(200).json({ text, model: MODEL });
  } catch {
    return res
      .status(502)
      .json({ error: "Cloud generation timed out or could not connect." });
  }
}
