// Streaming API calls for all providers
// Extracted from chatbot.ts for modularity

import type { AISettings } from "./settings";
import { addTokens, updateStatusBar } from "./token-usage";
import type { NativeToolDef } from "../config";

export interface StreamContext {
  abortController: AbortController | null;
  agentAborted: boolean;
  scrollToBottom: () => void;
  setLinkedText: (el: HTMLElement, text: string) => void;
}

// ── Native tool-use types ──

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AgentMessage {
  role: "user" | "assistant";
  content: AgentContentBlock[] | string;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  stopReason: string;
}

interface CallAIOnceOptions {
  throwOnError?: boolean;
}

const TRANSIENT_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 3;

function clipErrorText(value: string, limit = 320): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? trimmed.slice(0, limit) + "…" : trimmed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUS.has(status);
}

function isRetryableNetworkError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error") ||
    message.includes("load failed") ||
    message.includes("fetch failed") ||
    message.includes("timed out")
  );
}

function retryDelayMs(attempt: number): number {
  const base = 700 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return clipErrorText(text);
  } catch {
    return "";
  }
}

async function fetchWithRetries(
  provider: string,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  maxAttempts = MAX_TRANSIENT_RETRIES,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;

      const err = await readErrorBody(res);
      if (attempt < maxAttempts && isRetryableStatus(res.status)) {
        await delay(retryDelayMs(attempt), signal);
        continue;
      }

      const suffix = err ? `: ${err}` : "";
      throw new Error(`${provider} API error ${res.status} (attempt ${attempt}/${maxAttempts})${suffix}`);
    } catch (error) {
      if (isAbortError(error)) throw error;

      if (attempt < maxAttempts && isRetryableNetworkError(error)) {
        await delay(retryDelayMs(attempt), signal);
        continue;
      }

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`${provider} request failed (attempt ${attempt}/${maxAttempts}): ${String(error)}`);
    }
  }

  throw new Error(`${provider} request failed after ${maxAttempts} attempts.`);
}

async function readSSEStreamRaw(
  res: Response,
  ctx: StreamContext,
  onEvent: (json: Record<string, unknown>) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (ctx.agentAborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          onEvent(json);
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamAI(
  settings: AISettings,
  messages: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  let result: string;
  switch (settings.provider) {
    case "openai":
      result = await streamOpenAI(settings, messages, el, ctx); break;
    case "anthropic":
      result = await streamAnthropic(settings, messages, el, ctx); break;
    case "google":
      result = await callGoogleNonStream(settings, messages, el, ctx); break;
    case "mimo":
      result = await streamMiMo(settings, messages, el, ctx); break;
    case "mistral":
      result = await streamMistral(settings, messages, el, ctx); break;
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }
  addTokens(inputChars, result.length);
  updateStatusBar();
  return result;
}

export async function streamAgentTurn(
  settings: AISettings,
  messages: AgentMessage[],
  tools: NativeToolDef[],
  el: HTMLElement,
  ctx: StreamContext,
): Promise<AgentTurnResult> {
  const inputChars = messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);

  let result: AgentTurnResult;

  switch (settings.provider) {
    case "anthropic":
      result = await streamAnthropicAgent(settings, messages, tools, el, ctx);
      break;
    case "openai":
      result = await streamOpenAIAgent(settings, messages, tools, el, ctx);
      break;
    case "google":
    case "mimo":
    case "mistral":
      result = await streamFallbackAgent(settings, messages, el, ctx);
      break;
    default:
      throw new Error(`Unknown provider: ${settings.provider}`);
  }

  addTokens(inputChars, result.text.length);
  updateStatusBar();
  return result;
}

async function streamAnthropicAgent(
  settings: AISettings,
  messages: AgentMessage[],
  tools: NativeToolDef[],
  el: HTMLElement,
  ctx: StreamContext,
): Promise<AgentTurnResult> {
  const { toAnthropicTools } = await import("../config");
  const model = settings.model || "claude-sonnet-4-20250514";

  // Separate system messages and merge consecutive same-role turns
  let systemPrompt = "";
  const anthropicMessages: { role: string; content: unknown }[] = [];

  for (const m of messages) {
    if (typeof m.content === "string" && (m.role as string) === "system") {
      systemPrompt = m.content;
      continue;
    }
    const last = anthropicMessages[anthropicMessages.length - 1];
    if (last && last.role === m.role && typeof last.content === "string" && typeof m.content === "string") {
      last.content = last.content + "\n" + m.content;
    } else {
      anthropicMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: 8096,
    messages: anthropicMessages,
    tools: toAnthropicTools(tools),
    stream: true,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  let textAccumulator = "";
  let stopReason = "end_turn";
  const toolCallAccumulators = new Map<number, { id: string; name: string; inputJson: string }>();

  await readSSEStreamRaw(res, ctx, (json) => {
    const type = json.type as string;

    if (type === "content_block_start") {
      const block = json.content_block as Record<string, unknown>;
      const index = json.index as number;
      if ((block.type as string) === "tool_use") {
        toolCallAccumulators.set(index, {
          id: block.id as string,
          name: block.name as string,
          inputJson: "",
        });
      }
    } else if (type === "content_block_delta") {
      const delta = json.delta as Record<string, unknown>;
      const index = json.index as number;
      if (delta.type === "text_delta") {
        const chunk = (delta.text as string) || "";
        textAccumulator += chunk;
        ctx.setLinkedText(el, textAccumulator);
        ctx.scrollToBottom();
      } else if (delta.type === "input_json_delta") {
        const acc = toolCallAccumulators.get(index);
        if (acc) acc.inputJson += (delta.partial_json as string) || "";
      }
    } else if (type === "message_delta") {
      const delta = json.delta as Record<string, unknown>;
      stopReason = (delta.stop_reason as string) || stopReason;
    }
  });

  const toolCalls: AgentTurnResult["toolCalls"] = [];
  for (const [, acc] of toolCallAccumulators) {
    try {
      const args = acc.inputJson ? JSON.parse(acc.inputJson) : {};
      toolCalls.push({ id: acc.id, name: acc.name, args });
    } catch {
      toolCalls.push({ id: acc.id, name: acc.name, args: {} });
    }
  }

  return { text: textAccumulator, toolCalls, stopReason };
}

async function streamOpenAIAgent(
  settings: AISettings,
  messages: AgentMessage[],
  tools: NativeToolDef[],
  el: HTMLElement,
  ctx: StreamContext,
): Promise<AgentTurnResult> {
  const { toOpenAITools } = await import("../config");
  const model = settings.model || "gpt-4o";

  const openaiMessages: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      openaiMessages.push({ role: m.role, content: m.content });
    } else {
      for (const block of m.content as AgentContentBlock[]) {
        if (block.type === "text") {
          openaiMessages.push({ role: m.role, content: block.text });
        } else if (block.type === "tool_use") {
          openaiMessages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            }],
          });
        } else if (block.type === "tool_result") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }
    }
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      tools: toOpenAITools(tools),
      tool_choice: "auto",
      stream: true,
    }),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  let textAccumulator = "";
  let stopReason = "stop";
  const toolCallAccumulators = new Map<number, { id: string; name: string; argsJson: string }>();

  await readSSEStreamRaw(res, ctx, (json) => {
    const choice = (json.choices as Record<string, unknown>[])?.[0];
    if (!choice) return;
    const delta = choice.delta as Record<string, unknown>;
    if (!delta) return;

    if (typeof delta.content === "string") {
      textAccumulator += delta.content;
      ctx.setLinkedText(el, textAccumulator);
      ctx.scrollToBottom();
    }

    const toolCallDeltas = delta.tool_calls as Record<string, unknown>[] | undefined;
    if (toolCallDeltas) {
      for (const tc of toolCallDeltas) {
        const index = tc.index as number;
        if (!toolCallAccumulators.has(index)) {
          toolCallAccumulators.set(index, { id: (tc.id as string) || "", name: "", argsJson: "" });
        }
        const acc = toolCallAccumulators.get(index)!;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn?.name) acc.name = fn.name as string;
        if (fn?.arguments) acc.argsJson += fn.arguments as string;
        if (tc.id && !acc.id) acc.id = tc.id as string;
      }
    }

    const finishReason = choice.finish_reason as string;
    if (finishReason) stopReason = finishReason;
  });

  const toolCalls: AgentTurnResult["toolCalls"] = [];
  for (const [, acc] of toolCallAccumulators) {
    try {
      const args = acc.argsJson ? JSON.parse(acc.argsJson) : {};
      toolCalls.push({ id: acc.id, name: acc.name, args });
    } catch {
      toolCalls.push({ id: acc.id, name: acc.name, args: {} });
    }
  }

  return { text: textAccumulator, toolCalls, stopReason };
}

async function streamFallbackAgent(
  settings: AISettings,
  messages: AgentMessage[],
  el: HTMLElement,
  ctx: StreamContext,
): Promise<AgentTurnResult> {
  const { parseToolCalls } = await import("./chat-tool-parser");

  const flatMessages: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      flatMessages.push({ role: m.role, content: m.content });
    } else {
      const textParts: string[] = [];
      for (const block of m.content as AgentContentBlock[]) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          textParts.push("```tool\n" + JSON.stringify({ tool: block.name, args: block.input }) + "\n```");
        } else if (block.type === "tool_result") {
          textParts.push(`[tool_result:${block.tool_use_id}] ${block.content}`);
        }
      }
      flatMessages.push({ role: m.role, content: textParts.join("\n") });
    }
  }

  const fullText = await streamAI(settings, flatMessages, el, ctx);
  const { text, toolCalls: parsed } = parseToolCalls(fullText);

  const toolCalls = parsed.map((tc) => ({
    id: tc.id,
    name: tc.name,
    args: tc.args as Record<string, unknown>,
  }));

  return { text, toolCalls, stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn" };
}

// ── OpenAI streaming ──

async function streamOpenAI(
  settings: AISettings,
  messages: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const model = settings.model || "gpt-4o";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  return readSSEStream(res, el, ctx, (json) => {
    return json.choices?.[0]?.delta?.content || "";
  });
}

// ── Anthropic streaming ──

async function streamAnthropic(
  settings: AISettings,
  messages: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const model = settings.model || "claude-sonnet-4-20250514";

  // Anthropic requires system as a separate param, not in messages
  let systemPrompt = "";
  const filteredMessages = messages.filter((m) => {
    if (m.role === "system") {
      systemPrompt = m.content;
      return false;
    }
    return true;
  });

  // Anthropic requires alternating user/assistant messages
  // Merge consecutive same-role messages
  const mergedMessages: { role: string; content: string }[] = [];
  for (const m of filteredMessages) {
    const role = m.role === "tool" ? "user" : m.role;
    if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === role) {
      mergedMessages[mergedMessages.length - 1].content += "\n" + m.content;
    } else {
      mergedMessages.push({ role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: mergedMessages,
    stream: true,
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  return readSSEStream(res, el, ctx, (json) => {
    if (json.type === "content_block_delta") {
      return json.delta?.text || "";
    }
    return "";
  });
}

// ── MiMo streaming (OpenAI-compatible SSE) ──

async function streamMiMo(
  settings: AISettings,
  messages: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const model = settings.model || "mimo-v2-flash";
  const res = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": settings.apiKey,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 1.0,
      top_p: 0.95,
      max_completion_tokens: 4096,
    }),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`MiMo API error ${res.status}: ${err}`);
  }

  return readSSEStream(res, el, ctx, (json) => {
    return json.choices?.[0]?.delta?.content || "";
  });
}

// ── Mistral streaming (OpenAI-compatible SSE) ──

async function streamMistral(
  settings: AISettings,
  messages: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const model = settings.model || "mistral-small-latest";
  const res = await fetchWithRetries(
    "Mistral",
    "https://api.mistral.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096, stream: true }),
    },
    ctx.abortController?.signal,
  );

  return readSSEStream(res, el, ctx, (json) => {
    return json.choices?.[0]?.delta?.content || "";
  });
}

// ── Google (no SSE, falls back to non-stream with simulated typing) ──

async function callGoogleNonStream(
  settings: AISettings,
  history: { role: string; content: string }[],
  el: HTMLElement,
  ctx: StreamContext
): Promise<string> {
  const model = settings.model || "gemini-2.0-flash";

  // Extract system instruction
  let systemInstruction = "";
  const filteredHistory = history.filter((m) => {
    if (m.role === "system") {
      systemInstruction = m.content;
      return false;
    }
    return true;
  });

  const contents = filteredHistory.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = { contents };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctx.abortController?.signal,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";

  await simulateStream(fullText, el, ctx);
  return fullText;
}

// ── SSE stream reader (works for OpenAI, Anthropic, MiMo, Mistral) ──

async function readSSEStream(
  res: Response,
  el: HTMLElement,
  ctx: StreamContext,
  extractContent: (json: any) => string
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    if (ctx.agentAborted) {
      reader.cancel();
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const json = JSON.parse(data);
        const chunk = extractContent(json);
        if (chunk) {
          fullText += chunk;
          el.textContent = fullText;
          ctx.scrollToBottom();
        }
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  // Linkify URLs once streaming is complete
  ctx.setLinkedText(el, fullText);
  return fullText;
}

// ── Simulated streaming for non-SSE providers ──

export function simulateStream(text: string, el: HTMLElement, ctx: StreamContext): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (ctx.agentAborted) { resolve(); return; }
      const chunkSize = Math.min(2 + Math.floor(Math.random() * 3), text.length - i);
      i += chunkSize;
      el.textContent = text.substring(0, i);
      ctx.scrollToBottom();
      if (i < text.length) {
        requestAnimationFrame(step);
      } else {
        // Linkify URLs once streaming is complete
        ctx.setLinkedText(el, text);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

// ── Single non-streaming call (for summarization) ──

export async function callAIOnce(
  settings: AISettings,
  prompt: string,
  maxTokens = 256,
  options: CallAIOnceOptions = {},
): Promise<string> {
  const messages = [{ role: "user", content: prompt }];
  try {
    switch (settings.provider) {
      case "openai":
      case "mimo": {
        const urls: Record<string, string> = {
          openai: "https://api.openai.com/v1/chat/completions",
          mimo: "https://api.xiaomimimo.com/v1/chat/completions",
        };
        const res = await fetch(urls[settings.provider], {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model: settings.model, messages, max_tokens: maxTokens }),
        });
        if (!res.ok) {
          const err = await readErrorBody(res);
          throw new Error(`${settings.provider} API error ${res.status}${err ? `: ${err}` : ""}`);
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "";
      }
      case "mistral": {
        const res = await fetchWithRetries(
          "Mistral",
          "https://api.mistral.ai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify({ model: settings.model, messages, max_tokens: maxTokens }),
          },
        );
        const data = await res.json();
        return data.choices?.[0]?.message?.content || "";
      }
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({ model: settings.model, max_tokens: maxTokens, messages }),
        });
        if (!res.ok) {
          const err = await readErrorBody(res);
          throw new Error(`Anthropic API error ${res.status}${err ? `: ${err}` : ""}`);
        }
        const data = await res.json();
        return data.content?.[0]?.text || "";
      }
      case "google": {
        const model = settings.model || "gemini-2.0-flash";
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
          }
        );
        if (!res.ok) {
          const err = await readErrorBody(res);
          throw new Error(`Google API error ${res.status}${err ? `: ${err}` : ""}`);
        }
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
      default:
        return "";
    }
  } catch (error) {
    if (options.throwOnError) throw error;
    return "";
  }
}
