// AI-powered inline code suggestions
// Shows a small "Suggest" button after 2.5s idle. Click it to get AI completion.

import type { AISettings } from "./settings";
import { showInputDialog } from "./dialogs";

type GetAISettings = () => AISettings;

let getAISettings: GetAISettings = () => ({ provider: "", apiKey: "", model: "" });
let enabled = false;
let activeEditor: any = null;
let activeContainerEl: HTMLElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;
let ghostText = "";
let suggestBtn: HTMLButtonElement | null = null;
let suggestAnchor: { lineNumber: number; column: number } | null = null;
let ghostEl: HTMLElement | null = null;
let actionMenu: HTMLElement | null = null;
let isLoading = false;
let floatingTextareaContainer: HTMLElement | null = null;
let floatingTextarea: HTMLTextAreaElement | null = null;
let floatingTextareaBtn: HTMLButtonElement | null = null;

const DEBOUNCE_MS = 2500;
const ANTHROPIC_COMPLETION_MAX_TOKENS = 8192;

const SELECTION_ACTIONS = [
  { label: "🔧 Fix", action: "fix", prompt: "Fix any bugs, errors, or issues in the following code. Return ONLY the corrected raw code, no explanation, no markdown fences, no backticks." },
  { label: "💡 Explain", action: "explain", prompt: "Explain the following code concisely. Be brief and clear." },
  { label: "🔍 Review", action: "review", prompt: "Review the following code like a senior engineer. Findings first, ordered by severity. Focus on bugs, risks, regressions, and missing tests. If there are no findings, say \"No findings\" and mention any residual risks or testing gaps. Be concise." },
  { label: "🐞 Debug", action: "debug", prompt: "Debug the following code. Identify the most likely failure points, edge cases, and root causes. Suggest the smallest effective fixes and what to inspect next. Do not rewrite the code unless a tiny code example is necessary. Be concise." },
  { label: "✨ Enhance", action: "enhance", prompt: "Improve and enhance the following code - better naming, cleaner logic, modern patterns. Return ONLY the corrected raw code, no explanation, no markdown fences, no backticks." },
  { label: "♻️ Apply DRY", action: "dry", prompt: "Refactor the following code to remove repetition (Don't Repeat Yourself principle). Extract shared logic into functions/variables. Return ONLY the corrected raw code, no explanation, no markdown fences, no backticks." },
  { label: "📝 Add Docs", action: "docs", prompt: "Add JSDoc/TSDoc comments and inline comments to the following code. Add documentation for functions, parameters, return types, and any complex logic. Return ONLY the documented raw code, no explanation, no markdown fences, no backticks." },
  { label: "🧹 Clean", action: "clean", prompt: "Clean up the following code - remove dead code, unused variables, unnecessary comments, fix formatting inconsistencies, simplify overly complex expressions. Return ONLY the cleaned raw code, no explanation, no markdown fences, no backticks." },
  { label: "✏️ Edit", action: "edit", prompt: "" },
  { label: "💬 Send to Chat", action: "chat", prompt: "" },
];

let onSendToChat: ((text: string) => void) | null = null;

export function setOnSendToChat(cb: (text: string) => void) {
  onSendToChat = cb;
}

export function setAICompleterConfig(getter: GetAISettings) {
  getAISettings = getter;
}

export function setAICompleterEnabled(v: boolean) {
  enabled = v;
  if (!v) {
    hideSuggestBtn();
    clearGhost();
  }
}

export function attachAICompleter(editor: any, containerEl: HTMLElement) {
  activeEditor = editor;
  activeContainerEl = containerEl;

  // Create the suggest button
  suggestBtn = document.createElement("button");
  suggestBtn.className = "ai-suggest-btn hidden";
  suggestBtn.textContent = "✨ Suggest";
  suggestBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  suggestBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await onSuggestClick();
  });
  containerEl.appendChild(suggestBtn);

  // Create floating textarea shown when file is empty
  floatingTextareaContainer = document.createElement("div");
  floatingTextareaContainer.className = "ai-floating-textarea-container hidden";

  const header = document.createElement("div");
  header.className = "ai-floating-header";

  const headerIcon = document.createElement("div");
  headerIcon.className = "ai-floating-header-icon";
  headerIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936zM4.5 1.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 0 1H5v.5a.5.5 0 0 1-1 0V3.5h-.5a.5.5 0 0 1 0-1H4V2a.5.5 0 0 1 .5-.5zm7 0a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 0 1H12v.5a.5.5 0 0 1-1 0V3.5h-.5a.5.5 0 0 1 0-1H11V2a.5.5 0 0 1 .5-.5z"/></svg>`;

  const headerText = document.createElement("div");
  headerText.className = "ai-floating-header-text";

  const headerTitle = document.createElement("span");
  headerTitle.className = "ai-floating-header-title";
  headerTitle.textContent = "Athva Agent";

  const headerSub = document.createElement("span");
  headerSub.className = "ai-floating-header-sub";
  headerSub.textContent = "Generate code with AI";

  headerText.appendChild(headerTitle);
  headerText.appendChild(headerSub);
  header.appendChild(headerIcon);
  header.appendChild(headerText);
  floatingTextareaContainer.appendChild(header);

  floatingTextarea = document.createElement("textarea");
  floatingTextarea.className = "ai-floating-textarea";
  floatingTextarea.placeholder = "Describe what you want to build, or paste a prompt…";
  floatingTextarea.rows = 4;

  const footer = document.createElement("div");
  footer.className = "ai-floating-footer";

  const hint = document.createElement("span");
  hint.className = "ai-floating-hint";
  hint.textContent = "Enter to generate · Shift+Enter for newline";

  floatingTextareaBtn = document.createElement("button");
  floatingTextareaBtn.className = "ai-floating-textarea-btn";
  floatingTextareaBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936z"/></svg>Generate`;
  floatingTextareaBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const prompt = floatingTextarea?.value;
    if (!prompt?.trim()) return;
    onEmptyGenerateClick(prompt);
  });

  floatingTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const prompt = floatingTextarea?.value;
      if (!prompt?.trim()) return;
      onEmptyGenerateClick(prompt);
    }
  });

  footer.appendChild(hint);
  footer.appendChild(floatingTextareaBtn);
  floatingTextareaContainer.appendChild(floatingTextarea);
  floatingTextareaContainer.appendChild(footer);
  containerEl.appendChild(floatingTextareaContainer);

  // Create selection action menu
  actionMenu = document.createElement("div");
  actionMenu.className = "ai-action-menu hidden";
  for (const item of SELECTION_ACTIONS) {
    const btn = document.createElement("button");
    btn.className = "ai-action-item";
    btn.textContent = item.label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideActionMenu();
      onActionClick(item.action, item.prompt);
    });
    actionMenu.appendChild(btn);
  }
  containerEl.appendChild(actionMenu);

  // When model switches (new file opened), sync floating textarea visibility
  editor.onDidChangeModel(() => {
    hideSuggestBtn();
    clearGhost();
    hideActionMenu();
    if ((editor.getModel()?.getValue() ?? "").trim() === "") {
      showFloatingTextarea();
    } else {
      hideFloatingTextarea();
    }
  });

  // On change: hide button + ghost + action menu, restart debounce
  editor.onDidChangeModelContent(() => {
    hideSuggestBtn();
    hideFloatingTextarea();
    clearGhost();
    hideActionMenu();
    if (!enabled) return;
    scheduleSuggestBtnAtCursor();
    if ((editor.getModel()?.getValue() ?? "").trim() === "") {
      showFloatingTextarea();
    }
  });

  // On selection change: cancel suggest, clear ghost
  editor.onDidChangeCursorSelection(() => {
    cancelSuggestIfCursorMoved();
    clearGhost();
    hideActionMenu();
  });

  // On cursor position change: cancel suggest, clear ghost, hide action menu if no selection
  editor.onDidChangeCursorPosition(() => {
    cancelSuggestIfCursorMoved();
    clearGhost();
    const sel = editor.getSelection();
    const hasSelection = sel && !(sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn);
    if (!hasSelection) hideActionMenu();
  });

  editor.onDidScrollChange(repositionSuggestBtn);
  editor.onDidLayoutChange(repositionSuggestBtn);
  editor.onDidBlurEditorText(() => {
    if (document.activeElement === suggestBtn) return;
    hideSuggestBtn();
  });

  // Tab to accept ghost text
  containerEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.shiftKey && ghostText) {
      e.preventDefault();
      e.stopPropagation();
      const text = ghostText;
      clearGhost();
      const sel = activeEditor.getSelection();
      if (sel) activeEditor.executeEdits("ai", [{ range: sel, text }]);
    }
    if (e.key === "Escape") {
      hideSuggestBtn();
      if (ghostText) {
        e.preventDefault();
        clearGhost();
      }
    }
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      suggestBtn?.classList.add("hidden");
    }
  }, true);
}

// ── Suggest Button ──

function samePoint(a: { lineNumber: number; column: number } | null, b: { lineNumber: number; column: number } | null) {
  if (!a || !b) return false;
  return a.lineNumber === b.lineNumber && a.column === b.column;
}

function scheduleSuggestBtnAtCursor() {
  if (!activeEditor) return;
  const pos = activeEditor.getPosition();
  if (!pos) return;
  suggestAnchor = { lineNumber: pos.lineNumber, column: pos.column };
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!enabled || !activeEditor) return;
    const settings = getAISettings();
    if (!settings.apiKey) return;
    if (!samePoint(suggestAnchor, activeEditor.getPosition())) {
      hideSuggestBtn();
      return;
    }
    showSuggestBtn();
  }, DEBOUNCE_MS);
}

function cancelSuggestIfCursorMoved() {
  if (!activeEditor || !suggestAnchor) return;
  if (samePoint(suggestAnchor, activeEditor.getPosition())) return;
  hideSuggestBtn();
}

function repositionSuggestBtn() {
  if (!suggestBtn || suggestBtn.classList.contains("hidden")) return;
  showSuggestBtn();
}

function showSuggestBtn() {
  if (!suggestBtn || !activeEditor || !activeContainerEl || isLoading) return;
  if (!suggestAnchor) return;

  const cursor = activeEditor.getPosition();
  if (!samePoint(suggestAnchor, cursor)) {
    hideSuggestBtn();
    return;
  }

  const content = (activeEditor.getModel()?.getValue() ?? "").trim();
  if (!content) return;

  const coords = activeEditor.getScrolledVisiblePosition(suggestAnchor);
  if (!coords) return;

  suggestBtn.style.left = `${Math.max(0, coords.left + 8)}px`;
  suggestBtn.style.top = `${Math.max(0, coords.top)}px`;
  suggestBtn.classList.remove("hidden");
  suggestBtn.textContent = "✨ Suggest";
  suggestBtn.disabled = false;
}

function showFloatingTextarea() {
  if (!floatingTextareaContainer || !activeEditor || isLoading) return;
  floatingTextareaContainer.classList.remove("hidden");
}

function hideFloatingTextarea() {
  if (!floatingTextareaContainer) return;
  floatingTextareaContainer.classList.add("hidden");
}

function hideSuggestBtn() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  suggestAnchor = null;
  suggestBtn?.classList.add("hidden");
}

// ── Selection Action Menu ──

function showActionMenu() {
  if (!actionMenu || !activeEditor || !activeContainerEl || isLoading) return;

  const cursor = activeEditor.getPosition();
  if (!cursor) return;
  const coords = activeEditor.getScrolledVisiblePosition(cursor);
  if (!coords) return;

  actionMenu.classList.remove("hidden");

  const lineH = coords.height ?? 20;
  const menuWidth = actionMenu.offsetWidth || 176;
  const menuHeight = actionMenu.offsetHeight || 320;
  const containerRect = activeContainerEl.getBoundingClientRect();
  const anchorX = coords.left + 8;
  const anchorY = coords.top + lineH + 4;
  const maxLeft = Math.max(8, containerRect.width - menuWidth - 8);
  const maxTop = Math.max(8, containerRect.height - menuHeight - 8);
  const belowTop = Math.max(8, Math.min(anchorY, maxTop));
  const aboveTop = Math.max(8, Math.min(coords.top - menuHeight - 8, maxTop));
  const top = anchorY + menuHeight <= containerRect.height - 8 ? belowTop : aboveTop;

  actionMenu.style.left = `${Math.max(8, Math.min(anchorX, maxLeft))}px`;
  actionMenu.style.top = `${top}px`;
}

function hideActionMenu() {
  actionMenu?.classList.add("hidden");
}

async function onActionClick(action: string, systemPrompt: string) {
  if (!activeEditor) return;

  const sel = activeEditor.getSelection();
  const selectedText = sel ? (activeEditor.getModel()?.getValueInRange(sel) ?? "") : "";
  if (!selectedText.trim()) return;

  if (action === "edit") {
    const instruction = await showInputDialog("Edit Code", "What should I change?", "");
    if (!instruction) { activeEditor.focus(); return; }

    const settings = getAISettings();
    if (!settings.apiKey) { activeEditor.focus(); return; }

    const selection = activeEditor.getSelection();
    const fileName = (activeEditor as any)._athvaFileName || "file.ts";
    const lang = fileName.split(".").pop() || "code";
    const editPrompt = `Apply the following edit to the code: "${instruction}". Return ONLY the modified raw code, no explanation, no markdown fences, no backticks.\n\nLanguage: ${lang}\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;

    isLoading = true;
    try {
      let result = await fetchActionResult(settings, editPrompt);
      isLoading = false;
      if (result) {
        result = result.replace(/^```[\w]*\s*\n?/, "").replace(/\n?```\s*$/, "").trimEnd();
        if (selection) activeEditor.executeEdits("ai", [{ range: selection, text: result }]);
      }
    } catch { isLoading = false; }
    activeEditor.focus();
    return;
  }

  if (action === "chat") {
    if (onSendToChat) {
      const fileName = (activeEditor as any)._athvaFileName || "file";
      const lang = fileName.split(".").pop() || "code";
      onSendToChat(`\`\`\`${lang}\n${selectedText}\n\`\`\`\n\n`);
    }
    activeEditor.focus();
    return;
  }

  if (isLoading) return;

  const settings = getAISettings();
  if (!settings.apiKey) return;

  const selection = activeEditor.getSelection();
  const fileName = (activeEditor as any)._athvaFileName || "file.ts";
  const lang = fileName.split(".").pop() || "code";
  const isReplace = !["explain", "review", "debug"].includes(action);
  const prompt = `${systemPrompt}\n\nLanguage: ${lang}\n\n\`\`\`${lang}\n${selectedText}\n\`\`\``;

  isLoading = true;

  try {
    let result = await fetchActionResult(settings, prompt);
    isLoading = false;

    if (!result) return;

    if (isReplace) {
      result = result.replace(/^```[\w]*\s*\n?/, "").replace(/\n?```\s*$/, "").trimEnd();
      if (selection) activeEditor.executeEdits("ai", [{ range: selection, text: result }]);
    } else {
      showExplanation(result, selection?.endLineNumber ?? 1, selection?.endColumn ?? 1);
    }
  } catch {
    isLoading = false;
  }

  activeEditor.focus();
}

function showExplanation(text: string, lineNumber: number, column: number) {
  if (!activeEditor || !activeContainerEl) return;

  const existing = document.getElementById("ai-explanation");
  if (existing) existing.remove();

  const coords = activeEditor.getScrolledVisiblePosition({ lineNumber, column });
  if (!coords) return;

  const lineH = coords.height ?? 20;

  const el = document.createElement("div");
  el.id = "ai-explanation";
  el.className = "ai-explanation";
  el.textContent = text;

  const closeBtn = document.createElement("button");
  closeBtn.className = "ai-explanation-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => el.remove());
  el.appendChild(closeBtn);

  el.style.left = `${coords.left}px`;
  el.style.top = `${coords.top + lineH + 4}px`;

  activeContainerEl.appendChild(el);

  const disposable = activeEditor.onDidChangeModelContent(() => {
    el.remove();
    disposable.dispose();
  });
}

async function fetchActionResult(settings: AISettings, prompt: string): Promise<string> {
  try {
    let data: any;
    switch (settings.provider) {
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model: settings.model || "gpt-4o", messages: [{ role: "user", content: prompt }], max_tokens: 500, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
      }
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: settings.model || "claude-sonnet-4-20250514", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
        });
        if (!res.ok) return "";
        data = await res.json();
        return data.content?.[0]?.text?.trim() || "";
      }
      case "google": {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${settings.model || "gemini-2.0-flash"}:generateContent?key=${settings.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 500, temperature: 0 } }),
        });
        if (!res.ok) return "";
        data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      }
      case "mimo": {
        const model = settings.model === "mimo-v2-pro" ? "mimo-v2-flash" : (settings.model || "mimo-v2-flash");
        const res = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": settings.apiKey },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: 500, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
      }
      case "mistral": {
        const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({ model: settings.model || "mistral-small-latest", messages: [{ role: "user", content: prompt }], max_tokens: 500, temperature: 0 }),
        });
        if (!res.ok) return "";
        data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}

async function onSuggestClick() {
  if (!activeEditor || !suggestBtn || isLoading) return;

  const pos = activeEditor.getPosition();
  if (!pos) return;
  activeEditor.focus();
  activeEditor.setPosition(pos);

  isLoading = true;
  suggestBtn.textContent = "⏳ Thinking...";
  suggestBtn.disabled = true;

  const allText = activeEditor.getModel()?.getValue() ?? "";
  const lines = allText.split("\n");

  const beforeLines = lines.slice(0, pos.lineNumber - 1);
  beforeLines.push(lines[pos.lineNumber - 1]?.substring(0, pos.column - 1) || "");
  const prefix = beforeLines.join("\n");

  const afterLines: string[] = [];
  afterLines.push(lines[pos.lineNumber - 1]?.substring(pos.column - 1) || "");
  afterLines.push(...lines.slice(pos.lineNumber));
  const suffix = afterLines.join("\n");

  if (prefix.trim().length < 2) {
    hideSuggestBtn();
    isLoading = false;
    return;
  }

  const fileName = (activeEditor as any)._athvaFileName || "file.ts";
  const requestId = ++currentRequestId;

  const completion = await fetchCompletion(prefix, suffix, fileName);
  isLoading = false;

  if (requestId !== currentRequestId) return;

  hideSuggestBtn();

  if (!completion) return;

  const newPos = activeEditor.getPosition();
  if (!newPos || newPos.lineNumber !== pos.lineNumber || newPos.column !== pos.column) return;

  showGhost(completion, pos.lineNumber, pos.column);
}

async function onEmptyGenerateClick(prompt: string) {
  try {
    const fileName = (activeEditor as any)._athvaFileName || "file.ts";
    const completion = await fetchCompletion(prompt, "", fileName);
    if (!completion) return;
    const pos = activeEditor.getPosition();
    if (!pos) return;
    activeEditor.executeEdits("ai", [{
      range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
      text: completion,
    }]);
  } catch (error) {
    console.error(error);
  }
}

// ── Ghost Text ──

function showGhost(text: string, lineNumber: number, column: number) {
  if (!activeEditor || !activeContainerEl) return;
  clearGhost();
  ghostText = text;

  const coords = activeEditor.getScrolledVisiblePosition({ lineNumber, column });
  if (!coords) return;

  const lineH = coords.height ?? 20;

  ghostEl = document.createElement("div");
  ghostEl.className = "ai-ghost-text";

  const firstLine = text.split("\n")[0];
  ghostEl.textContent = firstLine;
  ghostEl.style.left = `${coords.left}px`;
  ghostEl.style.top = `${coords.top}px`;
  ghostEl.style.height = `${lineH}px`;

  activeContainerEl.appendChild(ghostEl);
}

function clearGhost() {
  ghostText = "";
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }
}

// ── Prompt & API ──

function buildPrompt(prefix: string, suffix: string, fileName: string): string {
  const lang = fileName.split(".").pop() || "code";
  return `You are a code autocomplete engine. Complete the code at the cursor position. Return ONLY the raw code that should be inserted - no explanation, no markdown fences, no backticks, no comments about the code. If you cannot determine a good completion, return a single space.

Language: ${lang}
File: ${fileName}

=== CODE BEFORE CURSOR ===
${prefix}
=== CURSOR IS HERE ===
${suffix}
=== END ===

Code to insert at cursor:`;
}

function extractContent(data: any, provider: string): string {
  if (provider === "anthropic") return data.content?.[0]?.text || "";
  if (provider === "google") return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
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
          body: JSON.stringify({ model, max_tokens: ANTHROPIC_COMPLETION_MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
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
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
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
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
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
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
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

// Exported for external use (e.g. triggering action menu from context menu)
export function showAIActionMenu() {
  showActionMenu();
}
