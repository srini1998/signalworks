import { useCallback, useEffect, useRef, useState } from "react";
export type ModelState = {
  phase: "idle" | "loading" | "ready" | "error";
  loaded?: number;
  total?: number;
  model?: string;
  device?: string;
  message?: string;
};
export function useModel() {
  const [state, setState] = useState<ModelState>({ phase: "idle" });
  const worker = useRef<Worker | null>(null),
    files = useRef<Record<string, { loaded: number; total: number }>>({});
  const pending = useRef<{
    resolve: (r: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    files.current = {};
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.reject(new Error("Stopped"));
      pending.current = null;
    }
    setState({ phase: "idle" });
  }, []);
  const ensure = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    w.onerror = (e) => {
      setState({ phase: "error", message: e.message });
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.reject(new Error(e.message));
        pending.current = null;
      }
    };
    w.onmessage = ({ data: m }) => {
      if (m.type === "progress") {
        files.current[m.file] = { loaded: m.loaded ?? 0, total: m.total ?? 0 };
        const f = Object.values(files.current);
        setState({
          phase: "loading",
          loaded: f.reduce((a, b) => a + b.loaded, 0),
          total: f.reduce((a, b) => a + b.total, 0),
        });
      }
      if (m.type === "ready")
        setState({ phase: "ready", model: m.model, device: m.device });
      if (m.type === "done" && pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.resolve(m);
        pending.current = null;
      }
      if (m.type === "error") {
        setState({ phase: "error", message: m.message });
        if (pending.current) {
          clearTimeout(pending.current.timer);
          pending.current.reject(new Error(m.message));
          pending.current = null;
        }
      }
    };
    return w;
  }, []);
  const load = useCallback(() => {
    if (state.phase === "loading" || state.phase === "ready") return;
    worker.current?.terminate();
    worker.current = null;
    setState({ phase: "loading" });
    ensure().postMessage({ type: "load" });
  }, [ensure, state.phase]);
  const generate = useCallback(
    (
      messages: { role: string; content: string }[],
      _onToken?: (s: string) => void,
      maxTokens = 256,
      prefill = "",
    ) => {
      if (pending.current)
        return Promise.reject(new Error("An agent is already running"));
      return new Promise<{
        text: string;
        ms: number;
        model: string;
        device: string;
      }>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.current?.terminate();
          worker.current = null;
          pending.current = null;
          setState({
            phase: "error",
            message: "Generation timed out. Reload the model to retry.",
          });
          reject(new Error("Generation exceeded 3 minutes"));
        }, 180000);
        pending.current = { resolve, reject, timer };
        ensure().postMessage({
          type: "generate",
          id: crypto.randomUUID(),
          messages,
          maxTokens,
          prefill,
        });
      });
    },
    [ensure],
  );
  useEffect(
    () => () => {
      worker.current?.terminate();
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.reject(new Error("Page closed"));
        pending.current = null;
      }
    },
    [],
  );
  return { state, load, generate, stop };
}
