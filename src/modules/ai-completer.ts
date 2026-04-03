// AI-powered inline code suggestions (like GitHub Copilot)
// Runs independently from Ace's autocomplete - shows ghost text after 2.5s idle

import type { AISettings } from "./settings";

type GetAISettings = () => AISettings;

let getAISettings: GetAISettings = () => ({ provider: "", apiKey: "", model: "" });
let enabled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;
let activeEditor: any = null;
let ghostText: string = "";

const DEBOUNCE_MS = 2500;

export function setAICompleterConfig(getter: GetAISettings) {
  getAISettings = getter;
}

export function setAICompleterEnabled(v: boolean) {
  enabled = v;
  if (!v) clearGhostText();
}

// Attach to an Ace editor instance
export function attachAICompleter(editor: any) {
  activeEditor = editor;

  // On every change, debounce a completion request
  editor.on("change", () => {
    clearGhostText();
    if (!enabled) return;
    scheduleCompletion();
  });

  // On cursor move, clear ghost text
  editor.selection.on("changeCursor", () => {
    clearGhostText();
  });

  // Tab to accept ghost text - use keydown on the container DOM element
  // to intercept before Ace's own key handling
  (editor.container as HTMLElement).addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.shiftKey && ghostText) {
      e.preventDefault();
      e.stopPropagation();
      const text = ghostText;
      clearGhostText();
      activeEditor.insert(text);
    }
    // Escape to dismiss ghost text
    if (e.key === "Escape" && ghostText) {
      e.preventDefault();
      clearGhostText();
    }
  }, true); // capture phase to fire before Ace
}

function scheduleCompletion() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!enabled || !activeEditor) return;
    const settings = getAISettings();
    if (!settings.apiKey) return;
    triggerCompletion();
  }, DEBOUNCE_MS);
}

async function triggerCompletion() {
  if (!activeEditor) return;

  const session = activeEditor.session;
  const pos = activeEditor.getCursorPosition();
  const lines = session.getLines(0, session.getLength() - 1);

  // Build prefix
  const beforeLines = lines.slice(0, pos.row);
  beforeLines.push(lines[pos.row]?.substring(0, pos.column) || "");
  const prefix = beforeLines.join("\n");

  // Need at least some code
  if (prefix.trim().length < 3) return;

  // Build suffix
  const afterLines: string[] = [];
  afterLines.push(lines[pos.row]?.substring(pos.column) || "");
  afterLines.push(...lines.slice(pos.row + 1));
  const suffix = afterLines.join("\n");

  const fileName = activeEditor._athvaFileName || "file.ts";
  const requestId = ++currentRequestId;

  const completion = await fetchCompletion(prefix, suffix, fileName);

  // Check if still relevant
  if (requestId !== currentRequestId) return;
  if (!completion) return;
  if (!activeEditor) return;

  // Check cursor hasn't moved
  const newPos = activeEditor.getCursorPosition();
  if (newPos.row !== pos.row || newPos.column !== pos.column) return;

  // Show ghost text
  showGhostText(completion, pos.row, pos.column);
}

function showGhostText(text: string, row: number, col: number) {
  if (!activeEditor) return;

  clearGhostText();
  ghostText = text;

  // Add ghost text as DOM overlay
  const editorEl = activeEditor.container as HTMLElement;
  const ghostEl = document.createElement("div");
  ghostEl.className = "ai-ghost-text";
  ghostEl.id = "ai-ghost-overlay";

  // Get position of cursor in pixels
  const renderer = activeEditor.renderer;
  const charPos = renderer.textToScreenCoordinates(row, col);
  const editorRect = editorEl.getBoundingClientRect();

  // Only show first line of ghost text inline
  const firstLine = text.split("\n")[0];
  ghostEl.textContent = firstLine;
  ghostEl.style.left = `${charPos.pageX - editorRect.left}px`;
  ghostEl.style.top = `${charPos.pageY - editorRect.top}px`;
  ghostEl.style.height = `${renderer.lineHeight}px`;
  ghostEl.style.fontSize = `${activeEditor.getFontSize()}px`;

  editorEl.appendChild(ghostEl);
}

function clearGhostText() {
  ghostText = "";
  const existing = document.getElementById("ai-ghost-overlay");
  if (existing) existing.remove();
}

// ── Prompt ──

function buildPrompt(prefix: string, suffix: string, fileName: string): string {
  const lang = fileName.split(".").pop() || "code";
  return `You are a code autocomplete engine. Complete the code at the cursor position. Return ONLY the raw code that should be inserted - no explanation, no markdown fences, no backticks, no comments about the code. If you cannot determine a good completion, return a single space.

Language: ${lang}
File: ${fileName}

=== CODE BEFORE CURSOR ===
${prefix.slice(-1000)}
=== CURSOR IS HERE ===
${suffix.slice(0, 300)}
=== END ===

Code to insert at cursor:`;
}

function extractContent(data: any, provider: string): string {
  if (provider === "anthropic") {
    return data.content?.[0]?.text || "";
  }
  if (provider === "google") {
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  const msg = data.choices?.[0]?.message;
  if (!msg) return "";
  if (msg.content && msg.content.trim()) return msg.content;
  return "";
}

async function fetchCompletion(prefix: string, suffix: string, fileName: string): Promise<string> {
  const settings = getAISettings();
  if (!settings.apiKey || !settings.provider) return "";

  const prompt = buildPrompt(prefix, suffix, fileName);

  try {
    let data: any;

    switch (settings.provider) {
      case "openai": {
        const model = settings.model || "gpt-4o";
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        break;
      }
      case "anthropic": {
        const model = settings.model || "claude-sonnet-4-20250514";
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: prompt }] }),
        });
        if (!res.ok) return "";
        data = await res.json();
        break;
      }
      case "google": {
        const model = settings.model || "gemini-2.0-flash";
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 100, temperature: 0 } }),
        });
        if (!res.ok) return "";
        data = await res.json();
        break;
      }
      case "mimo": {
        const model = settings.model === "mimo-v2-pro" ? "mimo-v2-flash" : (settings.model || "mimo-v2-flash");
        const res = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": settings.apiKey },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: 100, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        break;
      }
      case "mistral": {
        const model = settings.model || "mistral-small-latest";
        const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        break;
      }
      default:
        return "";
    }

    let result = extractContent(data, settings.provider);
    result = result.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").replace(/^\s*\n/, "").trimEnd();
    if (!result.trim()) return "";
    return result;
  } catch {
    return "";
  }
}

// Remove the old Ace completer export - we no longer use it
export const aiCompleter = {
  identifierRegexps: [/[a-zA-Z_0-9\.$\-\u00A2-\uFFFF]/],
  getCompletions(_e: any, _s: any, _p: any, _pr: any, cb: any) {
    cb(null, []);
  },
};
