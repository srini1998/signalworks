import { useCallback, useEffect, useRef, useState } from "react";
export type ModelState = {
  phase: "idle" | "loading" | "ready" | "error";
  loaded?: number;
  total?: number;
  model?: string;
  device?: string;
  message?: string;
};
type Message = { role: string; content: string };
export function useModel() {
  const [state, setState] = useState<ModelState>({ phase: "idle" });
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const r = await fetch("/api/generate");
      const data = await r.json();
      setState(
        data.enabled
          ? { phase: "ready", device: "cloud", model: data.model }
          : {
              phase: "idle",
              message:
                "New cloud generations are not connected. The main workflow and recorded experiments work without an account or model download.",
            },
      );
    } catch {
      setState({
        phase: "idle",
        message:
          "Cloud generation is not connected. You can still use the main workflow.",
      });
    }
  }, []);
  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);
  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);
  const generate = useCallback(
    async (
      messages: Message[],
      onChunk?: (s: string) => void,
      maxTokens = 300,
      prefill = "",
    ) => {
      if (controller.current) throw Error("A generation is already running.");
      const c = new AbortController();
      controller.current = c;
      const started = performance.now();
      const timer = setTimeout(() => c.abort(), 45000);
      try {
        const r = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, maxTokens }),
          signal: c.signal,
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error || "Cloud generation unavailable");
        const text = prefill + data.text;
        onChunk?.(text);
        return {
          text,
          model: data.model,
          device: "cloud",
          ms: Math.round(performance.now() - started),
        };
      } finally {
        clearTimeout(timer);
        if (controller.current === c) controller.current = null;
      }
    },
    [],
  );
  return { state, load, stop, generate };
}
