# Signalworks

Refresh actual Steam player counts, inspect their metric structure and catch a deliberately broken label.

The public interface is English-only. Its main task requires no AI weights, account or paid API. See [current interface, data, verification and limits](INTERFACE.md) for the exact execution boundaries and the separately retained backend experiments.

Run `npm ci`, then `npm run dev`. `npm run build` checks TypeScript and builds the website.

Optional cloud generation, where offered, is disabled unless a server-side Groq key and `GROQ_FREE_PLAN_CONFIRMED=true` are set for an actual Free Plan account. No credentials, billing or paid fallback are configured. This is a provider-limited inference option, not model training. Never expose keys in Vite environment variables or browser code.
