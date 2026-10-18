const GAMES = [
  { appid: 730, name: "Counter-Strike 2" },
  { appid: 570, name: "Dota 2" },
  { appid: 1172470, name: "Apex Legends" },
];
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const capturedAt = new Date().toISOString();
  const results = await Promise.all(
    GAMES.map(async (game) => {
      const source = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${game.appid}`;
      try {
        const r = await fetch(source, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw Error("upstream");
        const x = await r.json();
        if (
          x.response?.result !== 1 ||
          !Number.isSafeInteger(x.response?.player_count) ||
          x.response.player_count < 0
        )
          throw Error("invalid count");
        return { ...game, players: x.response.player_count, source, ok: true };
      } catch {
        return {
          ...game,
          source,
          ok: false,
          error: "Steam player count unavailable",
        };
      }
    }),
  );
  if (results.every((r) => !r.ok)) {
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(502)
      .json({
        error: "Steam is unavailable. No zero counts have been substituted.",
      });
  }
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600",
  );
  return res
    .status(200)
    .json({
      capturedAt,
      results,
      scope:
        "Steam-connected players only; independent portfolio project, not affiliated with Valve.",
    });
}
