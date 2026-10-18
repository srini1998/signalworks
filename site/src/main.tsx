import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { ConnectivityGraph } from "@designcodeio/threeui/components/ConnectivityGraph";
import {
  ArrowUpRight,
  CheckCircle,
  WarningCircle,
  Question,
} from "@phosphor-icons/react";
import snapshot from "./data/snapshot.json";
import gaming from "./data/steam.json";
import lab from "./data/lab.json";
import { check, parse, vectorText, type Contract } from "./contract";
import { useModel } from "./ai/useModel";
import { Shell, Trace, ModelControl, useLanguage } from "./ui";
import "./styles.css";
const initial: Contract = {
  name: "steam_players_online",
  type: "gauge",
  labels: ["game", "appid"],
  cap: 3,
};
const modules = [
  [
    "AlertScenario",
    "Alert timing",
    "警報の時間",
    "Does a short spike page someone, or does a sustained incident get missed?",
    "短いスパイクで通知されるか、長い障害を見逃すか。",
  ],
  [
    "MetricContract",
    "Metric releases",
    "メトリクスの変更",
    "Did a release remove a label, rename a metric or record milliseconds under a seconds name?",
    "ラベル削除・名前変更・秒とミリ秒の混同を確認。",
  ],
  [
    "RouteReplay",
    "The right team",
    "通知先の確認",
    "Would a payments incident go to the payments team, with the right grouping?",
    "決済の障害が適切なチームにまとまって届くか。",
  ],
  [
    "SeriesWatch",
    "Missing signals",
    "信号の消失",
    "Does a disappeared shard look healthy when its series is simply missing?",
    "系列が消えただけで、正常に見えていないか。",
  ],
  [
    "DashboardReplay",
    "Useful dashboards",
    "使える画面",
    "Does a dashboard query still describe the data after a release?",
    "リリース後も、ダッシュボードのクエリがデータを表すか。",
  ],
  [
    "FilterProof",
    "Secret handling",
    "機密情報の処理",
    "Do seeded secret canaries survive a real Alloy log-filter pipeline?",
    "実際の Alloy ログ処理で、検証用の秘密文字列が残らないか。",
  ],
];
function App() {
  const { ja, t, toggle } = useLanguage(),
    ai = useModel();
  const [text, setText] = useState(gaming.text),
    [contract, setContract] = useState<Contract>(initial),
    [labelsText, setLabelsText] = useState("game, appid"),
    [result, setResult] = useState<ReturnType<typeof check> | null>(null),
    [message, setMessage] = useState(""),
    [entries, setEntries] = useState<unknown[]>([]),
    [busy, setBusy] = useState(false),
    [explanation, setExplanation] = useState(""),
    [provenance, setProvenance] = useState(
      "Recorded Steam snapshot · " +
        new Date(gaming.capturedAt).toLocaleString(),
    );
  const log = (entry: unknown) => setEntries((e) => [...e, entry]);
  function reset() {
    setResult(null);
    setExplanation("");
  }
  function run() {
    try {
      const r = check(text, contract);
      setResult(r);
      setMessage("");
      setExplanation("");
      log({ action: "contract-check", ...r });
    } catch (e) {
      setMessage(String(e));
      setResult(null);
    }
  }
  const gameValues = useMemo(() => {
    try {
      return (
        parse(text).families.find((f) => f.name === "steam_players_online")
          ?.samples ?? []
      );
    } catch {
      return [];
    }
  }, [text]);
  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch("/api/steam", {
        signal: AbortSignal.timeout(15000),
      });
      const x = await r.json();
      if (!r.ok) throw Error(x.error || "Steam refresh unavailable");
      const values = x.results.filter((v: { ok: boolean }) => v.ok);
      if (!values.length) throw Error("No counts returned");
      const metricText =
        "# HELP steam_players_online Steam-connected players reported by Valve\n# TYPE steam_players_online gauge\n" +
        values
          .map(
            (v: { name: string; appid: number; players: number }) =>
              `steam_players_online{game="${v.name}",appid="${v.appid}"} ${v.players}`,
          )
          .join("\n") +
        "\n";
      setText(metricText);
      setContract(initial);
      setLabelsText("game, appid");
      setProvenance(
        "Steam API snapshot as of " +
          new Date(x.capturedAt).toLocaleString() +
          " · may be cached for 5 minutes",
      );
      reset();
      log({ action: "steam-refresh", ...x });
      setMessage(
        x.results.some((v: { ok: boolean }) => !v.ok)
          ? "Some games could not be fetched; missing counts were not replaced with zero."
          : "Steam counts refreshed. Run the structure check.",
      );
    } catch (e) {
      setMessage(
        "Refresh failed. The currently labeled data remains. " + String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  async function explain() {
    if (!result) return;
    setBusy(true);
    try {
      const prompt = `Explain these Prometheus exposition checks in 3 short sentences for an application developer. Do not claim units, ingestion or production behavior were verified. Metric ${contract.name}. Findings: ${result.checks.map((c) => `${c.name}: ${c.status} (${c.message})`).join("; ")}. ${ja ? "Reply in Japanese." : ""}`;
      const r = await ai.generate(
        [{ role: "user", content: prompt }],
        undefined,
        180,
      );
      setExplanation(r.text);
      log({ action: "explain", prompt, ...r });
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell name="signalworks" number="06" ja={ja} toggle={toggle}>
      <section className="hero">
        <div className="shader" aria-hidden="true">
          <ConnectivityGraph />
        </div>
        <p className="eyebrow reveal">
          {t(
            "GAME STATS ARE ONLY AS GOOD AS THEIR SIGNALS.",
            "観測結果を、自分で確かめる。",
          )}
        </p>
        <h1 className="reveal">
          {t("Players online.", "良い信号。")}
          <br />
          <span>{t("Signals intact?", "少ない驚き。")}</span>
        </h1>
        <div className="hero-end reveal">
          <p className="intro">
            {t(
              "See real Steam player counts, then test what happens when a release drops a label. Or paste your own service metrics and check that your dashboards still have the fields they need.",
              "画面が正常でも、変更で裏側のメトリクスが壊れているかもしれません。次の障害で頼る前に、サービスが出力する情報を確かめましょう。",
            )}
          </p>
          <a href="#check" className="cta">
            {t("Explore the gaming signals", "メトリクスを確認")}
            <ArrowUpRight size={22} />
          </a>
        </div>
        <div className="status-strip">
          <span>01 / PLAYER COUNTS</span>
          <span>02 / EXPECTED FIELDS</span>
          <span>03 / CHECK THE CHANGE</span>
        </div>
      </section>
      <main id="check">
        <div className="section-head">
          <div>
            <p className="eyebrow">{t("BEFORE YOU SHIP", "リリースの前に")}</p>
            <h2>
              {t(
                "What did your service promise?",
                "サービスの約束は守られている？",
              )}
            </h2>
          </div>
          <span>
            {t(
              "Local checks. No account needed.",
              "登録不要。アップロード不要。",
            )}
          </span>
        </div>
        <section
          className="gaming-signals"
          aria-label="Player counts in the current metric text"
        >
          {gameValues.map((v, i) => (
            <article key={i}>
              <span>{v.labels.game ?? "Unlabeled game"}</span>
              <strong>{v.value.toLocaleString()}</strong>
              <p>Steam-connected players</p>
              <a
                href={
                  "https://store.steampowered.com/app/" + (v.labels.appid ?? "")
                }
                target="_blank"
                rel="noreferrer"
              >
                Game on Steam ↗
              </a>
            </article>
          ))}
        </section>
        <p className="note">
          {provenance}. These cards read the metric text below, including edits
          you make. Player count alone does not establish game or server health.
        </p>
        <div className="scenario-actions">
          <button
            disabled={busy}
            onClick={() => {
              setText(gaming.text);
              setContract(initial);
              setLabelsText("game, appid");
              setProvenance(
                "Recorded Steam snapshot · " +
                  new Date(gaming.capturedAt).toLocaleString(),
              );
              reset();
              setMessage("Original gaming snapshot loaded.");
            }}
          >
            Load gaming snapshot
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setText(gaming.text.replace(',appid="730"', ""));
              setContract(initial);
              setLabelsText("game, appid");
              setProvenance(
                "Deliberately broken-label fixture using the recorded Steam counts",
              );
              reset();
              setMessage(
                "The Counter-Strike series has lost its appid label. Run the check to catch it.",
              );
            }}
          >
            Try a broken label
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setText(snapshot.text);
              setContract({
                name: "up",
                type: "gauge",
                labels: ["instance", "job"],
                cap: 20,
              });
              setLabelsText("instance, job");
              setProvenance(
                "Recorded PromLabs service snapshot · " + snapshot.capturedAt,
              );
              reset();
              setMessage("Service monitoring example loaded.");
            }}
          >
            Try service metrics
          </button>
        </div>
        <div className="checker">
          <section>
            <div className="input-head">
              <h3>{t("The actual output", "実際の出力")}</h3>
              <button className="quiet" onClick={refresh} disabled={busy}>
                {t("Refresh Steam counts", "公開デモを更新")}
              </button>
            </div>
            <p className="note">{provenance}</p>
            <textarea
              disabled={busy}
              aria-label="Prometheus metrics"
              value={text}
              maxLength={250000}
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                setProvenance(t("Your pasted metrics", "貼り付けたメトリクス"));
                reset();
              }}
            />
            <p className="note">
              {t(
                "Player counts come from Valve’s public Steam API and are converted to Prometheus gauge samples. Only Steam-connected players are counted. You can paste other metrics too: 250 KB / 5,000 samples max. This is a text-structure check, not a check of Steam server health.",
                "Prometheus のテキスト出力を貼り付けるか、公開デモを使用します。最大250KB・5,000サンプル。収集後の系列ではなく、出力を確認します。",
              )}
            </p>
          </section>
          <section className="contract">
            <h3>{t("The contract", "契約")}</h3>
            <label>
              {t("Metric name", "メトリクス名")}
              <input
                disabled={busy}
                value={contract.name}
                onChange={(e) => {
                  setContract((c) => ({ ...c, name: e.target.value }));
                  reset();
                }}
              />
            </label>
            <div className="small-grid">
              <label>
                {t("Expected type", "期待する型")}
                <select
                  disabled={busy}
                  value={contract.type}
                  onChange={(e) => {
                    setContract((c) => ({ ...c, type: e.target.value }));
                    reset();
                  }}
                >
                  {["gauge", "counter", "histogram", "summary", "untyped"].map(
                    (n) => (
                      <option key={n}>{n}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                {t("Exposed-series cap", "出力系列の上限")}
                <input
                  disabled={busy}
                  type="number"
                  min="1"
                  max="5000"
                  value={contract.cap}
                  onChange={(e) => {
                    setContract((c) => ({ ...c, cap: Number(e.target.value) }));
                    reset();
                  }}
                />
              </label>
            </div>
            <label>
              {t(
                "Required labels, comma-separated",
                "必須ラベル（カンマ区切り）",
              )}
              <input
                disabled={busy}
                value={labelsText}
                onChange={(e) => {
                  setLabelsText(e.target.value);
                  setContract((c) => ({
                    ...c,
                    labels: e.target.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  }));
                  reset();
                }}
              />
            </label>
            <button className="cta" onClick={run} disabled={busy}>
              {t("Check the contract", "契約をチェック")}
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => {
                setText(gaming.text);
                setContract(initial);
                setLabelsText("game, appid");
                setProvenance(
                  t(
                    "Recorded Steam snapshot · " +
                      new Date(gaming.capturedAt).toLocaleString(),
                    "",
                  ),
                );
                reset();
              }}
            >
              {t("Reset example", "例をリセット")}
            </button>
          </section>
        </div>
        <output role="status">{message}</output>
        {result && (
          <section className="verdict">
            <div>
              <p className="eyebrow">
                {result.verdict === "fail"
                  ? t("SOMETHING CHANGED", "変更を検出")
                  : t("STRUCTURE CHECKED", "構造の確認完了")}
              </p>
              <h3>
                {result.verdict === "fail"
                  ? t("Fix the contract drift.", "契約との差を修正。")
                  : t(
                      "A useful check. Not a production guarantee.",
                      "役立つ確認。運用の保証ではありません。",
                    )}
              </h3>
            </div>
            <div className="checks">
              {result.checks.map((c) => (
                <article key={c.name}>
                  {c.status === "pass" ? (
                    <CheckCircle size={22} />
                  ) : c.status === "fail" ? (
                    <WarningCircle size={22} />
                  ) : (
                    <Question size={22} />
                  )}
                  <div>
                    <strong>{c.name}</strong>
                    <p>{c.message}</p>
                  </div>
                  <span>{c.status}</span>
                </article>
              ))}
            </div>
          </section>
        )}
        {result && (
          <section className="plain-findings">
            <h3>What does this mean?</h3>
            <p>
              {result.verdict === "fail"
                ? "At least one expected field or structure is missing. A dashboard using that field may hide a series or lose its breakdown after a release. Fix the producer or update the declared expectations before trusting that view."
                : "The listed structure matches the declared checks. This does not tell us whether a game is healthy, an alert fires or the values were ingested correctly."}
            </p>
            <p>
              For example: if appid disappears, a chart filtered to a game ID
              may stop showing that game even while players are online.
            </p>
          </section>
        )}
        <details className="cloud-explain">
          <summary>Optional cloud explanation</summary>
          <section className="explain">
            <div>
              <h3>{t("Make it understandable.", "分かる言葉に。")}</h3>
              <p>
                {t(
                  "An optional cloud model explains your checks and suggests what to inspect next. It does not change the verdict. Its prose is not fact-checked; units still need independent evidence.",
                  "端末上の小型エージェントが結果と次の確認点を説明します。判定は変更しません。説明文の事実性は未検証で、単位の確認には独立した測定が必要です。",
                )}
              </p>
            </div>
            <div>
              <ModelControl
                state={ai.state}
                load={ai.load}
                stop={ai.stop}
                ja={ja}
              />
              <button
                onClick={explain}
                disabled={!result || busy || ai.state.phase !== "ready"}
              >
                {t("Explain the findings", "結果を説明する")}
              </button>
              <output>{explanation}</output>
            </div>
          </section>
        </details>
        <section id="how" className="how">
          <p className="note">
            Gaming data:{" "}
            <a href="https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers">
              Valve’s GetNumberOfCurrentPlayers endpoint ↗
            </a>
            . Not affiliated with Valve. Counts exclude offline players. No
            player identities, account details or API keys are collected.
            Refresh uses a fixed three-game allowlist and a five-minute cache;
            failures are shown explicitly.
          </p>
          <p className="eyebrow">
            {t(
              "WHEN THE TEXT CHECK ISN’T ENOUGH",
              "テキスト確認だけで足りないとき",
            )}
          </p>
          <h2>
            {t(
              "Rehearse the failure before it happens.",
              "失敗する前に、失敗を再現する。",
            )}
          </h2>
          <p>
            {t(
              "A payments team might rename a metric while leaving an alert unchanged. A shard might disappear and take its alert instance with it. A routing typo might page the wrong team. The full local Signalworks lab runs controlled experiments against real Grafana, Prometheus, Loki and Alloy to investigate these failures.",
              "決済チームがメトリクス名を変えても、警報が古いままかもしれません。シャードと警報が一緒に消えたり、通知先を間違えたりすることも。ローカルの完全版では実際の Grafana・Prometheus・Loki・Alloy で検証します。",
            )}
          </p>
          <div className="module-list">
            {modules.map(([name, en, jp, desc, jdesc], i) => (
              <details key={name}>
                <summary>
                  <span>0{i + 1}</span>
                  <b>{ja ? jp : en}</b>
                  <em>{name}</em>
                </summary>
                <p>{ja ? jdesc : desc}</p>
              </details>
            ))}
          </div>
          <details>
            <summary>
              {t(
                "Recorded local lab results — not this browser check",
                "記録済みローカル実験（ブラウザの確認とは別）",
              )}
            </summary>
            <div className="record">
              <strong>
                {lab.baseline.correct}/{lab.baseline.runs} vs{" "}
                {lab.agent.correct}/{lab.agent.runs}
              </strong>
              <p>
                {t(
                  "Fixed baseline vs local Qwen 3B agent correct runs on seeded controlled cases. Different cohorts, not a randomized head-to-head. The agent performed poorly. No claim of autonomous production readiness.",
                  "固定ベースラインと Qwen 3B エージェントの正しい実行数。コホートが異なり、無作為比較ではありません。エージェントの成績は低く、自律運用の準備完了とは言えません。",
                )}
              </p>
              <pre>{JSON.stringify(lab, null, 2)}</pre>
            </div>
          </details>
          <p className="note">
            {t(
              "The hosted page does not connect to your Grafana, mutate alerts, upload metrics, or run the six lab modules. Run the local repository for those experiments. Pasted text and generated explanations remain in this tab.",
              "公開ページは Grafana に接続せず、警報の変更や6つの実験の実行もしません。実験はローカルのリポジトリで実行します。貼り付けた内容と説明はこのタブに留まります。",
            )}
          </p>
          <a href="https://github.com/srini1998/signalworks">
            {t(
              "Open source & run the full local lab",
              "ソース・ローカル完全版",
            )}{" "}
            ↗
          </a>{" "}
          ·{" "}
          <a href="https://demo.promlabs.com/">
            {t("Public demo data source", "公開デモの情報源")} ↗
          </a>
        </section>
      </main>
      <Trace ja={ja} entries={entries} />
    </Shell>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
