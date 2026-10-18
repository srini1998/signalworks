import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import type { ModelState } from "./ai/useModel";
export function useLanguage() {
  const [ja, set] = useState(false);
  useEffect(() => {
    document.documentElement.lang = ja ? "ja" : "en";
  }, [ja]);
  return {
    ja,
    t: (en: string, jp: string) => (ja ? jp : en),
    toggle: () => set((j) => !j),
  };
}
export function Entrance() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() => {
      gsap.from(".reveal", {
        opacity: 0,
        y: 18,
        stagger: 0.09,
        duration: 0.65,
        clearProps: "all",
      });
    });
    return () => ctx.revert();
  }, []);
  return null;
}
export function ModelControl({
  state,
  load,
  stop,
  ja,
}: {
  state: ModelState;
  load: () => void;
  stop: () => void;
  ja: boolean;
}) {
  return (
    <div className="model-control">
      <p>
        {ja
          ? "端末上で AI を実行。初回に約860MBをダウンロードします。処理速度は端末に依存します。"
          : "AI runs on your device. First download ~860 MB; speed depends on your hardware."}
      </p>
      <button
        onClick={load}
        disabled={state.phase === "loading" || state.phase === "ready"}
      >
        {state.phase === "idle"
          ? ja
            ? "ブラウザAIを読み込む"
            : "Load browser AI"
          : state.phase === "loading"
            ? `${ja ? "読込中" : "Loading"} ${Math.round((state.loaded ?? 0) / 1e6)} MB`
            : state.phase === "ready"
              ? `${ja ? "準備完了" : "Ready"} · ${state.device}`
              : ja
                ? "再試行"
                : "Retry model"}
      </button>
      {state.phase !== "idle" && (
        <button className="quiet" onClick={stop}>
          {ja ? "停止・メモリを解放" : "Stop / release memory"}
        </button>
      )}
      {state.message && <p role="alert">{state.message}</p>}
    </div>
  );
}
export function Trace({ entries, ja }: { entries: unknown[]; ja: boolean }) {
  const [open, set] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <>
      <button className="trace-tab" onClick={() => set(true)}>
        {ja ? "エージェントの記録" : "Agent trace"} ({entries.length})
      </button>
      <dialog ref={ref} onClose={() => set(false)} onCancel={() => set(false)}>
        <header>
          <h2>{ja ? "実行の記録" : "Agent trace"}</h2>
          <button onClick={() => set(false)} autoFocus>
            {ja ? "閉じる" : "Close"}
          </button>
        </header>
        <p>
          {ja
            ? "このページでの実行のみ。サーバーには送信しません。"
            : "This page session only. Inputs are not sent to our server."}
        </p>
        <pre>{JSON.stringify(entries, null, 2)}</pre>
      </dialog>
    </>
  );
}
export function Shell({
  name,
  number,
  ja,
  toggle,
  children,
}: {
  name: string;
  number: string;
  ja: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <Entrance />
      <nav>
        <a className="brand" href="/">
          {name}
          <span> / {number}</span>
        </a>
        <div>
          <a href="#how">{ja ? "使い方" : "How it works"}</a>
          <button className="quiet" onClick={toggle}>
            {ja ? "English" : "日本語"}
          </button>
        </div>
      </nav>
      {children}
      <footer>
        <span>
          Srinivas Venigalla ·{" "}
          {ja ? "無料・ブラウザ上で実行" : "Free · Runs in your browser"}
        </span>
        <a href="https://my-portfolio-three-omega-46.vercel.app">
          {ja ? "すべてのプロジェクト" : "All projects"} ↗
        </a>
        <a href="/THIRD_PARTY_NOTICES.txt">
          {ja ? "モデル・ライセンス" : "Model & licenses"}
        </a>
      </footer>
    </>
  );
}
