import { invoke } from "@tauri-apps/api/core";
import type { AISettings, AgentAccess, AppSettings } from "./settings";
import type { AgentMemory } from "./agent-memory";
import { ContextManager, type TaskContextSnapshot } from "./context-manager";
import {
  type ChatSession,
  type ChatMode,
  type ToolCall,
  createSession,
  saveSession,
  getAllSessions,
  getSessionsByProject,
  deleteSession,
} from "./chat-store";
import {
  streamAI,
  callAIOnce,
  streamAgentTurn,
  type StreamContext,
  type AgentMessage,
  type AgentContentBlock,
  type AgentTurnResult,
} from "./chat-streaming";
import {
  executeTool,
  compressToolResult,
  type ToolExecContext,
} from "./chat-tool-executor";
import {
  AGENT_COMPACT_THRESHOLD_TOKENS,
  AGENT_KEEP_RECENT_MESSAGES,
  MAX_COMPACTED_SUMMARY_CHARS,
  CHAT_SYSTEM_PROMPT,
  getToolDefsForAccess,
} from "../config";
import { capText, capProjectContext, buildAgentSystemPrompt, buildFallbackSystemPrompt } from "../utils";

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
  private contextManager: ContextManager;
  private activeTaskContext: TaskContextSnapshot | null = null;
  private sessionContextMenu: HTMLElement;
  private currentProjectPath: string = "";

  private session: ChatSession;
  private sessions: ChatSession[] = [];
  private isStreaming = false;
  private agentAborted = false;
  private abortController: AbortController | null = null;
  private activeCommandProcess: { pid: number; kill: () => Promise<void> } | null = null;
  private activeCommandStopped = false;
  private activeCommandToolId: string | null = null;

  constructor(
    messagesId: string,
    inputId: string,
    sendBtnId: string,
    sessionListId: string,
    getAISettings: () => AISettings,
    getAgentAccess: () => AgentAccess,
    getProjectPath: () => string,
    contextManager: ContextManager,
  ) {
    this.messagesEl = document.getElementById(messagesId)!;
    this.inputEl = document.getElementById(inputId) as HTMLTextAreaElement;
    this.sendBtn = document.getElementById(sendBtnId)!;
    this.sessionListEl = document.getElementById(sessionListId)!;
    this.getAISettings = getAISettings;
    this.getAgentAccess = getAgentAccess;
    this.getProjectPath = getProjectPath;
    this.contextManager = contextManager;
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
        import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(anchor.href)).catch(() => { });
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

  /** Load and bootstrap the modular project context workspace. */
  async setProjectPath(projectPath: string) {
    if (!projectPath) {
      this.projectContext = "";
      this.activeTaskContext = null;
      return;
    }

    // Reload sessions scoped to new project
    if (this.currentProjectPath !== projectPath) {
      const previousSessionId = this.session?.id;
      if (this.session.messages.length > 0) {
        await saveSession(this.session);
      }
      this.currentProjectPath = projectPath;
      await this.loadSessionsForProject(previousSessionId);
    }

    await this.contextManager.setProjectPath(projectPath);
    this.projectContext = "";
    this.activeTaskContext = null;
  }

  /** Open the manual context editor modal */
  openContextEditor() {
    const modal = document.getElementById("context-modal");
    const textarea = document.getElementById("context-editor-textarea") as HTMLTextAreaElement;
    if (!modal || !textarea) return;

    modal.classList.remove("hidden");
    void this.contextManager.loadProjectConventions().then((content) => {
      textarea.value = content;
      textarea.focus();
    });

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
    try {
      await this.contextManager.saveProjectConventions(content);
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
          this.activeCommandProcess?.kill().catch(() => { })
        );
      }
    }
  }

  private stopRunningCommand(toolId?: string) {
    if (!this.activeCommandProcess) return;
    if (toolId && this.activeCommandToolId && toolId !== this.activeCommandToolId) return;
    this.activeCommandStopped = true;
    void invoke("kill_process_tree", { pid: this.activeCommandProcess.pid }).catch(() =>
      this.activeCommandProcess?.kill().catch(() => { })
    );
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
    this.session.mode = mode === "workflow" ? "agent" : mode;
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
      const showAgentBanner = this.session.mode === "agent" && !dismissed;
      banner.classList.toggle("hidden", !showAgentBanner);

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
      this.inputEl.placeholder = "Tell the agent what to do. It will plan, batch actions, execute, and verify…";
    } else {
      this.inputEl.placeholder = "Ask anything about your code…";
    }
  }

  // ── Sessions ──

  private normalizeSessionMode(session: ChatSession) {
    if (!session.mode) session.mode = "chat";
    if (session.mode === "workflow") session.mode = "agent";
  }

  private syncCurrentSessionInList() {
    const deduped = new Map<string, ChatSession>();
    for (const item of this.sessions) {
      this.normalizeSessionMode(item);
      deduped.set(item.id, item);
    }
    this.normalizeSessionMode(this.session);
    deduped.set(this.session.id, this.session);
    this.sessions = Array.from(deduped.values()).sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return b.createdAt - a.createdAt;
    });
  }

  private async init() {
    await this.loadSessionsForProject();
  }

  private async loadSessionsForProject(preferredSessionId?: string) {
    if (this.currentProjectPath) {
      this.sessions = await getSessionsByProject(this.currentProjectPath);
    } else {
      this.sessions = await getAllSessions();
    }
    if (this.sessions.length > 0) {
      const preferred = preferredSessionId
        ? this.sessions.find((s) => s.id === preferredSessionId)
        : undefined;
      this.session = preferred || this.sessions[0];
      this.normalizeSessionMode(this.session);
    } else {
      this.session = createSession("chat", this.currentProjectPath);
      this.sessions.push(this.session);
    }
    this.syncCurrentSessionInList();
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
    this.syncCurrentSessionInList();
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
      this.normalizeSessionMode(this.session);
      this.syncCurrentSessionInList();
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
    this.syncCurrentSessionInList();
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
        ? ["Audit this feature and patch it", "Find the bug, fix it, and verify", "Refactor this module safely", "Plan and run the tests"]
        : ["Explain this code", "Fix the bug", "Add TypeScript types", "Write unit tests"];
      const title = isAgent ? "Athva Agent" : "Athva AI";
      const subtitle = isAgent
        ? "Planner/executor mode — I will discover context, batch actions, execute them with approval, and verify the result."
        : "Ask anything about your code or project.";

      const welcome = document.createElement("div");
      welcome.className = "chat-welcome";
      welcome.innerHTML = `
        <div class="chat-welcome-icon">
          <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936zM3.794 1.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.58.926 1.097 1.098l1.163.387a.217.217 0 0 1 0 .412l-1.163.387A1.734 1.734 0 0 0 4.593 5.69l-.387 1.162a.217.217 0 0 1-.412 0L3.407 5.69a1.734 1.734 0 0 0-1.097-1.098L1.147 4.207a.217.217 0 0 1 0-.412l1.163-.387a1.734 1.734 0 0 0 1.097-1.098l.387-1.162z"/>
          </svg>
        </div>
        <p class="chat-welcome-title">${title}</p>
        <p class="chat-welcome-sub">${subtitle}</p>
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
    div.className = `chat-tool-call status-${tc.status}`;
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

    if (tc.status === "running" && tc.name === "run_command" && this.activeCommandToolId === tc.id) {
      const actionsDiv = document.createElement("div");
      actionsDiv.className = "chat-tool-call-actions";
      actionsDiv.innerHTML = `
        <button class="btn-deny btn-stop-command" data-tool-id="${tc.id}">Stop Command</button>
      `;
      div.appendChild(actionsDiv);
      const stopBtn = actionsDiv.querySelector(".btn-stop-command") as HTMLButtonElement | null;
      stopBtn?.addEventListener("click", () => this.stopRunningCommand(tc.id));
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
    const normalizedMode = mode === "workflow" ? "agent" : mode;

    if (normalizedMode !== this.session.mode) {
      if (this.session.messages.length > 0) {
        await saveSession(this.session);
        this.session = createSession(normalizedMode, this.currentProjectPath);
        this.syncCurrentSessionInList();
      } else {
        this.session.mode = normalizedMode;
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
    const startIndex = this.session.messages.length;

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

    await this.refreshActiveTaskContext(text);

    if (this.session.mode === "agent") {
      await this.runAgentLoop(settings, startIndex, text);
    } else {
      await this.runChatResponse(settings, startIndex, text);
    }
  }

  // ── Chat Mode (simple streaming response) ──

  private async runChatResponse(settings: AISettings, startIndex: number, userTask: string) {
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
      await this.recordTaskCompletion(startIndex, userTask);
      await saveSession(this.session);
      this.renderSessionList();
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
      `You are summarizing an AI coding session for context continuation. The summary will replace older messages.\n\n` +
      `Write a concise summary (max ${MAX_COMPACTED_SUMMARY_CHARS} characters) covering:\n` +
      `1. The user's current goal or task\n` +
      `2. Which files were read (list paths)\n` +
      `3. Which files were modified or created (list paths and what changed)\n` +
      `4. Results of any commands run (key outputs only)\n` +
      `5. What has been completed so far\n` +
      `6. What remains to be done\n\n` +
      `Do not include greeting text. Write in third-person past tense. Be specific about file paths and concrete outcomes.\n\n` +
      `${this.session.compactedSummary ? `Previous summary:\n${capText(this.session.compactedSummary, 900, "…")}\n\n` : ""}` +
      `Recent conversation to summarize:\n${historyText}`;

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

  private async runAgentLoop(settings: AISettings, startIndex: number, userTask: string): Promise<void> {
    this.isStreaming = true;
    this.agentAborted = false;
    this.abortController = new AbortController();
    this.showStopButton(true);
    this.sendBtn.setAttribute("disabled", "true");

    const MAX_TURNS = 30;
    let turns = 0;

    try {
      while (turns < MAX_TURNS) {
        if (this.agentAborted) break;
        turns++;

        if (this.estimateSessionTokens() >= AGENT_COMPACT_THRESHOLD_TOKENS) {
          await this.compactHistory(settings);
        }

        const access = this.getAgentAccess();
        const tools = getToolDefsForAccess(access);
        const history = this.buildAgentHistory(settings);

        const streamEl = this.addDOMMessage("assistant", "");
        streamEl.classList.add("streaming");

        let turnResult: AgentTurnResult;
        try {
          turnResult = await streamAgentTurn(settings, history, tools, streamEl, this.streamCtx());
        } catch (e: unknown) {
          const name = e instanceof Error ? e.name : "";
          if (name === "AbortError") { streamEl.remove(); break; }
          const msg = e instanceof Error ? e.message : String(e);
          streamEl.className = "chat-msg error";
          this.setLinkedText(streamEl, `Error: ${msg}`);
          streamEl.classList.remove("streaming");
          break;
        }
        streamEl.classList.remove("streaming");

        // No tool calls — agent is done for this turn
        if (turnResult.toolCalls.length === 0) {
          if (turnResult.text.trim()) {
            this.setLinkedText(streamEl, turnResult.text);
          } else {
            streamEl.remove();
          }
          this.session.messages.push({ role: "assistant", content: turnResult.text });
          break;
        }

        // Persist assistant message with tool calls
        const assistantToolCalls: ToolCall[] = turnResult.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args as Record<string, string>,
          status: "pending" as const,
        }));

        if (turnResult.text.trim()) {
          this.setLinkedText(streamEl, turnResult.text);
        } else {
          streamEl.remove();
        }

        this.session.messages.push({
          role: "assistant",
          content: turnResult.text,
          toolCalls: assistantToolCalls,
        });

        // Execute all tool calls
        const results = await this.executeToolCalls(assistantToolCalls);

        // Persist tool results
        for (const { tc, result, denied } of results) {
          const compressed = denied ? `[${tc.name}] Denied by user.` : compressToolResult(tc.name, result);
          this.session.messages.push({
            role: "tool",
            content: compressed,
            toolCallId: tc.id,
            toolName: tc.name,
          });
        }

        await saveSession(this.session);
        this.renderMessages();
        this.scrollToBottom();

        const allDenied = results.every((r) => r.denied);
        if (allDenied || this.agentAborted) break;
      }

      if (turns >= MAX_TURNS && !this.agentAborted) {
        const msg = `Reached the ${MAX_TURNS}-turn limit. Send a follow-up to continue.`;
        this.addDOMMessage("assistant", msg);
        this.session.messages.push({ role: "assistant", content: msg });
      }
    } finally {
      this.isStreaming = false;
      this.agentAborted = false;
      this.abortController = null;
      this.showStopButton(false);
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await this.recordTaskCompletion(startIndex, userTask);
      await saveSession(this.session);
      this.renderSessionList();
      this.scrollToBottom();
      void this.compactHistory(settings);
    }
  }

  private async refreshActiveTaskContext(task: string) {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      this.projectContext = "";
      this.activeTaskContext = null;
      return;
    }

    const snapshot = await this.contextManager.buildTaskContext(task, this.session.messages);
    this.activeTaskContext = snapshot;
    this.projectContext = snapshot.promptContext;
  }

  private async recordTaskCompletion(startIndex: number, userTask: string) {
    if (!this.currentProjectPath || !userTask.trim()) return;
    const taskMessages = this.session.messages.slice(startIndex);
    const hasAssistantOrToolActivity = taskMessages.some((message) => message.role !== "user");
    if (!hasAssistantOrToolActivity) return;

    await this.contextManager.recordTaskCompletion({
      userTask,
      mode: this.session.mode,
      relevantContextFiles: this.activeTaskContext?.relevantFiles || [],
      messages: taskMessages,
    });
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
  ): Promise<Array<{ tc: ToolCall; result: string; denied: boolean }>> {
    const results: Array<{ tc: ToolCall; result: string; denied: boolean }> = [];
    const access = this.getAgentAccess();

    for (const tc of toolCalls) {
      if (this.agentAborted) {
        tc.status = "denied";
        tc.result = "Agent stopped.";
        results.push({ tc, result: "Agent stopped.", denied: true });
        continue;
      }

      // ask_user: render form, wait for answer, no approve/deny flow
      if (tc.name === "ask_user") {
        const answer = await this.renderAskUser(tc);
        tc.status = "done";
        tc.result = answer;
        const capped = answer.length > 1500 ? answer.substring(0, 1500) + "…" : answer;
        results.push({ tc, result: `User answered:\n${capped}`, denied: false });
        continue;
      }

      const toolEl = this.renderToolCall(tc);

      // Only mutable tools need approval when autoApprove is false
      const needsApproval = !access.autoApprove && (
        tc.name === "write_file" || tc.name === "delete_path" || tc.name === "run_command"
      );

      const approved = needsApproval ? await this.requestApproval(tc, toolEl) : true;

      if (!approved) {
        tc.status = "denied";
        tc.result = "User denied this action.";
        this.updateToolCallUI(tc);
        results.push({ tc, result: "User denied this action.", denied: true });
        continue;
      }

      tc.status = "running";
      this.updateToolCallUI(tc);

      try {
        const result = await executeTool(tc, this.toolExecCtx());
        tc.status = "done";
        tc.result = result;
        this.updateToolCallUI(tc);
        results.push({ tc, result, denied: false });
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        tc.status = "error";
        tc.result = errMsg;
        this.updateToolCallUI(tc);
        results.push({ tc, result: errMsg, denied: false });
      }
    }

    return results;
  }

  private buildAgentHistory(settings: AISettings): AgentMessage[] {
    const access = this.getAgentAccess();
    const projectPath = this.getProjectPath();
    const projectContext = this.projectContext;

    const useFallback = settings.provider === "google" || settings.provider === "mimo" || settings.provider === "mistral";
    const systemContent = useFallback
      ? buildFallbackSystemPrompt(projectPath, access, projectContext)
      : buildAgentSystemPrompt(projectPath, access, projectContext);

    const messages: AgentMessage[] = [
      { role: "user" as const, content: [{ type: "text" as const, text: systemContent }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "Understood. I'm ready to help with your project." }] },
    ];

    // Inject compacted summary if present
    if (this.session.compactedSummary) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[Context from earlier in this session]\n${this.session.compactedSummary}` }],
      });
      messages.push({ role: "assistant", content: [{ type: "text", text: "Got it, I have the prior context." }] });
    }

    // Replay session messages
    const recentMessages = this.session.messages.slice(-(AGENT_KEEP_RECENT_MESSAGES * 4));

    for (let i = 0; i < recentMessages.length; i++) {
      const msg = recentMessages[i];

      if (msg.role === "user") {
        const capped = msg.content.length > 1800 ? msg.content.substring(0, 1800) + "…" : msg.content;
        messages.push({ role: "user", content: capped });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: AgentContentBlock[] = [];
          if (msg.content.trim()) content.push({ type: "text", text: msg.content });
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.args as Record<string, unknown>,
            });
          }
          messages.push({ role: "assistant", content });
        } else {
          const capped = msg.content.length > 1600 ? msg.content.substring(0, 1600) + "…" : msg.content;
          messages.push({ role: "assistant", content: capped });
        }
      } else if (msg.role === "tool") {
        // Collect consecutive tool results into one user message (required for Anthropic)
        const toolResultBlocks: AgentContentBlock[] = [];
        let j = i;
        while (j < recentMessages.length && recentMessages[j].role === "tool") {
          const t = recentMessages[j];
          const capped = t.content.length > 900 ? t.content.substring(0, 900) + "…" : t.content;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: t.toolCallId || `tool-${j}`,
            content: capped,
          });
          j++;
        }
        messages.push({ role: "user", content: toolResultBlocks });
        i = j - 1;
      }
    }

    return messages;
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
    el.className = `chat-tool-call status-${tc.status}`;

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

    const existingActions = el.querySelector(".chat-tool-call-actions");
    if (tc.status === "running" && tc.name === "run_command" && this.activeCommandToolId === tc.id) {
      if (!existingActions) {
        const actionsDiv = document.createElement("div");
        actionsDiv.className = "chat-tool-call-actions";
        actionsDiv.innerHTML = `
          <button class="btn-deny btn-stop-command" data-tool-id="${tc.id}">Stop Command</button>
        `;
        el.appendChild(actionsDiv);
        const stopBtn = actionsDiv.querySelector(".btn-stop-command") as HTMLButtonElement | null;
        stopBtn?.addEventListener("click", () => this.stopRunningCommand(tc.id));
      }
    } else if (existingActions && !existingActions.querySelector(".btn-approve")) {
      existingActions.remove();
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
      activeCommandToolId: this.activeCommandToolId,
      agentAborted: this.agentAborted,
      setActiveCommandProcess: (p) => { this.activeCommandProcess = p; },
      setActiveCommandStopped: (v) => { this.activeCommandStopped = v; },
      setActiveCommandToolId: (toolId) => { this.activeCommandToolId = toolId; },
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
