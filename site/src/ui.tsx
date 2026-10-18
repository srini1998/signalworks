import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import type { ModelState } from "./ai/useModel";
export function useLanguage() {
  return { ja: false, t: (en: string, _jp: string) => en, toggle: () => {} };
}
export function Entrance() {
  useEffect(() => {
    document.documentElement.lang = "en";
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = gsap.context(() =>
      gsap.from(".reveal", {
        opacity: 0,
        y: 18,
        stagger: 0.09,
        duration: 0.65,
        clearProps: "all",
      }),
    );
    return () => ctx.revert();
  }, []);
  return null;
}
export function ModelControl({
  state,
  load,
  stop,
}: {
  state: ModelState;
  load: () => void;
  stop: () => void;
  ja: boolean;
}) {
  return (
    <div className="model-control">
      <p>
        {state.phase === "ready"
          ? "Cloud AI connected. No model download. Requests use a limited free provider quota."
          : "Optional cloud AI. The main tool works immediately without downloading a model."}
      </p>
      {state.phase !== "ready" && (
        <button onClick={load} disabled={state.phase === "loading"}>
          {state.phase === "loading"
            ? "Checking connection…"
            : "Check cloud connection"}
        </button>
      )}
      {state.phase === "ready" && (
        <button className="quiet" onClick={stop}>
          Stop generation
        </button>
      )}
      {state.message && <p role="status">{state.message}</p>}
    </div>
  );
}
export function Trace({ entries }: { entries: unknown[]; ja: boolean }) {
  const [open, set] = useState(false),
    ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);
  return (
    <>
      <button className="trace-tab" onClick={() => set(true)}>
        Technical details ({entries.length})
      </button>
      <dialog ref={ref} onClose={() => set(false)} onCancel={() => set(false)}>
        <header>
          <h2>Run details</h2>
          <button onClick={() => set(false)} autoFocus>
            Close
          </button>
        </header>
        <p>
          Current page session. Main calculations run in your browser. Optional
          cloud generation sends its displayed task context to the provider.
        </p>
        <pre>{JSON.stringify(entries, null, 2)}</pre>
      </dialog>
    </>
  );
}
export function Shell({
  name,
  number,
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
          <a href="#how">How it works</a>
          <a href="https://my-portfolio-three-omega-46.vercel.app">
            Portfolio ↗
          </a>
        </div>
      </nav>
      {children}
      <footer>
        <span>Srinivas Venigalla · No model download needed</span>
        <a href="https://my-portfolio-three-omega-46.vercel.app">
          All projects ↗
        </a>
        <a href="/THIRD_PARTY_NOTICES.txt">Data & library licenses ↗</a>
      </footer>
    </>
  );
}
