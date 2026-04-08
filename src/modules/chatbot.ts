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
  getSessionsByProject,
  deleteSession,
} from "./chat-store";
import { streamAI, callAIOnce, type StreamContext } from "./chat-streaming";
import { parseToolCalls } from "./chat-tool-parser";
import { executeTool, compressToolResult, type ToolExecContext } from "./chat-tool-executor";

// ── Agent tool definitions for LLM function calling ──

const AGENT_TOOLS = [
  { name: "read_file", description: "Read a file", parameters: { path: "string" } },
  { name: "batch_read", description: "Read multiple files (2-8). Preferred over read_file.", parameters: { paths: "string — newline-separated paths" } },
  { name: "write_file", description: "Write/create a file", parameters: { path: "string", content: "string" } },
  { name: "list_dir", description: "List directory contents", parameters: { path: "string" } },
  { name: "run_command", description: "Run shell command in project dir", parameters: { command: "string" } },
  { name: "search_files", description: "Find files by name/path", parameters: { query: "string" } },
  { name: "search_content", description: "Grep: search inside files", parameters: { pattern: "string — regex", glob: "string — optional file filter e.g. '*.ts'" } },
  { name: "git_diff", description: "Show git diff", parameters: { target: "string — optional file/branch/commit" } },
  { name: "make_plan", description: "Plan before multi-step work (mandatory)", parameters: { title: "string", steps: "string — newline-separated", notes: "string — optional" } },
  {
    name: "ask_user",
    description: "Ask user questions. Batch ALL into one call.",
    parameters: {
      questions: "string — JSON array: [{\"q\":\"text\",\"type\":\"select|checkbox|text\",\"options\":[...]}]",
      question: "string — single question shorthand",
      type: "string — select|checkbox|text",
      options: "string — newline-separated options",
    },
  },
];

// ── System prompts ──

const CHAT_SYSTEM_PROMPT = `You are Athva, a helpful AI coding assistant. You help users understand code, answer programming questions, and provide suggestions. Be concise and precise in your responses.`;

const MAX_PROJECT_CONTEXT_CHARS = 2200;
const MAX_COMPACTED_SUMMARY_CHARS = 1800;
const AGENT_COMPACT_THRESHOLD_TOKENS = 4000;
const AGENT_KEEP_RECENT_MESSAGES = 4;

function capText(value: string, limit: number, suffix = "\n…[truncated]"): string {
  return value.length > limit ? value.substring(0, limit) + suffix : value;
}

function capProjectContext(projectContext: string): string {
  return capText(projectContext.trim(), MAX_PROJECT_CONTEXT_CHARS, "\n…[project context truncated]");
}

function buildAgentSystemPrompt(projectPath: string, access: AgentAccess, projectContext = ""): string {
  const tools = AGENT_TOOLS.filter((t) => {
    if (t.name === "read_file" || t.name === "batch_read" || t.name === "list_dir" || t.name === "search_files" || t.name === "search_content") return access.fileRead;
    if (t.name === "write_file") return access.fileWrite;
    if (t.name === "run_command") return access.terminal;
    if (t.name === "git_diff") return access.fileRead;
    if (t.name === "make_plan") return true;
    if (t.name === "ask_user") return true;
    return false;
  });

  const toolDescriptions = tools
    .map((t) => `- ${t.name}(${Object.keys(t.parameters).join(", ")}): ${t.description}`)
    .join("\n");

  const contextSection = projectContext
    ? `\n[Project Context]\n${capProjectContext(projectContext)}\n`
    : "";

  return `You are Athva Agent. Project: ${projectPath}
${contextSection}
Tools: ${toolDescriptions || "(none)"}

Format: \`\`\`tool
{"tool":"<name>","args":{...}}
\`\`\` (one per response, \\n for newlines in strings)

Protocol: Plan→Batch→Execute→Output
- make_plan FIRST for 2+ step tasks
- batch_read for 2+ files, search_content for symbols — avoid full reads
- git_diff before reading changed files
- ask_user: batch ALL questions in one call via "questions" param
- One tool per response. Read before modifying.
- Max 5-8 files, ~30KB context. Stop at 80% confidence.
- Output: result + minimal explanation + diffs only
- Git: ask user first, no git add ., no force push
- run_command over write_file for scaffolding
- Skip .env, locks, node_modules, dist, .git
- Be concise. No restating requests. No intermediate dumps.
- Persist knowledge to \`${projectPath}/.athva/context.md\``;
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
  private projectContext: string = "";
  private sessionContextMenu: HTMLElement;
  private currentProjectPath: string = "";

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

    // Session context menu (right-click)
    this.sessionContextMenu = document.createElement("div");
    this.sessionContextMenu.className = "context-menu hidden";
    document.body.appendChild(this.sessionContextMenu);
    document.addEventListener("click", () => this.sessionContextMenu.classList.add("hidden"));
    document.addEventListener("contextmenu", (e) => {
      if (!this.sessionContextMenu.contains(e.target as Node)) {
        this.sessionContextMenu.classList.add("hidden");
      }
    });

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

    // Cmd/Ctrl + click to open links in chat messages
    this.messagesEl.addEventListener("click", (e) => {
      const anchor = (e.target as HTMLElement).closest("a.chat-link") as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(anchor.href)).catch(() => {});
      }
    });
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

  /** Load .athva/context.md from the project root and inject into system prompts.
   *  Auto-creates the file if it doesn't exist so the agent can persist knowledge from the start. */
  async setProjectPath(projectPath: string) {
    if (!projectPath) { this.projectContext = ""; return; }

    // Reload sessions scoped to new project
    if (this.currentProjectPath !== projectPath) {
      if (this.session.messages.length > 0) {
        await saveSession(this.session);
      }
      this.currentProjectPath = projectPath;
      await this.loadSessionsForProject();
    }

    const contextPath = `${projectPath}/.athva/context.md`;
    try {
      const content = await invoke<string>("read_file", { path: contextPath });
      this.projectContext = content || "";
    } catch {
      // File doesn't exist yet — create it with a starter template so agent can persist knowledge
      try {
        const starter = `# Project Context — ${projectPath.split("/").pop() || "project"}\n\nThis file is auto-managed by Athva Agent. It stores project knowledge across sessions.\n`;
        await invoke("write_file", { path: contextPath, content: starter });
        this.projectContext = starter;
      } catch {
        this.projectContext = "";
      }
    }
  }

  /** Open the manual context editor modal */
  openContextEditor() {
    const modal = document.getElementById("context-modal");
    const textarea = document.getElementById("context-editor-textarea") as HTMLTextAreaElement;
    if (!modal || !textarea) return;

    textarea.value = this.projectContext;
    modal.classList.remove("hidden");
    textarea.focus();

    const close = () => modal.classList.add("hidden");

    const saveBtn = document.getElementById("btn-save-context");
    const cancelBtn = document.getElementById("btn-cancel-context");

    // Remove old listeners by replacing elements
    const newSave = saveBtn!.cloneNode(true) as HTMLElement;
    const newCancel = cancelBtn!.cloneNode(true) as HTMLElement;
    saveBtn!.replaceWith(newSave);
    cancelBtn!.replaceWith(newCancel);

    newSave.addEventListener("click", async () => {
      newSave.textContent = "Saving...";
      (newSave as HTMLButtonElement).disabled = true;
      await this.saveContext(textarea.value);
      close();
    });
    newCancel.addEventListener("click", close);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    }, { once: true });
  }

  private async saveContext(content: string) {
    const projectPath = this.getProjectPath();
    if (!projectPath) return;
    try {
      // Ensure .athva/ directory exists by writing the file (write_file creates parent dirs on Rust side)
      const contextPath = `${projectPath}/.athva/context.md`;
      await invoke("write_file", { path: contextPath, content });
      this.projectContext = content;
    } catch (e) {
      console.error("Failed to save context:", e);
    }
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
      this.inputEl.placeholder = "Tell the agent what to do…";
    } else {
      this.inputEl.placeholder = "Ask anything about your code…";
    }
  }

  // ── Sessions ──

  private async init() {
    await this.loadSessionsForProject();
  }

  private async loadSessionsForProject() {
    if (this.currentProjectPath) {
      this.sessions = await getSessionsByProject(this.currentProjectPath);
    } else {
      this.sessions = await getAllSessions();
    }
    if (this.sessions.length > 0) {
      this.session = this.sessions[0];
      // Backfill mode for old sessions
      if (!this.session.mode) this.session.mode = "chat";
    } else {
      this.session = createSession("chat", this.currentProjectPath);
      this.sessions.push(this.session);
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
    this.session = createSession(this.session.mode, this.currentProjectPath);
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
        this.session = createSession("chat", this.currentProjectPath);
        this.sessions.push(this.session);
      }
    }
    this.renderSessionList();
    this.renderMessages();
    this.updateModeUI();
    this.updatePlaceholder();
  }

  private async closeOtherSessions(keepId: string) {
    if (this.isStreaming) return;
    const toDelete = this.sessions.filter((s) => s.id !== keepId);
    for (const s of toDelete) {
      await deleteSession(s.id);
    }
    this.sessions = this.sessions.filter((s) => s.id === keepId);
    if (this.session.id !== keepId) {
      this.session = this.sessions[0];
    }
    this.renderSessionList();
    this.renderMessages();
    this.updateModeUI();
    this.updatePlaceholder();
  }

  private async closeAllSessions() {
    if (this.isStreaming) return;
    for (const s of this.sessions) {
      await deleteSession(s.id);
    }
    this.sessions = [];
    this.session = createSession("chat", this.currentProjectPath);
    this.sessions.push(this.session);
    this.renderSessionList();
    this.renderMessages();
    this.updateModeUI();
    this.updatePlaceholder();
  }

  private showSessionContextMenu(e: MouseEvent, id: string) {
    this.sessionContextMenu.innerHTML = "";

    const items: { label?: string; action?: () => void; separator?: boolean }[] = [
      { label: "Close Others", action: () => this.closeOtherSessions(id) },
      { label: "Close All", action: () => this.closeAllSessions() },
    ];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        this.sessionContextMenu.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.textContent = item.label!;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.sessionContextMenu.classList.add("hidden");
        item.action?.();
      });
      this.sessionContextMenu.appendChild(row);
    }

    this.sessionContextMenu.classList.remove("hidden");
    this.sessionContextMenu.style.left = `${e.clientX}px`;
    this.sessionContextMenu.style.top = `${e.clientY}px`;

    requestAnimationFrame(() => {
      const rect = this.sessionContextMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.sessionContextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        this.sessionContextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
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
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = (el as HTMLElement).dataset.id!;
        this.showSessionContextMenu(e as MouseEvent, id);
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
      const isAgent = this.session.mode === "agent";
      const chips = isAgent
        ? ["Explain this codebase", "Find all TODO comments", "Refactor this file", "Run the tests"]
        : ["Explain this code", "Fix the bug", "Add TypeScript types", "Write unit tests"];

      const welcome = document.createElement("div");
      welcome.className = "chat-welcome";
      welcome.innerHTML = `
        <div class="chat-welcome-icon">
          <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936zM3.794 1.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.58.926 1.097 1.098l1.163.387a.217.217 0 0 1 0 .412l-1.163.387A1.734 1.734 0 0 0 4.593 5.69l-.387 1.162a.217.217 0 0 1-.412 0L3.407 5.69a1.734 1.734 0 0 0-1.097-1.098L1.147 4.207a.217.217 0 0 1 0-.412l1.163-.387a1.734 1.734 0 0 0 1.097-1.098l.387-1.162z"/>
          </svg>
        </div>
        <p class="chat-welcome-title">${isAgent ? "Athva Agent" : "Athva AI"}</p>
        <p class="chat-welcome-sub">${isAgent ? "I can read, edit files & run commands in your project." : "Ask anything about your code or project."}</p>
        <div class="chat-welcome-chips">
          ${chips.map(c => `<button class="chat-chip" type="button">${c}</button>`).join("")}
        </div>
      `;

      welcome.querySelectorAll(".chat-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          this.inputEl.value = (btn as HTMLElement).textContent || "";
          this.inputEl.focus();
        });
      });

      this.messagesEl.appendChild(welcome);
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
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private addDOMMessage(role: string, content: string): HTMLElement {
    const div = document.createElement("div");
    div.className = `chat-msg ${role}`;
    this.setLinkedText(div, content);
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
      this.setLinkedText(resultDiv, tc.result.length > 2000 ? tc.result.substring(0, 2000) + "\n... (truncated)" : tc.result);
      div.appendChild(resultDiv);
    }

    this.messagesEl.appendChild(div);
    this.scrollToBottom();
    return div;
  }

  // ── Send ──

  async sendExternal(text: string, mode: ChatMode = "chat") {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    if (mode !== this.session.mode) {
      if (this.session.messages.length > 0) {
        await saveSession(this.session);
        this.session = createSession(mode);
        this.sessions.unshift(this.session);
      } else {
        this.session.mode = mode;
      }

      this.renderSessionList();
      this.renderMessages();
      this.updateModeUI();
      this.updatePlaceholder();
    }

    this.inputEl.value = trimmed;
    await this.send();
  }

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
      const fullResponse = await streamAI(settings, this.buildChatHistory(memoryContext), streamEl, this.streamCtx());
      this.session.messages.push({ role: "assistant", content: fullResponse });
      streamEl.classList.remove("streaming");
      // Background: extract and save memorable facts (only if memory is enabled)
      if (fullResponse && lastUserMsg) {
        void this.extractAndSaveMemories(settings, lastUserMsg, fullResponse);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      streamEl.className = "chat-msg error";
      this.setLinkedText(streamEl, `Error: ${msg}`);
      streamEl.classList.remove("streaming");
    } finally {
      this.isStreaming = false;
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await saveSession(this.session);
      void this.compactHistory(settings);
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
      const raw = await callAIOnce(settings, prompt);
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

  // ── Auto-compact ──

  private estimateSessionTokens(): number {
    let totalChars = 0;
    for (const m of this.session.messages) {
      totalChars += m.content.length;
      // Include tool call args in the estimate — write_file args contain full file content
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          for (const v of Object.values(tc.args)) {
            totalChars += String(v).length;
          }
          if (tc.result) totalChars += tc.result.length;
        }
      }
    }
    return Math.ceil(totalChars / 4);
  }

  private async compactHistory(settings: AISettings): Promise<void> {
    if (this.estimateSessionTokens() < AGENT_COMPACT_THRESHOLD_TOKENS) return;

    const keepCount = AGENT_KEEP_RECENT_MESSAGES;
    const toSummarize = this.session.messages.slice(0, -keepCount);
    if (toSummarize.length < 4) return; // Not enough to compress

    const historyText = toSummarize
      .map((m) => `${m.role.toUpperCase()}: ${capText(m.content, 220, "…")}`)
      .join("\n");

    const prompt =
      `Create a rolling compact summary in under 180 words.\n` +
      `Keep only: current user goal, files changed, decisions made, unresolved blockers, next step.\n` +
      `Do not include raw file contents, long command output, or repeated history.\n\n` +
      `${this.session.compactedSummary ? `Previous summary:\n${capText(this.session.compactedSummary, 900, "…")}\n\n` : ""}` +
      `Recent conversation to merge:\n${historyText}`;

    const summary = await callAIOnce(settings, prompt);
    if (!summary) return;

    this.session.compactedSummary = capText(summary.trim(), MAX_COMPACTED_SUMMARY_CHARS, "\n…[summary truncated]");
    this.session.messages = this.session.messages.slice(-keepCount);
    await saveSession(this.session);

    // Show compact indicator in UI
    const indicator = document.createElement("div");
    indicator.className = "chat-compact-indicator";
    indicator.textContent = "⟳ History compacted to save tokens";
    this.messagesEl.prepend(indicator);
  }



  private buildChatHistory(memoryContext = ""): { role: string; content: string }[] {
    let systemContent = CHAT_SYSTEM_PROMPT;
    if (this.projectContext) {
      systemContent += `\n\n[Project Context]\n${capProjectContext(this.projectContext)}`;
    }
    if (memoryContext) {
      systemContent += `\n\n[Relevant memories from past sessions]\n${capText(memoryContext, 1200, "\n…[memory truncated]")}`;
    }
    const systemMsg = { role: "system", content: systemContent };

    const msgs: { role: string; content: string }[] = [];

    // Prepend compacted summary when history was previously compacted
    if (this.session.compactedSummary) {
      msgs.push({
        role: "user",
        content: `[Conversation summary from earlier]\n${capText(this.session.compactedSummary, MAX_COMPACTED_SUMMARY_CHARS, "\n…[summary truncated]")}`,
      });
    }

    const recent = this.session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    return [systemMsg, ...msgs, ...recent];
  }

  // ── Agent Mode (agentic loop with tool calls) ──

  private async runAgentLoop(settings: AISettings) {
    this.isStreaming = true;
    this.agentAborted = false;
    this.abortController = new AbortController();
    this.showStopButton(true);

    const maxIterations = 25; // Safety limit — supports multi-step tasks
    let iterations = 0;

    try {
      while (iterations < maxIterations) {
        if (this.agentAborted) {
          this.addDOMMessage("assistant", "Agent stopped by user.");
          this.session.messages.push({ role: "assistant", content: "Agent stopped by user." });
          break;
        }
        iterations++;

        if (this.estimateSessionTokens() >= AGENT_COMPACT_THRESHOLD_TOKENS) {
          await this.compactHistory(settings);
        }

        // Warn agent when running low on turns so it can wrap up
        if (iterations === maxIterations - 2) {
          this.session.messages.push({
            role: "tool",
            content: "[system] WARNING: 2 turns remaining. Wrap up now — summarize what's done and what's left.",
          });
        }

        // Build messages with agent system prompt and tool results
        const history = this.buildAgentHistory();

        // Stream the assistant response
        const streamEl = this.addDOMMessage("assistant", "");
        streamEl.classList.add("streaming");

        let fullResponse: string;
        try {
          fullResponse = await streamAI(settings, history, streamEl, this.streamCtx());
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") {
            streamEl.remove();
            break;
          }
          const msg = e instanceof Error ? e.message : String(e);
          streamEl.className = "chat-msg error";
          this.setLinkedText(streamEl, `Error: ${msg}`);
          streamEl.classList.remove("streaming");
          break;
        }

        streamEl.classList.remove("streaming");

        // Parse tool calls from the response
        const { text, toolCalls } = parseToolCalls(fullResponse);

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
          this.setLinkedText(streamEl, text);
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

          // ask_user is special — render form, wait for answer, no approve/deny
          if (tc.name === "ask_user") {
            allDenied = false;
            const answer = await this.renderAskUser(tc);
            tc.status = "done";
            tc.result = answer;
            // Cap answer in history — user answers are usually short but just in case
            const cappedAnswer = answer.length > 1500 ? answer.substring(0, 1500) + "…" : answer;
            this.session.messages.push({ role: "tool", content: `[ask_user] User answered:\n${cappedAnswer}` });
            continue;
          }

          const toolEl = this.renderToolCall(tc);
          const approved = await this.requestApproval(tc, toolEl);

          if (approved) {
            allDenied = false;
            tc.status = "running";
            this.updateToolCallUI(tc);

            try {
              const result = await executeTool(tc, this.toolExecCtx());
              tc.status = "done";
              tc.result = result;
              // Compress tool result before adding to history to reduce token usage
              const compressed = compressToolResult(tc.name, result);
              this.session.messages.push({ role: "tool", content: compressed });
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

        // Mid-loop compaction: every 5 turns, compact history to keep tokens low
        if (iterations % 3 === 0) {
          await this.compactHistory(settings);
        }

        // Otherwise, continue the loop — the AI will see the tool results and decide next steps
      }

      // If loop exhausted, notify user
      if (iterations >= maxIterations && !this.agentAborted) {
        const exhaustedMsg = `Agent reached the ${maxIterations}-turn limit. Some work may be incomplete — you can send a follow-up message to continue.`;
        this.addDOMMessage("assistant", exhaustedMsg);
        this.session.messages.push({ role: "assistant", content: exhaustedMsg });
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
      void this.compactHistory(settings);
    }
  }

  private buildAgentHistory(): { role: string; content: string }[] {
    const access = this.getAgentAccess();
    const projectPath = this.getProjectPath();
    const systemPrompt = buildAgentSystemPrompt(projectPath, access, this.projectContext);
    const systemMsg = { role: "system", content: systemPrompt };

    // Keep the last N messages — lower = less tokens per API call
    const MAX_HISTORY = 8;
    const recentMessages = this.session.messages.slice(-MAX_HISTORY);

    const msgs: { role: string; content: string }[] = [];

    // Prepend compacted summary when history was previously compacted
    if (this.session.compactedSummary) {
      msgs.push({
        role: "user",
        content: `[Earlier context]\n${capText(this.session.compactedSummary, MAX_COMPACTED_SUMMARY_CHARS, "\n…[summary truncated]")}`,
      });
    }

    for (const m of recentMessages) {
      if (m.role === "user") {
        const userContent = capText(m.content, 1800, "\n…[user message truncated]");
        msgs.push({ role: "user", content: userContent });
      } else if (m.role === "assistant") {
        let content = capText(m.content, 1600, "\n…[assistant message truncated]");
        if (m.toolCalls && m.toolCalls.length > 0) {
          // Only include tool name + key args, not full args (write_file content is huge)
          const toolBlock = m.toolCalls
            .map((tc) => {
              const compactArgs: Record<string, string> = {};
              for (const [k, v] of Object.entries(tc.args)) {
                const val = String(v);
                // Truncate large arg values (e.g. file content in write_file)
                compactArgs[k] = capText(val, 120, "…");
              }
              return JSON.stringify({ tool: tc.name, args: compactArgs });
            })
            .join("\n");
          content += (content ? "\n" : "") + "```tool\n" + toolBlock + "\n```";
        }
        msgs.push({ role: "assistant", content });
      } else if (m.role === "tool") {
        // Aggressively limit tool results in history — they're already compressed on entry.
        // Recent results get slightly more space; older ones get minimal.
        const msgIndex = recentMessages.indexOf(m);
        const isRecent = msgIndex >= recentMessages.length - 4; // last 4 msgs
        const TOOL_HISTORY_LIMIT = isRecent ? 900 : 320;
        const content = capText(m.content, TOOL_HISTORY_LIMIT, `\n…[${Math.max(0, m.content.length - TOOL_HISTORY_LIMIT)} chars omitted]`);
        msgs.push({ role: "user", content });
      }
    }

    return [systemMsg, ...msgs];
  }

  // Tool call parsing is now in chat-tool-parser.ts

  // ── Tool Approval Flow ──

  private requestApproval(tc: ToolCall, toolEl: HTMLElement): Promise<boolean> {
    return new Promise((resolve) => {
      const access = this.getAgentAccess();
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

      if (access.autoApprove) {
        onApprove();
      }
    });
  }

  /** Parse ask_user args into a normalized list of questions */
  private parseAskUserQuestions(tc: ToolCall): { q: string; type: string; options: string[] }[] {
    // Multi-question format: questions is a JSON array
    if (tc.args.questions) {
      try {
        const raw = typeof tc.args.questions === "string" ? JSON.parse(tc.args.questions) : tc.args.questions;
        if (Array.isArray(raw)) {
          return raw.map((item: { q?: string; question?: string; type?: string; options?: string[] | string }) => ({
            q: String(item.q || item.question || ""),
            type: (item.type || "text").toLowerCase(),
            options: Array.isArray(item.options)
              ? item.options.map(String)
              : String(item.options || "").split("\n").map((o: string) => o.trim()).filter(Boolean),
          }));
        }
      } catch {
        // Fall through to single question
      }
    }

    // Single question format (backward-compatible)
    const rawOptions = tc.args.options;
    const options = (
      Array.isArray(rawOptions)
        ? rawOptions.map(String)
        : String(rawOptions || "").split("\n")
    ).map((o: string) => o.trim()).filter(Boolean);

    return [{
      q: tc.args.question || "Please answer:",
      type: (tc.args.type || "text").toLowerCase(),
      options,
    }];
  }

  /** Build a form field for a single question and return an answer extractor */
  private buildQuestionField(
    question: { q: string; type: string; options: string[] },
    index: number,
    tcId: string
  ): { el: HTMLElement; getAnswer: () => string } {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-ask-field";

    const label = document.createElement("div");
    label.className = "chat-ask-question";
    label.textContent = question.q;
    wrapper.appendChild(label);

    const formEl = document.createElement("div");
    formEl.className = "chat-ask-form";
    const fieldName = `ask-${tcId}-${index}`;

    if (question.type === "select" && question.options.length > 0) {
      for (let i = 0; i < question.options.length; i++) {
        const optLabel = document.createElement("label");
        optLabel.className = "chat-ask-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = fieldName;
        input.value = question.options[i];
        if (i === 0) input.checked = true;
        optLabel.appendChild(input);
        const span = document.createElement("span");
        span.textContent = question.options[i];
        optLabel.appendChild(span);
        formEl.appendChild(optLabel);
      }

      // "Other" option
      const otherLabel = document.createElement("label");
      otherLabel.className = "chat-ask-option chat-ask-other";
      const otherRadio = document.createElement("input");
      otherRadio.type = "radio";
      otherRadio.name = fieldName;
      otherRadio.value = "__other__";
      otherLabel.appendChild(otherRadio);
      const otherSpan = document.createElement("span");
      otherSpan.textContent = "Other:";
      otherLabel.appendChild(otherSpan);
      const otherInput = document.createElement("input");
      otherInput.type = "text";
      otherInput.className = "chat-ask-other-input";
      otherInput.placeholder = "Type your answer…";
      otherInput.addEventListener("focus", () => { otherRadio.checked = true; });
      otherLabel.appendChild(otherInput);
      formEl.appendChild(otherLabel);

      wrapper.appendChild(formEl);
      return {
        el: wrapper,
        getAnswer: () => {
          const checked = formEl.querySelector(`input[name="${fieldName}"]:checked`) as HTMLInputElement | null;
          if (checked && checked.value === "__other__") {
            const otherVal = formEl.querySelector(".chat-ask-other-input") as HTMLInputElement | null;
            return otherVal?.value.trim() || "(no input)";
          }
          return checked?.value || question.options[0] || "(no input)";
        },
      };
    }

    if (question.type === "checkbox" && question.options.length > 0) {
      for (const opt of question.options) {
        const optLabel = document.createElement("label");
        optLabel.className = "chat-ask-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = opt;
        optLabel.appendChild(input);
        const span = document.createElement("span");
        span.textContent = opt;
        optLabel.appendChild(span);
        formEl.appendChild(optLabel);
      }

      wrapper.appendChild(formEl);
      return {
        el: wrapper,
        getAnswer: () => {
          const checked = formEl.querySelectorAll("input[type='checkbox']:checked") as NodeListOf<HTMLInputElement>;
          const selected = Array.from(checked).map((el) => el.value);
          return selected.length > 0 ? selected.join(", ") : "(none selected)";
        },
      };
    }

    // Default: text area
    const textarea = document.createElement("textarea");
    textarea.className = "chat-ask-textarea";
    textarea.placeholder = "Type your answer…";
    textarea.rows = 2;
    formEl.appendChild(textarea);

    wrapper.appendChild(formEl);
    return {
      el: wrapper,
      getAnswer: () => textarea.value.trim() || "(no input)",
    };
  }

  private renderAskUser(tc: ToolCall): Promise<string> {
    return new Promise((resolve) => {
      const questions = this.parseAskUserQuestions(tc);
      const answerExtractors: (() => string)[] = [];

      const container = document.createElement("div");
      container.className = "chat-ask-user";
      container.dataset.toolId = tc.id;

      // Render each question field
      for (let i = 0; i < questions.length; i++) {
        const { el, getAnswer } = this.buildQuestionField(questions[i], i, tc.id);
        container.appendChild(el);
        answerExtractors.push(getAnswer);
      }

      // Single submit button for all questions
      const submitBtn = document.createElement("button");
      submitBtn.className = "chat-ask-submit";
      submitBtn.textContent = questions.length > 1 ? "Submit All" : "Submit";
      container.appendChild(submitBtn);

      this.messagesEl.appendChild(container);
      this.scrollToBottom();

      submitBtn.addEventListener("click", () => {
        // Collect all answers
        const answers = answerExtractors.map((fn, i) => ({
          question: questions[i].q,
          answer: fn(),
        }));

        // Remove form fields, show answers
        container.querySelectorAll(".chat-ask-field").forEach((el) => el.remove());
        submitBtn.remove();

        const answerEl = document.createElement("div");
        answerEl.className = "chat-ask-answer";
        if (answers.length === 1) {
          answerEl.textContent = answers[0].answer;
        } else {
          answerEl.innerHTML = answers
            .map((a) => `<div><strong>${this.escapeHtml(a.question)}</strong> ${this.escapeHtml(a.answer)}</div>`)
            .join("");
        }
        container.appendChild(answerEl);

        // Format response for the LLM
        const response = answers.length === 1
          ? answers[0].answer
          : answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");

        resolve(response);
      });
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
        this.setLinkedText(resultDiv, tc.result.length > 2000 ? tc.result.substring(0, 2000) + "\n... (truncated)" : tc.result);
        el.appendChild(resultDiv);
      }
    }

    this.scrollToBottom();
  }

  // Tool execution, compression, and shell commands are now in chat-tool-executor.ts

  // ── Context builders for extracted modules ──

  private streamCtx(): StreamContext {
    return {
      abortController: this.abortController,
      agentAborted: this.agentAborted,
      scrollToBottom: () => this.scrollToBottom(),
      setLinkedText: (el, text) => this.setLinkedText(el, text),
    };
  }

  private toolExecCtx(): ToolExecContext {
    return {
      activeCommandProcess: this.activeCommandProcess,
      activeCommandStopped: this.activeCommandStopped,
      agentAborted: this.agentAborted,
      setActiveCommandProcess: (p) => { this.activeCommandProcess = p; },
      setActiveCommandStopped: (v) => { this.activeCommandStopped = v; },
      getProjectPath: () => this.getProjectPath(),
      getAgentAccess: () => this.getAgentAccess(),
      onFileChanged: (path) => this.onFileChanged(path),
      projectContext: this.projectContext,
      setProjectContext: (ctx) => { this.projectContext = ctx; },
    };
  }

  /** Set element content with URLs linkified. Links open on Cmd/Ctrl+click. */
  private setLinkedText(el: HTMLElement, text: string) {
    const escaped = this.escapeHtml(text);
    const linked = escaped.replace(
      /(https?:\/\/[^\s<>"')\]]+)/g,
      '<a class="chat-link" href="$1" title="Cmd/Ctrl + Click to open">$1</a>'
    );
    el.innerHTML = linked;
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}
