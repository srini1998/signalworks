import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ConnectivityGraph } from "@designcodeio/threeui/components/ConnectivityGraph";
import {
  ArrowUpRight,
  CheckCircle,
  WarningCircle,
  Question,
} from "@phosphor-icons/react";
import snapshot from "./data/snapshot.json";
import lab from "./data/lab.json";
import { check, vectorText, type Contract } from "./contract";
import { useModel } from "./ai/useModel";
import { Shell, Trace, ModelControl, useLanguage } from "./ui";
import "./styles.css";
const initial: Contract = {
  name: "up",
  type: "gauge",
  labels: ["instance", "job"],
  cap: 20,
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
  const [text, setText] = useState(snapshot.text),
    [contract, setContract] = useState<Contract>(initial),
    [labelsText, setLabelsText] = useState("instance, job"),
    [result, setResult] = useState<ReturnType<typeof check> | null>(null),
    [message, setMessage] = useState(""),
    [entries, setEntries] = useState<unknown[]>([]),
    [busy, setBusy] = useState(false),
    [explanation, setExplanation] = useState(""),
    [provenance, setProvenance] = useState(
      t("Recorded public demo snapshot", "公開デモの記録済みスナップショット"),
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
  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch(snapshot.source, {
        signal: AbortSignal.timeout(15000),
        credentials: "omit",
      });
      if (!r.ok) throw new Error(`Public demo HTTP ${r.status}`);
      const x = await r.json();
      setText(vectorText(x));
      setProvenance(
        `${t("Public demo fetched", "公開デモを取得")} ${new Date().toLocaleString()}`,
      );
      reset();
      log({
        action: "public-demo-refresh",
        at: new Date().toISOString(),
        url: snapshot.source,
      });
      setMessage(
        t(
          "Public demo refreshed. Run the contract check.",
          "デモを更新しました。契約を確認してください。",
        ),
      );
    } catch (e) {
      setMessage(
        t(
          "Refresh unavailable. The labeled recorded snapshot remains; you can paste your own metrics. ",
          "更新できません。記録済みのデータを使用するか、自分のメトリクスを貼り付けてください。 ",
        ) + String(e),
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
            "OBSERVABILITY THAT YOU CAN QUESTION.",
            "観測結果を、自分で確かめる。",
          )}
        </p>
        <h1 className="reveal">
          {t("Good signals.", "良い信号。")}
          <br />
          <span>{t("Fewer surprises.", "少ない驚き。")}</span>
        </h1>
        <div className="hero-end reveal">
          <p className="intro">
            {t(
              "Your dashboard can be green while a release quietly breaks the metrics behind it. Check what your service actually exposes before the next incident asks you to trust it.",
              "画面が正常でも、変更で裏側のメトリクスが壊れているかもしれません。次の障害で頼る前に、サービスが出力する情報を確かめましょう。",
            )}
          </p>
          <a href="#check" className="cta">
            {t("Check your metrics", "メトリクスを確認")}
            <ArrowUpRight size={22} />
          </a>
        </div>
        <div className="status-strip">
          <span>01 / CONTRACT</span>
          <span>02 / EVIDENCE</span>
          <span>03 / CONFIDENCE</span>
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
            {t("No account. No upload.", "登録不要。アップロード不要。")}
          </span>
        </div>
        <div className="checker">
          <section>
            <div className="input-head">
              <h3>{t("The actual output", "実際の出力")}</h3>
              <button className="quiet" onClick={refresh} disabled={busy}>
                {t("Refresh public demo", "公開デモを更新")}
              </button>
            </div>
            <p className="note">
              {provenance} · {snapshot.capturedAt.slice(0, 10)}
            </p>
            <textarea
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
                "Paste Prometheus text exposition, or use this actual public demo snapshot. 250 KB / 5,000 samples max. This page checks exposed series, not what Prometheus ingested.",
                "Prometheus のテキスト出力を貼り付けるか、公開デモを使用します。最大250KB・5,000サンプル。収集後の系列ではなく、出力を確認します。",
              )}
            </p>
          </section>
          <section className="contract">
            <h3>{t("The contract", "契約")}</h3>
            <label>
              {t("Metric name", "メトリクス名")}
              <input
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
              onClick={() => {
                setText(snapshot.text);
                setContract(initial);
                setLabelsText("instance, job");
                setProvenance(
                  t(
                    "Recorded public demo snapshot",
                    "公開デモの記録済みスナップショット",
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
        <section className="explain">
          <div>
            <h3>{t("Make it understandable.", "分かる言葉に。")}</h3>
            <p>
              {t(
                "A small on-device agent explains your checks and suggests what to inspect next. It does not change the verdict. Its prose is not fact-checked; units still need independent evidence.",
                "端末上の小型エージェントが結果と次の確認点を説明します。判定は変更しません。説明文の事実性は未検証で、単位の確認には独立した測定が必要です。",
              )}
            </p>
          </div>
          <div>
            <ModelControl
              state={ai.state}
              load={ai.load}
              stop={() => {
                ai.stop();
                setBusy(false);
              }}
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
        <section id="how" className="how">
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
