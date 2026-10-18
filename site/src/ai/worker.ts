/// <reference lib="webworker" />
// In-browser language model (transformers.js). Runs entirely on the visitor's device: WebGPU when
// available, otherwise WebAssembly. Weights come from the Hugging Face CDN and are cached by the browser.
import { pipeline, TextStreamer, env } from "@huggingface/transformers";

env.allowLocalModels = false;
// Gemma 3 1B instruct, 4-bit weights. Tested 2026-10-18: q4f16 models produced degenerate text on WebGPU
// here, and Qwen2.5-0.5B could not hold the output format; this model follows the format reliably.
let MODEL = "onnx-community/gemma-3-1b-it-ONNX";
let DTYPE: string | null = null;
let generator: any = null;
let device = "wasm";

type In = { type: "load"; model?: string; dtype?: string } | { type: "generate"; id: string; messages: { role: string; content: string }[]; maxTokens: number; prefill?: string };

async function load(model?: string, dtype?: string) {
  if (generator) return;
  if (model) MODEL = model;
  if (dtype) DTYPE = dtype;
  const hasGpu = typeof (self as any).navigator?.gpu !== "undefined" && (await (self as any).navigator.gpu.requestAdapter().catch(() => null));
  device = hasGpu ? "webgpu" : "wasm";
  generator = await pipeline("text-generation", MODEL, {
    device: device as any,
    dtype: (DTYPE ?? "q4") as any,
    progress_callback: (p: any) => {
      if (p.status === "progress") postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  postMessage({ type: "ready", device, model: MODEL });
}

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") return await load(msg.model, msg.dtype);
    await load();
    const t0 = performance.now();
    let text = "";
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      callback_function: (chunk: string) => {
        text += chunk;
        postMessage({ type: "token", id: msg.id, chunk });
      },
    });
    // Pre-filling the start of the reply keeps a small model inside the requested line format.
    const prefill = msg.prefill ?? "";
    const prompt = generator.tokenizer.apply_chat_template(msg.messages, { tokenize: false, add_generation_prompt: true }) + prefill;
    await generator(prompt, { max_new_tokens: msg.maxTokens, do_sample: false, repetition_penalty: 1.15, return_full_text: false, streamer });
    postMessage({ type: "done", id: msg.id, text: prefill + text, ms: Math.round(performance.now() - t0), device, model: MODEL });
  } catch (err) {
    postMessage({ type: "error", id: (msg as any).id, message: (err as Error).message });
  }
};
