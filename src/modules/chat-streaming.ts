// Streaming API calls for all providers
// Extracted from chatbot.ts for modularity

import type { AISettings } from "./settings";
import { addTokens, updateStatusBar } from "./token-usage";

export interface StreamContext {
  abortController: AbortController | null;
  agentAborted: boolean;
  scrollToBottom: () => void;
  setLinkedText: (el: HTMLElement, text: string) => void;
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
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096, stream: true }),
    signal: ctx.abortController?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mistral API error ${res.status}: ${err}`);
  }

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

export async function callAIOnce(settings: AISettings, prompt: string): Promise<string> {
  const messages = [{ role: "user", content: prompt }];
  try {
    switch (settings.provider) {
      case "openai":
      case "mimo":
      case "mistral": {
        const urls: Record<string, string> = {
          openai: "https://api.openai.com/v1/chat/completions",
          mimo: "https://api.xiaomimimo.com/v1/chat/completions",
          mistral: "https://api.mistral.ai/v1/chat/completions",
        };
        const res = await fetch(urls[settings.provider], {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model: settings.model, messages, max_tokens: 256 }),
        });
        if (!res.ok) return "";
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
          body: JSON.stringify({ model: settings.model, max_tokens: 256, messages }),
        });
        if (!res.ok) return "";
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
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 256 } }),
          }
        );
        if (!res.ok) return "";
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}
