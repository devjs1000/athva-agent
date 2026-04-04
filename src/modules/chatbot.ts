import { invoke } from "@tauri-apps/api/core";
import type { AISettings, AgentAccess, AppSettings } from "./settings";
import type { AgentMemory } from "./agent-memory";
import {
  type ChatSession,
  type ChatMessage,
  type ChatMode,
  type ToolCall,
  createSession,
  saveSession,
  getAllSessions,
  deleteSession,
} from "./chat-store";

// ── Agent tool definitions for LLM function calling ──

const AGENT_TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path",
    parameters: { path: "string — absolute file path" },
  },
  {
    name: "write_file",
    description: "Write content to a file at the given path (creates or overwrites)",
    parameters: { path: "string — absolute file path", content: "string — file content" },
  },
  {
    name: "list_dir",
    description: "List files and directories in the given path",
    parameters: { path: "string — absolute directory path" },
  },
  {
    name: "run_command",
    description: "Run a shell command in the project directory and return the output",
    parameters: { command: "string — shell command to execute" },
  },
  {
    name: "search_files",
    description: "Search for files matching a query in the project",
    parameters: { query: "string — search query (matched against file paths)" },
  },
  {
    name: "make_plan",
    description: "Create a concise execution plan before doing non-trivial work",
    parameters: {
      title: "string — short plan title",
      steps: "string — newline-separated plan steps",
      notes: "string — optional constraints, assumptions, or risks",
    },
  },
];

// ── System prompts ──

const CHAT_SYSTEM_PROMPT = `You are Athva, a helpful AI coding assistant. You help users understand code, answer programming questions, and provide suggestions. Be concise and precise in your responses.`;

function buildAgentSystemPrompt(projectPath: string, access: AgentAccess): string {
  const tools = AGENT_TOOLS.filter((t) => {
    if (t.name === "read_file" || t.name === "list_dir" || t.name === "search_files") return access.fileRead;
    if (t.name === "write_file") return access.fileWrite;
    if (t.name === "run_command") return access.terminal;
    if (t.name === "make_plan") return true;
    return false;
  });

  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");

  return `You are Athva Agent, an autonomous AI coding assistant. You can take actions on the user's codebase with their approval.

Current project path: ${projectPath}

## Available Tools
${toolDescriptions || "(No tools available — ask the user to enable permissions in Settings)"}

## How to Use Tools
When you need to perform an action, output EXACTLY ONE tool call per response in this format:

\`\`\`tool
{"tool": "<tool_name>", "args": {"param": "value"}}
\`\`\`

CRITICAL RULES:
- Output only ONE tool call per response. After the tool result comes back, you can call the next tool.
- The tool call must be valid JSON on a single line inside the \`\`\`tool block.
- String values in args must use \\n for newlines, not actual newlines.
- Always close the code block with \`\`\`.
- You can include a brief explanation before the tool block, but keep it short.

## Guidelines
- Default to acting, not asking. If enough context exists to make a reasonable implementation decision, continue with tool calls instead of pausing for clarification.
- Ask the user about preferences only when the decision materially affects the implementation and cannot be inferred from the request or existing codebase. If the codebase already implies the right choice, follow it and continue.
- For non-trivial tasks with multiple steps, dependencies, or edits across files, use make_plan first so the user can review the plan before execution.
- First connect the request to the existing codebase. Reuse existing patterns, modules, naming, and architecture before creating new files.
- First try to find missing pieces through inspection and brief brainstorming. Ask concise clarifying questions only when those missing pieces block a correct implementation and cannot be resolved from the codebase, prior messages, or a reasonable assumption.
- Ask the user whether they want unit tests only when tests are actually relevant to the task and the answer is not already known. If they explicitly do not want tests, skip them. Do not pause the main implementation only to ask about tests if the core implementation can proceed safely.
- Before coding, decide what units are actually required. Do not force all layers by default.
- The preferred build order is from small unit to large unit: utils, atoms, hooks, molecules, organisms, templates, pages, routes, app.
- Before coding, produce a compact inventory of required units, one JSON object per line, for example:
  {"type":"util","name":"email_validator","description":"email validator","testing_method":"test by unit test"}
  {"type":"atom","name":"Button","description":"Button component","testing_method":"test by unit test"}
- Only include valid or required layers. If a layer is unnecessary, skip it.
- Prefer run_command over write_file when a CLI tool can generate files. For example use "npm init -y", "pnpm init", "npx create-react-app", etc. instead of manually writing package.json.
- Prefer search, pattern matching, regex, and simple algorithms to detect existing behavior or structure before manual inspection. Use search_files first when possible, and use run_command for fast codebase search when terminal access is available.
- Always read a file before modifying it.
- If a file you read is empty or whitespace-only and the user has not already defined what should go into it, ask a concise clarifying question before writing anything. Ask for the file's purpose, expected behavior/features, and any framework or interface requirements you need.
- Coding should move from the smallest reusable units to the largest integrating units.
- Explain what you're about to do before calling a tool.
- After a tool result, analyze the output and decide the next step.
- Do not stop after planning, inventory, search, or read steps if the task is still incomplete. Continue making tool calls until the task is finished or a blocking clarification is required.
- Do not ask questions merely to confirm ordinary implementation choices, naming, file placement, or structure when the existing codebase already suggests the answer.
- If the user asks for implementation, the default assumption is that they want code changes completed end-to-end in the current turn unless they explicitly ask only for analysis or planning.
- If a tool call is denied by the user, respect that and find an alternative approach.
- NEVER read files like .gitignore, .env, lock files (package-lock.json, pnpm-lock.yaml, yarn.lock), or anything inside node_modules, dist, build, .git directories. These are heavy or sensitive.
- Be concise. Focus on taking action, not lengthy explanations.
- Before finishing, validate the result. Check for integration gaps, missing imports, obvious runtime issues, and whether the implementation matches the request.
- When done with a task, summarize what you did.`;
}

// ── Chatbot class ──

export class Chatbot {
  private messagesEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLElement;
  private sessionListEl: HTMLElement;
  private getAISettings: () => AISettings;
  private getAgentAccess: () => AgentAccess;
  private getProjectPath: () => string;
  private onFileChangedCb: ((path: string) => void) | null = null;
  private memory: AgentMemory | null = null;
  private getAppSettings: (() => AppSettings) | null = null;

  private session: ChatSession;
  private sessions: ChatSession[] = [];
  private isStreaming = false;
  private agentAborted = false;
  private abortController: AbortController | null = null;
  private activeCommandProcess: { pid: number; kill: () => Promise<void> } | null = null;
  private activeCommandStopped = false;

  constructor(
    messagesId: string,
    inputId: string,
    sendBtnId: string,
    sessionListId: string,
    getAISettings: () => AISettings,
    getAgentAccess: () => AgentAccess,
    getProjectPath: () => string
  ) {
    this.messagesEl = document.getElementById(messagesId)!;
    this.inputEl = document.getElementById(inputId) as HTMLTextAreaElement;
    this.sendBtn = document.getElementById(sendBtnId)!;
    this.sessionListEl = document.getElementById(sessionListId)!;
    this.getAISettings = getAISettings;
    this.getAgentAccess = getAgentAccess;
    this.getProjectPath = getProjectPath;
    this.session = createSession();

    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    document.getElementById("btn-new-chat")?.addEventListener("click", () => this.newChat());

    // Mode toggle
    this.setupModeToggle();

    // Stop agent button
    this.setupStopButton();

    this.init();
  }

  /** Register callback when agent creates/modifies a file (to refresh file explorer) */
  setOnFileChanged(cb: (path: string) => void) {
    this.onFileChangedCb = cb;
  }

  /** Wire up agent memory for context injection and fact extraction */
  setMemory(memory: AgentMemory, getAppSettings: () => AppSettings) {
    this.memory = memory;
    this.getAppSettings = getAppSettings;
  }

  private onFileChanged(path: string) {
    if (this.onFileChangedCb) this.onFileChangedCb(path);
  }

  // ── Stop Agent ──

  private setupStopButton() {
    const btn = document.getElementById("btn-stop-agent");
    if (!btn) return;
    btn.addEventListener("click", () => this.stopAgent());
  }

  stopAgent() {
    if (this.isStreaming) {
      this.agentAborted = true;
      this.abortController?.abort();
      if (this.activeCommandProcess) {
        this.activeCommandStopped = true;
        void invoke("kill_process_tree", { pid: this.activeCommandProcess.pid }).catch(() =>
          this.activeCommandProcess?.kill().catch(() => {})
        );
      }
    }
  }

  private showStopButton(show: boolean) {
    const btn = document.getElementById("btn-stop-agent");
    if (btn) btn.classList.toggle("hidden", !show);
    // Hide send when stop is shown, show send when stop is hidden
    this.sendBtn.classList.toggle("hidden", show);
  }

  // ── Mode Toggle ──

  private setupModeToggle() {
    const toggle = document.getElementById("chat-mode-toggle");
    if (!toggle) return;

    toggle.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = (btn as HTMLElement).dataset.mode as ChatMode;
        this.setMode(mode);
      });
    });
  }

  setMode(mode: ChatMode) {
    this.session.mode = mode;
    this.updateModeUI();
    this.updatePlaceholder();
    saveSession(this.session);
  }

  private updateModeUI() {
    const toggle = document.getElementById("chat-mode-toggle");
    if (!toggle) return;

    toggle.querySelectorAll(".mode-btn").forEach((btn) => {
      const m = (btn as HTMLElement).dataset.mode;
      btn.classList.toggle("active", m === this.session.mode);
    });

    const banner = document.getElementById("chat-agent-banner");
    if (banner) {
      const dismissed = localStorage.getItem("chat-agent-banner-dismissed") === "1";
      banner.classList.toggle("hidden", this.session.mode !== "agent" || dismissed);

      const closeBtn = document.getElementById("chat-agent-banner-close");
      if (closeBtn && !closeBtn.dataset.listenerAttached) {
        closeBtn.dataset.listenerAttached = "1";
        closeBtn.addEventListener("click", () => {
          localStorage.setItem("chat-agent-banner-dismissed", "1");
          banner.classList.add("hidden");
        });
      }
    }
  }

  private updatePlaceholder() {
    if (this.session.mode === "agent") {
      this.inputEl.placeholder = "Tell the agent what to do...";
    } else {
      this.inputEl.placeholder = "Ask AI...";
    }
  }

  // ── Sessions ──

  private async init() {
    this.sessions = await getAllSessions();
    if (this.sessions.length > 0) {
      this.session = this.sessions[0];
      // Backfill mode for old sessions
      if (!this.session.mode) this.session.mode = "chat";
    }
    this.updateModeUI();
    this.updatePlaceholder();
    this.renderSessionList();
    this.renderMessages();
  }

  async newChat() {
    if (this.session.messages.length > 0) {
      await saveSession(this.session);
    }
    this.session = createSession(this.session.mode);
    this.sessions.unshift(this.session);
    this.renderSessionList();
    this.renderMessages();
    this.updateModeUI();
    this.updatePlaceholder();
    this.inputEl.focus();
  }

  private async switchSession(id: string) {
    if (this.isStreaming) return;
    if (this.session.messages.length > 0) {
      await saveSession(this.session);
    }
    const found = this.sessions.find((s) => s.id === id);
    if (found) {
      this.session = found;
      if (!this.session.mode) this.session.mode = "chat";
      this.renderSessionList();
      this.renderMessages();
      this.updateModeUI();
      this.updatePlaceholder();
    }
  }

  private async removeSession(id: string) {
    if (this.isStreaming) return;
    await deleteSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.session.id === id) {
      if (this.sessions.length > 0) {
        this.session = this.sessions[0];
      } else {
        this.session = createSession();
        this.sessions.push(this.session);
      }
    }
    this.renderSessionList();
    this.renderMessages();
    this.updateModeUI();
    this.updatePlaceholder();
  }

  private renderSessionList() {
    this.sessionListEl.innerHTML = this.sessions
      .map(
        (s) => `
      <div class="chat-session-item ${s.id === this.session.id ? "active" : ""}" data-id="${s.id}">
        <span class="chat-session-title">${this.escapeHtml(s.title)}</span>
        <button class="chat-session-delete" data-delete="${s.id}" title="Delete">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
        </button>
      </div>`
      )
      .join("");

    this.sessionListEl.querySelectorAll(".chat-session-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".chat-session-delete")) return;
        this.switchSession((el as HTMLElement).dataset.id!);
      });
    });

    this.sessionListEl.querySelectorAll(".chat-session-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeSession((btn as HTMLElement).dataset.delete!);
      });
    });
  }

  // ── Messages ──

  private renderMessages() {
    this.messagesEl.innerHTML = "";
    if (this.session.messages.length === 0) {
      if (this.session.mode === "agent") {
        this.addDOMMessage(
          "assistant",
          "I'm Athva Agent. I can read files, run commands, and modify your codebase. Tell me what you'd like to do."
        );
      } else {
        this.addDOMMessage(
          "assistant",
          "Hello! I'm your AI assistant. Ask me anything about your code or project."
        );
      }
      return;
    }
    for (const msg of this.session.messages) {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Render assistant text if any
        if (msg.content) {
          this.addDOMMessage("assistant", msg.content);
        }
        // Render tool calls
        for (const tc of msg.toolCalls) {
          this.renderToolCall(tc);
        }
      } else if (msg.role === "tool") {
        // Skip — tool results are rendered inline with tool calls
      } else {
        this.addDOMMessage(msg.role, msg.content);
      }
    }
    this.scrollToBottom();
  }

  private scrollToBottom() {
    // Use requestAnimationFrame to ensure DOM has updated before scrolling
    requestAnimationFrame(() => {
      this.scrollToBottom();
    });
  }

  private addDOMMessage(role: string, content: string): HTMLElement {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    div.textContent = content;
    this.messagesEl.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  private renderToolCall(tc: ToolCall): HTMLElement {
    const div = document.createElement("div");
    div.className = "chat-tool-call";
    div.dataset.toolId = tc.id;

    const toolLabel = tc.name.replace(/_/g, " ");
    const argsText = Object.entries(tc.args)
      .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 200 ? v.substring(0, 200) + "..." : v}`)
      .join("\n");

    let statusHtml = "";
    if (tc.status === "running") {
      statusHtml = `<span class="tool-status running"><span class="tool-spinner"></span>Running</span>`;
    } else if (tc.status === "done") {
      statusHtml = `<span class="tool-status done">Done</span>`;
    } else if (tc.status === "error") {
      statusHtml = `<span class="tool-status error">Error</span>`;
    } else if (tc.status === "denied") {
      statusHtml = `<span class="tool-status denied">Denied</span>`;
    }

    div.innerHTML = `
      <div class="chat-tool-call-header">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1 0L0 1l2.313 9.014L1 11v3l2.2-1.98L5 14l10-7L1 0zm1.78 6.22L8 3l2 4-4 2-3.22-2.78z"/></svg>
        ${this.escapeHtml(toolLabel)}
        ${statusHtml}
      </div>
      <div class="chat-tool-call-body">${this.escapeHtml(argsText)}</div>
    `;

    // Add approval buttons for pending tool calls
    if (tc.status === "pending") {
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "chat-tool-call-actions";
      actionsDiv.innerHTML = `
        <button class="btn-approve" data-tool-id="${tc.id}">Approve</button>
        <button class="btn-deny" data-tool-id="${tc.id}">Deny</button>
      `;
      div.appendChild(actionsDiv);
    }

    // Add result if available
    if (tc.result && (tc.status === "done" || tc.status === "error")) {
      const resultDiv = document.createElement("div");
      resultDiv.className = `chat-tool-result${tc.status === "error" ? " error" : ""}`;
      resultDiv.textContent = tc.result.length > 2000 ? tc.result.substring(0, 2000) + "\n... (truncated)" : tc.result;
      div.appendChild(resultDiv);
    }

    this.messagesEl.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  // ── Send ──

  private async send() {
    const text = this.inputEl.value.trim();
    if (!text || this.isStreaming) return;

    this.inputEl.value = "";
    this.session.messages.push({ role: "user", content: text });
    this.addDOMMessage("user", text);

    // Auto-title from first user message
    if (this.session.messages.filter((m) => m.role === "user").length === 1) {
      this.session.title = text.length > 40 ? text.substring(0, 40) + "..." : text;
      this.renderSessionList();
    }

    const settings = this.getAISettings();
    if (!settings.apiKey) {
      this.addDOMMessage("error", "No API key configured. Go to Settings to add your API key.");
      return;
    }

    if (this.session.mode === "agent") {
      await this.runAgentLoop(settings);
    } else {
      await this.runChatResponse(settings);
    }
  }

  // ── Chat Mode (simple streaming response) ──

  private async runChatResponse(settings: AISettings) {
    // Fetch relevant memories for system context injection
    const lastUserMsg = [...this.session.messages].reverse().find((m) => m.role === "user")?.content || "";
    const memoryContext = await this.fetchMemoryContext(lastUserMsg);

    const streamEl = this.addDOMMessage("assistant", "");
    streamEl.classList.add("streaming");

    this.isStreaming = true;
    this.sendBtn.setAttribute("disabled", "true");
    this.sendBtn.textContent = "...";

    try {
      const fullResponse = await this.streamAI(settings, this.buildChatHistory(memoryContext), streamEl);
      this.session.messages.push({ role: "assistant", content: fullResponse });
      streamEl.classList.remove("streaming");
      // Background: extract and save memorable facts
      if (fullResponse && lastUserMsg) {
        void this.extractAndSaveMemories(settings, lastUserMsg, fullResponse);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      streamEl.className = "chat-msg error";
      streamEl.textContent = `Error: ${msg}`;
      streamEl.classList.remove("streaming");
    } finally {
      this.isStreaming = false;
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await saveSession(this.session);
    }
  }

  private async fetchMemoryContext(query: string): Promise<string> {
    if (!this.memory || !this.getAppSettings || !query) return "";
    const appSettings = this.getAppSettings();
    if (!appSettings.memory.globalEnabled && !appSettings.memory.projectEnabled) return "";
    try {
      const entries = await this.memory.search(query, 5);
      const relevant = entries.filter((m) => {
        if (m.memory_type === "global" && !appSettings.memory.globalEnabled) return false;
        if (m.memory_type === "project" && !appSettings.memory.projectEnabled) return false;
        return m.score > 0.5;
      });
      if (relevant.length === 0) return "";
      return relevant.map((m) => `- ${m.content}`).join("\n");
    } catch {
      return "";
    }
  }

  private async extractAndSaveMemories(settings: AISettings, userMsg: string, response: string): Promise<void> {
    if (!this.memory || !this.getAppSettings) return;
    const appSettings = this.getAppSettings();
    if (!appSettings.memory.globalEnabled && !appSettings.memory.projectEnabled) return;
    try {
      const prompt =
        `Extract 0-3 short factual statements worth remembering from this conversation exchange.\n` +
        `Only extract genuinely useful facts (user preferences, project decisions, key info).\n` +
        `Output ONLY valid JSON: { "global": string[], "project": string[] }\n` +
        `Use "global" for cross-project facts, "project" for project-specific ones.\n` +
        `If nothing noteworthy, output: { "global": [], "project": [] }\n\n` +
        `User: ${userMsg}\nAssistant: ${response.substring(0, 800)}`;
      const raw = await this.callAIOnce(settings, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const parsed = JSON.parse(jsonMatch[0]) as { global: string[]; project: string[] };
      if (appSettings.memory.globalEnabled) {
        for (const fact of (parsed.global || [])) {
          if (fact.trim()) await this.memory.add(fact.trim(), "global");
        }
      }
      if (appSettings.memory.projectEnabled) {
        for (const fact of (parsed.project || [])) {
          if (fact.trim()) await this.memory.add(fact.trim(), "project");
        }
      }
    } catch {
      // Non-fatal
    }
  }

  private async callAIOnce(settings: AISettings, prompt: string): Promise<string> {
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

  private buildChatHistory(memoryContext = ""): { role: string; content: string }[] {
    const systemContent = memoryContext
      ? `${CHAT_SYSTEM_PROMPT}\n\n[Relevant memories from past sessions]\n${memoryContext}`
      : CHAT_SYSTEM_PROMPT;
    const systemMsg = { role: "system", content: systemContent };
    const msgs = this.session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    return [systemMsg, ...msgs];
  }

  // ── Agent Mode (agentic loop with tool calls) ──

  private async runAgentLoop(settings: AISettings) {
    this.isStreaming = true;
    this.agentAborted = false;
    this.abortController = new AbortController();
    this.showStopButton(true);

    const maxIterations = 10; // Safety limit
    let iterations = 0;

    try {
      while (iterations < maxIterations) {
        if (this.agentAborted) {
          this.addDOMMessage("assistant", "Agent stopped by user.");
          this.session.messages.push({ role: "assistant", content: "Agent stopped by user." });
          break;
        }
        iterations++;

        // Build messages with agent system prompt and tool results
        const history = this.buildAgentHistory();

        // Stream the assistant response
        const streamEl = this.addDOMMessage("assistant", "");
        streamEl.classList.add("streaming");

        let fullResponse: string;
        try {
          fullResponse = await this.streamAI(settings, history, streamEl);
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") {
            streamEl.remove();
            break;
          }
          const msg = e instanceof Error ? e.message : String(e);
          streamEl.className = "chat-msg error";
          streamEl.textContent = `Error: ${msg}`;
          streamEl.classList.remove("streaming");
          break;
        }

        streamEl.classList.remove("streaming");

        // Parse tool calls from the response
        const { text, toolCalls } = this.parseToolCalls(fullResponse);

        if (toolCalls.length === 0) {
          // No tool calls — conversation turn is done
          this.session.messages.push({ role: "assistant", content: fullResponse });
          break;
        }

        // Store the message with tool calls
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: text,
          toolCalls,
        };
        this.session.messages.push(assistantMsg);

        // Update the stream element to only show text part
        if (text.trim()) {
          streamEl.textContent = text;
        } else {
          streamEl.remove();
        }

        // Execute each tool call with approval
        let allDenied = true;
        for (const tc of toolCalls) {
          if (this.agentAborted) {
            tc.status = "denied";
            tc.result = "Agent stopped.";
            break;
          }
          const toolEl = this.renderToolCall(tc);
          const approved = await this.requestApproval(tc, toolEl);

          if (approved) {
            allDenied = false;
            tc.status = "running";
            this.updateToolCallUI(tc);

            try {
              const result = await this.executeTool(tc);
              tc.status = "done";
              tc.result = result;
              // Add tool result to messages for context
              this.session.messages.push({ role: "tool", content: `[${tc.name}] ${result}` });
            } catch (e: unknown) {
              tc.status = "error";
              tc.result = e instanceof Error ? e.message : String(e);
              this.session.messages.push({ role: "tool", content: `[${tc.name} error] ${tc.result}` });
            }
          } else {
            tc.status = "denied";
            tc.result = "User denied this action.";
            this.session.messages.push({ role: "tool", content: `[${tc.name}] Denied by user.` });
          }

          this.updateToolCallUI(tc);
        }

        await saveSession(this.session);

        // If all tool calls were denied, stop the loop
        if (allDenied) break;

        // Otherwise, continue the loop — the AI will see the tool results and decide next steps
      }
    } finally {
      this.isStreaming = false;
      this.agentAborted = false;
      this.abortController = null;
      this.showStopButton(false);
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await saveSession(this.session);
      this.scrollToBottom();
    }
  }

  private buildAgentHistory(): { role: string; content: string }[] {
    const access = this.getAgentAccess();
    const projectPath = this.getProjectPath();
    const systemPrompt = buildAgentSystemPrompt(projectPath, access);
    const systemMsg = { role: "system", content: systemPrompt };

    const msgs: { role: string; content: string }[] = [];
    for (const m of this.session.messages) {
      if (m.role === "user") {
        msgs.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        // Include the full response (with tool call syntax) for context
        let content = m.content;
        if (m.toolCalls && m.toolCalls.length > 0) {
          const toolBlock = m.toolCalls
            .map((tc) => JSON.stringify({ tool: tc.name, args: tc.args }))
            .join("\n");
          content += (content ? "\n" : "") + "```tool\n" + toolBlock + "\n```";
        }
        msgs.push({ role: "assistant", content });
      } else if (m.role === "tool") {
        // Tool results go as user messages (for models that don't support tool role)
        msgs.push({ role: "user", content: m.content });
      }
    }

    return [systemMsg, ...msgs];
  }

  // ── Tool Call Parsing ──

  private parseToolCalls(response: string): { text: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = [];
    let text = response;

    // Match ```tool blocks — handle variations: ```tool, ``` tool, with or without closing ```
    // Also handle cases where the closing ``` may have trailing whitespace or be missing
    const toolBlockRegex = /```\s*tool\s*\n([\s\S]*?)(?:```|$)/g;
    let match: RegExpExecArray | null;

    while ((match = toolBlockRegex.exec(response)) !== null) {
      const block = match[1].trim();
      text = text.replace(match[0], "").trim();

      // Try to extract JSON objects from the block
      // The block may contain one JSON per line, or multi-line JSON objects
      const extracted = this.extractToolJsonObjects(block);
      for (const parsed of extracted) {
        if (parsed.tool && parsed.args) {
          toolCalls.push({
            id: crypto.randomUUID(),
            name: parsed.tool,
            args: parsed.args,
            status: "pending",
          });
        }
      }
    }

    // Fallback: also look for bare {"tool": ...} JSON objects outside code blocks
    // Some models don't wrap them in ```tool blocks
    if (toolCalls.length === 0) {
      const bareJsonRegex = /\{"tool"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
      let bareMatch: RegExpExecArray | null;
      while ((bareMatch = bareJsonRegex.exec(response)) !== null) {
        try {
          const parsed = JSON.parse(bareMatch[0]);
          if (parsed.tool && parsed.args) {
            toolCalls.push({
              id: crypto.randomUUID(),
              name: parsed.tool,
              args: parsed.args,
              status: "pending",
            });
            text = text.replace(bareMatch[0], "").trim();
          }
        } catch {
          // Skip malformed
        }
      }
    }

    return { text, toolCalls };
  }

  /** Extract valid JSON objects with "tool" and "args" from a block of text */
  private extractToolJsonObjects(block: string): { tool: string; args: Record<string, string> }[] {
    const results: { tool: string; args: Record<string, string> }[] = [];

    // Strategy 1: Try each line as a standalone JSON
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.tool && parsed.args) {
          results.push(parsed);
        }
      } catch {
        // Not a single-line JSON, skip
      }
    }

    if (results.length > 0) return results;

    // Strategy 2: Try the entire block as one JSON object
    try {
      const parsed = JSON.parse(block);
      if (parsed.tool && parsed.args) {
        return [parsed];
      }
    } catch {
      // Not a single JSON
    }

    // Strategy 3: Find JSON objects by brace matching
    let depth = 0;
    let start = -1;
    for (let i = 0; i < block.length; i++) {
      if (block[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (block[i] === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = block.substring(start, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed.tool && parsed.args) {
              results.push(parsed);
            }
          } catch {
            // Skip
          }
          start = -1;
        }
      }
    }

    return results;
  }

  // ── Tool Approval Flow ──

  private requestApproval(tc: ToolCall, toolEl: HTMLElement): Promise<boolean> {
    return new Promise((resolve) => {
      const approveBtn = toolEl.querySelector(`.btn-approve[data-tool-id="${tc.id}"]`);
      const denyBtn = toolEl.querySelector(`.btn-deny[data-tool-id="${tc.id}"]`);

      if (!approveBtn || !denyBtn) {
        resolve(false);
        return;
      }

      const cleanup = () => {
        approveBtn.removeEventListener("click", onApprove);
        denyBtn.removeEventListener("click", onDeny);
        const actionsEl = toolEl.querySelector(".chat-tool-call-actions");
        if (actionsEl) actionsEl.remove();
      };

      const onApprove = () => {
        cleanup();
        resolve(true);
      };

      const onDeny = () => {
        cleanup();
        resolve(false);
      };

      approveBtn.addEventListener("click", onApprove);
      denyBtn.addEventListener("click", onDeny);
    });
  }

  private updateToolCallUI(tc: ToolCall) {
    const el = this.messagesEl.querySelector(`[data-tool-id="${tc.id}"]`);
    if (!el) return;

    // Update status badge
    const header = el.querySelector(".chat-tool-call-header");
    if (header) {
      const existingStatus = header.querySelector(".tool-status");
      if (existingStatus) existingStatus.remove();
      const spinner = header.querySelector(".tool-spinner");
      if (spinner) spinner.remove();

      let statusHtml = "";
      if (tc.status === "running") {
        statusHtml = `<span class="tool-status running"><span class="tool-spinner"></span>Running</span>`;
      } else if (tc.status === "done") {
        statusHtml = `<span class="tool-status done">Done</span>`;
      } else if (tc.status === "error") {
        statusHtml = `<span class="tool-status error">Error</span>`;
      } else if (tc.status === "denied") {
        statusHtml = `<span class="tool-status denied">Denied</span>`;
      }
      header.insertAdjacentHTML("beforeend", statusHtml);
    }

    // Add result
    if (tc.result && (tc.status === "done" || tc.status === "error")) {
      const existing = el.querySelector(".chat-tool-result");
      if (!existing) {
        const resultDiv = document.createElement("div");
        resultDiv.className = `chat-tool-result${tc.status === "error" ? " error" : ""}`;
        resultDiv.textContent =
          tc.result.length > 2000 ? tc.result.substring(0, 2000) + "\n... (truncated)" : tc.result;
        el.appendChild(resultDiv);
      }
    }

    this.scrollToBottom();
  }

  // ── Blocked paths ──

  private static BLOCKED_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__", ".next", ".nuxt", "coverage", ".cache"];
  private static BLOCKED_FILES = [
    ".env", ".env.local", ".env.production", ".env.development",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    ".gitignore", ".DS_Store", "Thumbs.db",
  ];

  private isBlockedPath(filePath: string): boolean {
    const parts = filePath.split("/");
    const fileName = parts[parts.length - 1];
    // Block if any directory segment is in blocked list
    if (parts.some((p) => Chatbot.BLOCKED_DIRS.includes(p))) return true;
    // Block specific filenames
    if (Chatbot.BLOCKED_FILES.includes(fileName)) return true;
    // Block lock files and binary-ish extensions
    if (/\.(lock|lockb|log|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|mp[34]|zip|tar|gz)$/i.test(fileName)) return true;
    return false;
  }

  // ── Tool Execution via Tauri ──

  private async executeTool(tc: ToolCall): Promise<string> {
    const access = this.getAgentAccess();

    switch (tc.name) {
      case "read_file": {
        if (!access.fileRead) throw new Error("File read permission denied");
        if (this.isBlockedPath(tc.args.path)) throw new Error(`Blocked: reading "${tc.args.path}" is not allowed (heavy, sensitive, or binary file)`);
        const content = await invoke<string>("read_file", { path: tc.args.path });
        if (content.trim().length === 0) {
          return "(empty or whitespace-only file)";
        }
        // Truncate very large files to avoid blowing up context
        if (content.length > 50000) {
          return content.substring(0, 50000) + "\n\n... (truncated — file too large, showing first 50k chars)";
        }
        return content;
      }

      case "write_file": {
        if (!access.fileWrite) throw new Error("File write permission denied");
        await invoke("write_file", { path: tc.args.path, content: tc.args.content });
        this.onFileChanged(tc.args.path);
        return `File written: ${tc.args.path}`;
      }

      case "list_dir": {
        if (!access.fileRead) throw new Error("File read permission denied");
        const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>("read_dir", {
          path: tc.args.path,
        });
        // Filter out blocked directories from listing
        const filtered = entries.filter((e) => {
          if (e.is_dir && Chatbot.BLOCKED_DIRS.includes(e.name)) return false;
          if (!e.is_dir && Chatbot.BLOCKED_FILES.includes(e.name)) return false;
          return true;
        });
        return filtered.map((e) => `${e.is_dir ? "[dir] " : "      "}${e.name}`).join("\n");
      }

      case "run_command": {
        if (!access.terminal) throw new Error("Terminal access permission denied");
        const projectPath = this.getProjectPath();
        // Use Tauri shell plugin to run commands
        const result = await this.runShellCommand(tc.args.command, projectPath);
        return result;
      }

      case "search_files": {
        if (!access.fileRead) throw new Error("File read permission denied");
        const projectPath = this.getProjectPath();
        const files = await invoke<{ name: string; path: string; is_dir: boolean }[]>("search_files", {
          root: projectPath,
          query: tc.args.query,
          maxResults: 50,
        });
        if (files.length === 0) return "No files found.";
        return files.map((f) => f.path).join("\n");
      }

      case "make_plan": {
        const title = (tc.args.title || "").trim();
        const notes = (tc.args.notes || "").trim();
        const steps = (tc.args.steps || "")
          .split("\n")
          .map((step) => step.trim())
          .filter(Boolean);

        if (!title) throw new Error("Plan title is required");
        if (steps.length === 0) throw new Error("At least one plan step is required");

        const lines = [`Plan: ${title}`];
        for (let i = 0; i < steps.length; i++) {
          lines.push(`${i + 1}. ${steps[i]}`);
        }
        if (notes) {
          lines.push("");
          lines.push(`Notes: ${notes}`);
        }
        return lines.join("\n");
      }

      default:
        throw new Error(`Unknown tool: ${tc.name}`);
    }
  }

  private async runShellCommand(command: string, cwd: string): Promise<string> {
    try {
      const { Command } = await import("@tauri-apps/plugin-shell");
      // Use a login shell so the full user PATH is loaded (pnpm, npm, node, etc.)
      const cmd = Command.create("zsh", ["-l", "-c", command], { cwd });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      cmd.stdout.on("data", (data: string) => {
        stdoutChunks.push(data);
      });
      cmd.stderr.on("data", (data: string) => {
        stderrChunks.push(data);
      });

      return await new Promise<string>(async (resolve, reject) => {
        cmd.on("close", (payload: { code: number | null }) => {
          const stdout = stdoutChunks.join("").trim();
          const stderr = stderrChunks.join("").trim();
          const wasStopped = this.activeCommandStopped;

          this.activeCommandProcess = null;
          this.activeCommandStopped = false;

          if (wasStopped || this.agentAborted) {
            reject(new Error("Command stopped by user."));
            return;
          }

          if (payload.code !== 0 && payload.code !== null) {
            resolve(`Exit code ${payload.code}\n${stderr || stdout}`);
            return;
          }

          resolve(stdout || stderr || "(no output)");
        });

        cmd.on("error", (err: string) => {
          this.activeCommandProcess = null;
          const wasStopped = this.activeCommandStopped;
          this.activeCommandStopped = false;
          if (wasStopped || this.agentAborted) {
            reject(new Error("Command stopped by user."));
            return;
          }
          reject(new Error(err));
        });

        try {
          const child = await cmd.spawn();
          this.activeCommandStopped = false;
          this.activeCommandProcess = child;

          if (this.agentAborted) {
            this.activeCommandStopped = true;
            await invoke("kill_process_tree", { pid: child.pid }).catch(() => child.kill());
          }
        } catch (e: unknown) {
          this.activeCommandProcess = null;
          this.activeCommandStopped = false;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    } catch (e: unknown) {
      throw new Error(`Shell execution failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Streaming API calls ──

  private async streamAI(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    switch (settings.provider) {
      case "openai":
        return this.streamOpenAI(settings, messages, el);
      case "anthropic":
        return this.streamAnthropic(settings, messages, el);
      case "google":
        return this.callGoogleNonStream(settings, messages, el);
      case "mimo":
        return this.streamMiMo(settings, messages, el);
      case "mistral":
        return this.streamMistral(settings, messages, el);
      default:
        throw new Error(`Unknown provider: ${settings.provider}`);
    }
  }

  // ── OpenAI streaming ──
  private async streamOpenAI(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "gpt-4o";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Anthropic streaming ──
  private async streamAnthropic(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
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
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      if (json.type === "content_block_delta") {
        return json.delta?.text || "";
      }
      return "";
    });
  }

  // ── MiMo streaming (OpenAI-compatible SSE) ──
  private async streamMiMo(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
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
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`MiMo API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Mistral streaming (OpenAI-compatible SSE) ──
  private async streamMistral(
    settings: AISettings,
    messages: { role: string; content: string }[],
    el: HTMLElement
  ): Promise<string> {
    const model = settings.model || "mistral-small-latest";
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096, stream: true }),
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Mistral API error ${res.status}: ${err}`);
    }

    return this.readSSEStream(res, el, (json) => {
      return json.choices?.[0]?.delta?.content || "";
    });
  }

  // ── Google (no SSE, falls back to non-stream with simulated typing) ──
  private async callGoogleNonStream(
    settings: AISettings,
    history: { role: string; content: string }[],
    el: HTMLElement
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
        signal: this.abortController?.signal,
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";

    await this.simulateStream(fullText, el);
    return fullText;
  }

  // ── SSE stream reader (works for OpenAI, Anthropic, MiMo, Mistral) ──
  private async readSSEStream(
    res: Response,
    el: HTMLElement,
    extractContent: (json: any) => string
  ): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      if (this.agentAborted) {
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
            this.scrollToBottom();
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    return fullText;
  }

  // ── Simulated streaming for non-SSE providers ──
  private simulateStream(text: string, el: HTMLElement): Promise<void> {
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (this.agentAborted) { resolve(); return; }
        const chunkSize = Math.min(2 + Math.floor(Math.random() * 3), text.length - i);
        i += chunkSize;
        el.textContent = text.substring(0, i);
        this.scrollToBottom();
        if (i < text.length) {
          requestAnimationFrame(step);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
