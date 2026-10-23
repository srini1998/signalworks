// Optional free cloud agent step. Groq free plan (no card) only; there is no paid fallback.
// Model checked 2026-10-22 via GET https://api.groq.com/openai/v1/models (openai/gpt-oss-20b present;
// org limits reported in headers: 1,000 requests/day, 8,000 tokens/minute).
const MODEL = 'openai/gpt-oss-20b';
// The only line that differs between site copies: what this endpoint is for.
const PURPOSE = 'an observability assistant in Signalworks. Summarize only the live metric values and check results you are given.';
const LIMITS = { perIpPerMinute: 12, perIpPerDay: 60, instancePerDay: 300, maxChars: 8000, maxTokens: 512 };
// In-memory limits are per serverless instance (best effort, free). Groq's own free-plan quota is the hard backstop.
const ips = new Map();
let day = '', dayCount = 0;
const enabled = () => Boolean(process.env.GROQ_API_KEY && process.env.GROQ_FREE_PLAN_CONFIRMED === 'true');
const clientIp = (req) => String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || 'unknown').split(',')[0].trim();
function admit(ip, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; ips.clear(); }
  if (dayCount >= LIMITS.instancePerDay) return 'This demo reached its daily free request cap. Try tomorrow; there is no paid fallback.';
  const entry = ips.get(ip) || { minute: [], total: 0 };
  entry.minute = entry.minute.filter((t) => now - t < 60000);
  if (entry.total >= LIMITS.perIpPerDay) return 'You reached the daily free limit for this demo. Try tomorrow; there is no paid fallback.';
  if (entry.minute.length >= LIMITS.perIpPerMinute) return 'Too many requests this minute. Wait a moment; the free quota is shared.';
  entry.minute.push(now); entry.total++; dayCount++;
  ips.set(ip, entry);
  if (ips.size > 5000) ips.delete(ips.keys().next().value);
  return '';
}
export function resetLimitsForTests() { ips.clear(); day = ''; dayCount = 0; }
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ enabled: enabled(), model: MODEL, provider: 'Groq free plan', limits: LIMITS });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (!enabled()) return res.status(503).json({ error: 'Free cloud generation is not connected. No model request was made.' });
  const { messages, maxTokens } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 10 || messages.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) || messages.reduce((n, m) => n + m.content.length, 0) > LIMITS.maxChars)
    return res.status(400).json({ error: `Use 1–10 user/assistant text messages, at most ${LIMITS.maxChars} characters total.` });
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > LIMITS.maxTokens) return res.status(400).json({ error: `Output limit must be 1–${LIMITS.maxTokens} tokens.` });
  const refusal = admit(clientIp(req));
  if (refusal) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: refusal }); }
  const started = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: 'You are ' + PURPOSE + ' Your output is checked by deterministic code before anyone uses it. Never invent numbers, facts or results. Be brief.' }, ...messages],
        max_tokens: maxTokens, temperature: 0, reasoning_effort: 'low', include_reasoning: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!r.ok) {
      if (r.status === 429) res.setHeader('Retry-After', r.headers.get('retry-after') || '60');
      return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'The free provider quota is reached. Try later; there is no paid fallback.' : 'The cloud provider could not complete this request.' });
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) return res.status(502).json({ error: 'The cloud provider returned no answer (output limit too small?).' });
    return res.status(200).json({ text, model: MODEL, latencyMs: Date.now() - started, usage: { input: data.usage?.prompt_tokens ?? null, output: data.usage?.completion_tokens ?? null } });
  } catch {
    return res.status(502).json({ error: 'Cloud generation timed out or could not connect.' });
  }
}
