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
import {
  executeTool,
  compressToolResult,
  executeExecutorAction,
  executorActionNeedsApproval,
  type ToolExecContext,
} from "./chat-tool-executor";
import {
  WORKFLOW_MAX_ITERATIONS,
  WORKFLOW_MAX_RETRIES,
  PROJECT_ROOT_TOKEN,
  appendWorkflowSnapshot,
  buildWorkflowPlannerPrompt,
  createWorkflowSnapshot,
  createWorkflowState,
  parsePlannerPlan,
  plannerPlanToActions,
  summarizeWorkflowState,
  toExecutorAction,
  workflowPhaseLabel,
  workflowSnapshotCardLines,
  type ExecutorResult,
  type FailureReport,
  type PlannerPlan,
  type WorkflowPhase,
  type WorkflowPlanAction,
  type WorkflowQuestion,
  type WorkflowSnapshot,
  type WorkflowStateEnvelope,
} from "./chat-workflow";
import { AGENT_COMPACT_THRESHOLD_TOKENS, AGENT_KEEP_RECENT_MESSAGES, MAX_COMPACTED_SUMMARY_CHARS, CHAT_SYSTEM_PROMPT } from "../config";
import { capText, capProjectContext, buildAgentSystemPrompt } from "../utils";

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
  private activeCommandToolId: string | null = null;

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

  /** Load .athva/context.md from the project root and inject into system prompts.
   *  Auto-creates the file if it doesn't exist so the agent can persist knowledge from the start. */
  async setProjectPath(projectPath: string) {
    if (!projectPath) { this.projectContext = ""; return; }

    // Reload sessions scoped to new project
    if (this.currentProjectPath !== projectPath) {
      const previousSessionId = this.session?.id;
      if (this.session.messages.length > 0) {
        await saveSession(this.session);
      }
      this.currentProjectPath = projectPath;
      await this.loadSessionsForProject(previousSessionId);
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
      if (this.session.workflowState) {
        this.session.workflowState = {
          ...this.session.workflowState,
          status: "interrupted",
          latestSummary: this.session.workflowState.latestSummary || "Workflow interrupted by user.",
        };
      }
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
      if (this.isWorkflowBoilerplateMessage(msg)) {
        continue;
      }
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
    this.renderWorkflowTimeline();
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

  private renderWorkflowTimeline() {
    this.messagesEl.querySelector(".workflow-timeline")?.remove();

    if (this.session.mode !== "agent" || !this.session.workflowState || this.session.workflowState.snapshots.length === 0) {
      return;
    }

    const timeline = document.createElement("div");
    timeline.className = "workflow-timeline";

    for (const snapshot of this.visibleWorkflowSnapshots(this.session.workflowState.snapshots)) {
      timeline.appendChild(this.createWorkflowCard(snapshot));
    }

    if (this.session.workflowState.status === "awaiting_input" && this.session.workflowState.pendingQuestions?.length) {
      timeline.appendChild(this.createWorkflowClarificationCard(
        this.session.workflowState.pendingQuestions,
        this.session.workflowState.pendingPhase || this.session.workflowState.activePhase,
      ));
    }

    this.messagesEl.appendChild(timeline);
  }

  private visibleWorkflowSnapshots(snapshots: WorkflowSnapshot[]): WorkflowSnapshot[] {
    return snapshots.filter((snapshot, index) => {
      const next = snapshots[index + 1];
      if (!next) return true;
      if (snapshot.status !== "running") return true;
      const samePhase = next.phase === snapshot.phase;
      const sameSummary = next.summary === snapshot.summary;
      const sameKind = next.plan?.kind === snapshot.plan?.kind;
      return !(samePhase && sameSummary && sameKind);
    });
  }

  private createWorkflowCard(snapshot: WorkflowSnapshot): HTMLElement {
    const card = document.createElement("div");
    card.className = "workflow-card";
    card.dataset.snapshotId = snapshot.id;

    const meta = document.createElement("div");
    meta.className = "workflow-card-meta";
    meta.innerHTML = `
      <span class="workflow-card-phase">${this.escapeHtml(workflowPhaseLabel(snapshot.phase))}</span>
      <span class="workflow-card-status ${snapshot.status}">${this.escapeHtml(snapshot.status)}</span>
      <span class="workflow-card-iteration">#${snapshot.iteration}</span>
    `;
    card.appendChild(meta);

    const title = document.createElement("div");
    title.className = "workflow-card-summary";
    title.textContent = snapshot.summary;
    card.appendChild(title);

    const details = document.createElement("div");
    details.className = "workflow-card-details";
    details.innerHTML = workflowSnapshotCardLines(snapshot)
      .slice(1)
      .map((line) => `<div>${this.escapeHtml(line)}</div>`)
      .join("");
    card.appendChild(details);

    return card;
  }

  private createWorkflowClarificationCard(questions: WorkflowQuestion[], phase: WorkflowPhase): HTMLElement {
    const card = document.createElement("div");
    card.className = "workflow-card workflow-card-clarification";

    const header = document.createElement("div");
    header.className = "workflow-card-meta";
    header.innerHTML = `
      <span class="workflow-card-phase">${this.escapeHtml(workflowPhaseLabel(phase))}</span>
      <span class="workflow-card-status awaiting_input">awaiting input</span>
    `;
    card.appendChild(header);

    const summary = document.createElement("div");
    summary.className = "workflow-card-summary";
    summary.textContent = "Workflow needs clarification before it can continue.";
    card.appendChild(summary);

    const formWrap = document.createElement("div");
    formWrap.className = "chat-ask-user";
    const answerExtractors: (() => string)[] = [];

    for (let i = 0; i < questions.length; i++) {
      const { el, getAnswer } = this.buildQuestionField(
        {
          q: questions[i].q,
          type: questions[i].type,
          options: questions[i].options || [],
        },
        i,
        `workflow-${questions[i].id}`,
      );
      formWrap.appendChild(el);
      answerExtractors.push(getAnswer);
    }

    const submitBtn = document.createElement("button");
    submitBtn.className = "chat-ask-submit";
    submitBtn.textContent = questions.length > 1 ? "Submit All" : "Submit";
    formWrap.appendChild(submitBtn);
    card.appendChild(formWrap);

    submitBtn.addEventListener("click", async () => {
      const answers = questions.reduce<Record<string, string>>((acc, question, index) => {
        acc[question.id] = answerExtractors[index]();
        return acc;
      }, {});

      submitBtn.textContent = "Continuing...";
      submitBtn.setAttribute("disabled", "true");
      await this.submitWorkflowAnswers(answers);
    });

    return card;
  }

  private currentWorkflowState(taskText = "", resume = false): WorkflowStateEnvelope {
    if (resume && this.session.workflowState) {
      return this.session.workflowState;
    }

    const existing = this.session.workflowState;
    if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "interrupted") {
      const next = createWorkflowState(taskText);
      this.session.workflowState = next;
      return next;
    }

    if (existing.status === "awaiting_input" && taskText.trim()) {
      const next = {
        ...existing,
        collectedInputs: {
          ...existing.collectedInputs,
          latest_user_feedback: taskText.trim(),
        },
        pendingQuestions: undefined,
        pendingPhase: undefined,
        status: "running" as const,
      };
      this.session.workflowState = next;
      return next;
    }

    return existing;
  }

  private async saveWorkflowState(state: WorkflowStateEnvelope) {
    this.session.workflowState = state;
    this.session.updatedAt = Date.now();
    await saveSession(this.session);
    this.renderSessionList();
    this.renderWorkflowTimeline();
    this.scrollToBottom();
  }

  private isWorkflowBoilerplateMessage(msg: ChatMessage): boolean {
    if (this.session.mode !== "agent" || msg.role !== "assistant") return false;
    return (
      msg.content.startsWith("Workflow input received for ") ||
      msg.content === "Workflow complete. Verification passed." ||
      msg.content === "Workflow paused because an action was denied." ||
      msg.content === "Workflow interrupted by user." ||
      msg.content.startsWith("Workflow request failed during ") ||
      msg.content.startsWith("Workflow reached the ") ||
      msg.content === "Workflow planner returned an invalid plan." ||
      msg.content === "Planner repeated the same no-op phase. Workflow stopped to avoid a request loop."
    );
  }

  private async persistWorkflowContextNote(state: WorkflowStateEnvelope, finalSummary: string) {
    try {
      const projectPath = this.getProjectPath();
      if (!projectPath) return;
      if (this.projectContext.includes(`Run ID: ${state.runId}`)) return;

      const changedFiles = Array.from(
        new Set(
          state.snapshots.flatMap((snapshot) =>
            snapshot.tool_results
              .filter((result) => result.ok && result.tool === "write_file")
              .flatMap((result) => result.artifacts),
          ),
        ),
      ).slice(0, 8);

      const recentDeltas = Array.from(
        new Set(
          state.snapshots
            .slice(-4)
            .flatMap((snapshot) => snapshot.deltas)
            .filter((line) => line && !line.startsWith("Running ")),
        ),
      ).slice(0, 6);

      const inputLines = Object.entries(state.collectedInputs)
        .slice(-4)
        .map(([key, value]) => `- Input ${key}: ${value}`);

      const noteLines = [
        `## Workflow ${new Date().toISOString()}`,
        `- Run ID: ${state.runId}`,
        `- Task: ${state.task}`,
        `- Status: ${state.status}`,
        `- Summary: ${finalSummary}`,
        changedFiles.length > 0 ? `- Files changed: ${changedFiles.join(", ")}` : "",
        ...inputLines,
        ...recentDeltas.map((line) => `- Note: ${line}`),
      ].filter(Boolean);

      const next = `${this.projectContext.trimEnd()}\n\n${noteLines.join("\n")}\n`;
      await this.saveContext(next);
    } catch (e) {
      console.error("Failed to persist workflow context note:", e);
    }
  }

  private getLatestWorkflowResults(state: WorkflowStateEnvelope): ExecutorResult[] {
    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      if (state.snapshots[i].tool_results.length > 0) return state.snapshots[i].tool_results;
    }
    return [];
  }

  private getResolvedWorkflowFiles(state: WorkflowStateEnvelope): string[] {
    const files = new Set<string>();
    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        for (const artifact of result.artifacts) {
          if (artifact.includes("/") || artifact.includes("\\")) {
            files.add(artifact);
          }
        }
      }
      if (snapshot.plan && "files" in snapshot.plan) {
        for (const file of snapshot.plan.files) {
          if (file) files.add(file);
        }
      }
    }
    return Array.from(files);
  }

  private workflowMinFilesRequired(state: WorkflowStateEnvelope): number {
    const resolvedFiles = this.getResolvedWorkflowFiles(state);
    const readFiles = this.getReadWorkflowFiles(state);
    const unreadResolved = resolvedFiles.filter((file) => !readFiles.includes(file));

    if (readFiles.length > 0 && unreadResolved.length === 0) {
      return Math.max(1, Math.min(state.thresholds.minFilesCovered, resolvedFiles.length || readFiles.length));
    }

    return state.thresholds.minFilesCovered;
  }

  private isWorkflowContextReady(state: WorkflowStateEnvelope): boolean {
    const files = this.getResolvedWorkflowFiles(state);
    if (files.length < this.workflowMinFilesRequired(state)) return false;

    if (state.explicitTargets.length === 0) return true;

    const haystack = [
      state.task,
      state.latestSummary,
      ...files,
      ...state.snapshots.flatMap((snapshot) => snapshot.tool_results.map((result) => result.output)),
    ]
      .join("\n")
      .toLowerCase();

    return state.explicitTargets.every((target) => haystack.includes(target.toLowerCase()));
  }

  private workflowPhaseForPlan(plan: PlannerPlan, fallback: WorkflowPhase): WorkflowPhase {
    switch (plan.kind) {
      case "DiscoverySpec":
        return "discovery";
      case "ContextPlan":
        return "context_validation";
      case "ReadPlan":
        return "read";
      case "ExecutionPlan":
        return "execution";
      case "VerificationPlan":
        return "verification";
      case "FixPlan":
        return "remediation";
      default:
        return fallback;
    }
  }

  private planSummary(plan: PlannerPlan): string {
    return plan.summary || `${plan.kind} generated.`;
  }

  private isSafeCleanupCandidate(path: string): boolean {
    const trimmed = path.trim();
    const name = trimmed.split("/").pop() || trimmed;
    return (
      name === ".DS_Store" ||
      name === "Thumbs.db" ||
      name === "npm-debug.log" ||
      name === "yarn-debug.log" ||
      name === "yarn-error.log" ||
      /^.+\.(log|tmp|temp|swp|swo|bak|orig)$/i.test(name) ||
      /(^|\/)(coverage|\.cache)(\/|$)/.test(trimmed)
    );
  }

  private cleanupSearchQueries(): string[] {
    return [
      ".DS_Store",
      "Thumbs.db",
      ".log",
      ".tmp",
      ".temp",
      ".swp",
      ".swo",
      ".bak",
      ".orig",
      ".cache",
      "coverage",
      "npm-debug.log",
      "yarn-debug.log",
      "yarn-error.log",
    ];
  }

  private discoveredCleanupCandidates(state: WorkflowStateEnvelope): string[] {
    const candidates = new Set<string>();
    const deleted = new Set<string>();

    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (!result.ok) continue;

        if (result.tool === "delete_path") {
          for (const artifact of result.artifacts) {
            if (artifact) deleted.add(artifact);
          }
          continue;
        }

        if (result.tool === "search_files") {
          for (const line of result.output.split("\n")) {
            const filePath = line.trim();
            if (filePath.includes("/") && this.isSafeCleanupCandidate(filePath)) {
              candidates.add(filePath);
            }
          }
          continue;
        }

        if (result.tool === "list_dir" && result.artifacts.length > 0) {
          const root = result.artifacts[0];
          for (const line of result.output.split("\n")) {
            const name = line.replace(/^\[dir\]\s+/, "").trim();
            if (!name) continue;
            const fullPath = `${root.replace(/\/$/, "")}/${name}`;
            if (this.isSafeCleanupCandidate(fullPath)) {
              candidates.add(fullPath);
            }
          }
        }
      }
    }

    return Array.from(candidates).filter((path) => !deleted.has(path));
  }

  private planDebugLines(plan: PlannerPlan): string[] {
    const lines = [
      `Plan kind: ${plan.kind}`,
      `Declared tools: ${plan.tools.join(", ") || "(none)"}`,
      `Step count: ${(plan.steps || []).length}`,
    ];

    if ("commands" in plan) {
      lines.push(`Command count: ${plan.commands.length}`);
    }
    if ("files_to_modify" in plan) {
      lines.push(`Files to modify: ${plan.files_to_modify.join(", ") || "(none)"}`);
    }
    if (plan.raw_response) {
      lines.push(`Planner response:\n${plan.raw_response}`);
    }

    return lines;
  }

  private workflowLooksLikeGitRepo(state: WorkflowStateEnvelope): boolean {
    const haystack = [
      ...this.getResolvedWorkflowFiles(state),
      ...state.snapshots.flatMap((snapshot) => snapshot.tool_results.map((result) => result.output)),
    ].join("\n");
    return /(^|[\\/\s])\.git([\\/\s]|$)|\[dir\]\s+\.git\b/.test(haystack);
  }

  private workflowKnownPackageScripts(state: WorkflowStateEnvelope): Record<string, string> {
    const scripts: Record<string, string> = {};

    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (!result.ok || result.tool !== "read_file") continue;
        const path = result.artifacts[0] || result.args?.path || "";
        if (!/package\.json$/i.test(path)) continue;
        try {
          const parsed = JSON.parse(result.output);
          if (parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object") {
            for (const [name, command] of Object.entries(parsed.scripts as Record<string, unknown>)) {
              if (typeof command === "string") scripts[name] = command;
            }
          }
        } catch {
          continue;
        }
      }
    }

    return scripts;
  }

  private workflowCommandHistory(state: WorkflowStateEnvelope): { ok: Set<string>; failed: Set<string> } {
    const ok = new Set<string>();
    const failed = new Set<string>();

    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (result.tool !== "run_command") continue;
        const command = String(result.args?.command || "").trim();
        if (!command) continue;
        if (result.ok) ok.add(command);
        else failed.add(command);
      }
    }

    return { ok, failed };
  }

  private workflowDiscoveredPaths(state: WorkflowStateEnvelope): Set<string> {
    const discovered = new Set<string>();
    const deleted = new Set<string>();

    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (!result.ok) continue;

        if (result.tool === "delete_path") {
          for (const artifact of result.artifacts) {
            if (artifact) deleted.add(artifact);
          }
          continue;
        }

        if (result.tool === "list_dir" && result.artifacts.length > 0) {
          const root = result.artifacts[0].replace(/\/$/, "");
          for (const line of result.output.split("\n")) {
            const name = line.replace(/^\[dir\]\s+/, "").trim();
            if (!name) continue;
            discovered.add(`${root}/${name}`);
          }
          continue;
        }

        if (result.tool === "search_files") {
          for (const line of result.output.split("\n")) {
            const filePath = line.trim();
            if (filePath.includes("/") || filePath.includes("\\")) {
              discovered.add(filePath);
            }
          }
          continue;
        }

        if (
          result.tool === "read_file" ||
          result.tool === "batch_read" ||
          result.tool === "search_in_files" ||
          result.tool === "write_file"
        ) {
          for (const artifact of result.artifacts) {
            if (artifact.includes("/") || artifact.includes("\\")) {
              discovered.add(artifact);
            }
          }
        }
      }
    }

    for (const path of deleted) {
      discovered.delete(path);
    }

    return discovered;
  }

  private workflowDeletePathIsDiscovered(path: string, state: WorkflowStateEnvelope): boolean {
    const normalized = path.trim();
    if (!normalized) return false;
    return this.workflowDiscoveredPaths(state).has(normalized);
  }

  private workflowKeywordHints(task: string): { fileQueries: string[]; contentQueries: string[] } {
    const fileQueries = new Set<string>();
    const contentQueries = new Set<string>();
    const normalizedTask = task.toLowerCase();

    if (/\bexpress\b/.test(normalizedTask)) {
      fileQueries.add("server");
      fileQueries.add("app");
      fileQueries.add("routes");
      contentQueries.add("express");
    }

    if (/\b(gql|graphql|apollo)\b/.test(normalizedTask)) {
      fileQueries.add("schema");
      fileQueries.add("resolver");
      fileQueries.add("resolvers");
      fileQueries.add("graphql");
      contentQueries.add("gql");
      contentQueries.add("graphql");
      contentQueries.add("@apollo/");
      contentQueries.add("graphql-tag");
      contentQueries.add("makeExecutableSchema");
    }

    if (/\b(route|routes|router)\b/.test(normalizedTask)) {
      fileQueries.add("route");
      fileQueries.add("routes");
      fileQueries.add("router");
      contentQueries.add("express.Router");
    }

    return {
      fileQueries: Array.from(fileQueries),
      contentQueries: Array.from(contentQueries),
    };
  }

  private commandUsesKnownScript(command: string, scripts: Record<string, string>): boolean {
    const trimmed = command.trim();
    const npmRun = trimmed.match(/^(?:npm|pnpm)\s+run\s+([A-Za-z0-9:_-]+)/);
    if (npmRun) return Boolean(scripts[npmRun[1]]);
    const npmShorthand = trimmed.match(/^pnpm\s+([A-Za-z0-9:_-]+)$/);
    if (npmShorthand && !["install", "add", "exec", "dlx", "create"].includes(npmShorthand[1])) {
      return Boolean(scripts[npmShorthand[1]]);
    }
    return false;
  }

  private isPlaceholderScript(command: string): boolean {
    return /echo\s+["']?Error:\s*no test specified/i.test(command);
  }

  private isLightweightVerificationCommand(command: string): boolean {
    const trimmed = command.trim();
    return /^(node\s+-e\b|node\s+--check\b|node\s+\S+\.js\b|npm\s+ls\b|pnpm\s+ls\b)/.test(trimmed);
  }

  private workflowPlanActionIssues(plan: PlannerPlan, state: WorkflowStateEnvelope): string[] {
    const actions = plannerPlanToActions(plan);
    const issues: string[] = [];
    const knownScripts = this.workflowKnownPackageScripts(state);
    const commandHistory = this.workflowCommandHistory(state);
    const phase = this.workflowPhaseForPlan(plan, state.activePhase);

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const label = `${action.tool} action ${i + 1}`;
      const args = action.args || {};
      const values = Object.values(args).map((value) => String(value || ""));

      if (values.some((value) => /\{\{[^}]+\}\}/.test(value))) {
        issues.push(`${label} contains unresolved template placeholders.`);
      }

      switch (action.tool) {
        case "read_file":
        case "list_dir":
          if (!String(args.path || "").trim()) {
            issues.push(`${label} is missing required "path" arg.`);
          }
          break;
        case "delete_path": {
          const path = String(args.path || "").trim();
          if (!path) {
            issues.push(`${label} is missing required "path" arg.`);
          } else if (!this.workflowDeletePathIsDiscovered(path, state)) {
            issues.push(`${label} targets a path that has not been concretely discovered yet: ${path}`);
          }
          break;
        }
        case "write_file":
          if (!String(args.path || "").trim()) {
            issues.push(`${label} is missing required "path" arg.`);
          }
          if (!String(args.content || "").length) {
            issues.push(`${label} is missing required "content" arg.`);
          }
          break;
        case "run_command": {
          const command = String(args.command || "").trim();
          if (!command) {
            issues.push(`${label} is missing required "command" arg.`);
          } else if (/^\s*git\b/.test(command) && !this.workflowLooksLikeGitRepo(state)) {
            issues.push(`${label} uses git in a project that does not appear to be a git repository.`);
          } else if (commandHistory.failed.has(command)) {
            issues.push(`${label} repeats a command that already failed earlier: ${command}`);
          } else if ((phase === "verification" || phase === "remediation")) {
            const knownScript = this.commandUsesKnownScript(command, knownScripts);
            const lightweight = this.isLightweightVerificationCommand(command);
            const previouslySucceeded = commandHistory.ok.has(command);
            if (!knownScript && !lightweight && !previouslySucceeded) {
              issues.push(`${label} uses an unproven verification/remediation command: ${command}`);
            }
            if (knownScript) {
              const scriptName = command.match(/^(?:npm|pnpm)\s+run\s+([A-Za-z0-9:_-]+)/)?.[1]
                || command.match(/^pnpm\s+([A-Za-z0-9:_-]+)$/)?.[1]
                || "";
              if (scriptName && knownScripts[scriptName] && this.isPlaceholderScript(knownScripts[scriptName])) {
                issues.push(`${label} uses placeholder package script "${scriptName}".`);
              }
            }
          }
          break;
        }
        case "search_files":
          if (!String(args.query || "").trim()) {
            issues.push(`${label} is missing required "query" arg.`);
          }
          break;
        case "search_in_files":
        case "search_content":
          if (!String(args.query || args.pattern || "").trim()) {
            issues.push(`${label} is missing required "query" or "pattern" arg.`);
          }
          break;
        case "batch_read":
          if (!String(args.paths || "").trim()) {
            issues.push(`${label} is missing required "paths" arg.`);
          }
          break;
        default:
          break;
      }
    }

    return issues;
  }

  private workflowTaskNeedsDeletion(task: string): boolean {
    return /\b(remove|delete|cleanup|clean up|clear)\b/i.test(task) && /\b(file|files|folder|folders)\b/i.test(task);
  }

  private workflowTaskIsTargetedDeletion(state: WorkflowStateEnvelope): boolean {
    return /\b(remove|delete)\b/i.test(state.task) && state.explicitTargets.length > 0;
  }

  private explicitDeleteTargetQueries(state: WorkflowStateEnvelope): string[] {
    return Array.from(new Set(
      state.explicitTargets
        .map((target) => target.split(/[\\/]/).pop() || target)
        .map((target) => target.trim())
        .filter(Boolean),
    )).slice(0, 6);
  }

  private discoveredExplicitDeleteTargets(state: WorkflowStateEnvelope): string[] {
    const queries = this.explicitDeleteTargetQueries(state).map((value) => value.toLowerCase());
    const explicitTargets = state.explicitTargets.map((value) => value.toLowerCase());
    const candidates = new Set<string>();
    const deleted = new Set<string>();

    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (!result.ok) continue;

        if (result.tool === "delete_path") {
          for (const artifact of result.artifacts) {
            if (artifact) deleted.add(artifact);
          }
          continue;
        }

        if (result.tool === "search_files") {
          for (const line of result.output.split("\n")) {
            const filePath = line.trim();
            if (!filePath.includes("/")) continue;
            const lower = filePath.toLowerCase();
            const name = (filePath.split("/").pop() || filePath).toLowerCase();
            if (queries.includes(name) || explicitTargets.some((target) => lower.endsWith(target))) {
              candidates.add(filePath);
            }
          }
        }
      }
    }

    return Array.from(candidates).filter((path) => !deleted.has(path));
  }

  private workflowHasSuccessfulTool(state: WorkflowStateEnvelope, tool: string): boolean {
    return state.snapshots.some((snapshot) =>
      snapshot.tool_results.some((result) => result.ok && result.tool === tool),
    );
  }

  private cleanupObjectiveSatisfied(state: WorkflowStateEnvelope, results: ExecutorResult[]): boolean {
    if (!this.workflowTaskNeedsDeletion(state.task)) return true;
    if (this.discoveredCleanupCandidates(state).length === 0) return true;
    if (this.workflowHasSuccessfulTool(state, "delete_path")) return true;
    return results.some((result) => result.ok && result.tool === "search_files" && /no files found\./i.test(result.output));
  }

  private targetedDeleteObjectiveSatisfied(state: WorkflowStateEnvelope): boolean {
    if (!this.workflowTaskIsTargetedDeletion(state)) return true;
    return this.discoveredExplicitDeleteTargets(state).length === 0;
  }

  private async repairPlannerActions(
    settings: AISettings,
    state: WorkflowStateEnvelope,
    phase: WorkflowPhase,
    plan: PlannerPlan,
    issues: string[] = [],
  ): Promise<PlannerPlan | null> {
    if (
      plan.kind !== "ExecutionPlan" &&
      plan.kind !== "VerificationPlan" &&
      plan.kind !== "FixPlan"
    ) {
      return null;
    }

    const repairPrompt = [
      "You returned a valid plan shape but without executable actions.",
      "Produce exactly one valid JSON object and nothing else.",
      `Keep kind as ${plan.kind}.`,
      "Preserve the original intent.",
      "Add concrete actions or commands so the app can execute the phase now.",
      "Use only these tools in actions: batch_read, read_file, write_file, delete_path, run_command, search_files, search_in_files, list_dir, git_diff.",
      "If files must be edited, include write_file actions with exact path and full content.",
      "If files or folders must be removed, include delete_path actions only for exact paths already discovered by earlier search/list/read results.",
      "If dependencies must be installed or scripts must run, include run_command actions with exact commands.",
      "Use only commands that already exist in the repo or package scripts. Do not invent lint/test scripts.",
      "Do not use unresolved template placeholders like {{...}}. Avoid long-running server/dev commands for verification.",
      "search_files accepts only { query } and is recursive across nested folders while skipping node_modules/.git/dist/build noise.",
      "delete_path accepts only { path } with a concrete previously discovered path.",
      "Do not use git commands unless the project is clearly a git repository.",
      "In verification/remediation, use only package scripts that already exist, lightweight node checks, or commands that already succeeded earlier in the workflow.",
      "Do not repeat a command that already failed earlier in the workflow.",
      "Do not return an empty actions array.",
      issues.length > 0 ? `Fix these issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}` : "",
      "",
      `[Task]\n${state.task}`,
      "",
      `[Phase]\n${phase}`,
      "",
      `[Previous Plan JSON]\n${plan.raw_response || JSON.stringify(plan, null, 2)}`,
      "",
      `[Project Context]\n${this.projectContext || "(none)"}`,
    ].join("\n");

    const raw = await callAIOnce(settings, repairPrompt, 1400, { throwOnError: true });
    const repaired = parsePlannerPlan(raw);
    if (!repaired || repaired.kind !== plan.kind) {
      return null;
    }

    const repairedActions = plannerPlanToActions(repaired);
    if (repairedActions.length === 0) {
      return null;
    }

    repaired.summary = `${this.planSummary(repaired)} (repaired actions)`;
    return repaired;
  }

  private buildDeterministicCleanupDiscoveryPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const actions: WorkflowPlanAction[] = [
      {
        tool: "list_dir",
        args: { path: PROJECT_ROOT_TOKEN },
        reason: "List the project root to understand the current structure before cleanup.",
      },
      ...this.cleanupSearchQueries().slice(0, 8).map((query) => ({
        tool: "search_files" as const,
        args: { query },
        reason: `Search for cleanup candidates matching ${query}.`,
      })),
    ];

    return {
      kind: "DiscoverySpec",
      version: 1,
      summary: "Discover concrete cleanup candidates before deleting anything.",
      steps: [
        { id: "inspect_root", title: "Inspect root", description: "List the project root before cleanup." },
        { id: "find_candidates", title: "Find candidates", description: "Search for safe removable cache, log, temp, and backup files." },
      ],
      tools: ["list_dir", "search_files"],
      expected_output: "Concrete removable candidate paths.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      scope_hint: "local_multi_file",
      targets: state.explicitTargets,
      path_patterns: [],
      content_patterns: [],
      actions,
    };
  }

  private buildDeterministicTargetDeleteDiscoveryPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const queries = this.explicitDeleteTargetQueries(state);
    return {
      kind: "DiscoverySpec",
      version: 1,
      summary: "Discover the exact target paths before deleting anything.",
      steps: [],
      tools: ["list_dir", "search_files"],
      expected_output: "Exact paths matching the requested deletion target.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      scope_hint: "single_file",
      targets: state.explicitTargets,
      path_patterns: queries,
      content_patterns: [],
      actions: [
        {
          tool: "list_dir",
          args: { path: PROJECT_ROOT_TOKEN },
          reason: "Inspect the project root before targeted deletion.",
        },
        ...queries.map((query) => ({
          tool: "search_files" as const,
          args: { query },
          reason: `Find the exact path for ${query}.`,
        })),
      ],
    };
  }

  private buildDeterministicTargetDeleteExecutionPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const candidates = this.discoveredExplicitDeleteTargets(state).slice(0, 8);

    if (candidates.length === 0) {
      return {
        kind: "FailureReport",
        version: 1,
        summary: "The requested deletion target could not be found.",
        steps: [],
        tools: ["search_files"],
        expected_output: "Stop instead of guessing a delete path.",
        timeout_ms: 5000,
        retry_policy: { max_attempts: 1, retry_on: [] },
        failure_summary: "No concrete file path was discovered for the requested deletion target.",
        manual_next_steps: ["Provide the exact relative path or restore the file if it was already removed."],
      };
    }

    return {
      kind: "ExecutionPlan",
      version: 1,
      summary: "Delete the exact discovered target paths.",
      steps: [],
      tools: ["delete_path"],
      expected_output: "The requested target file paths are removed.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      files_to_modify: candidates,
      commands: [],
      actions: candidates.map((path) => ({
        tool: "delete_path" as const,
        args: { path },
        reason: `Delete requested target ${path}.`,
        mutable: true,
      })),
    };
  }

  private buildDeterministicTargetDeleteVerificationPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const queries = this.explicitDeleteTargetQueries(state);
    return {
      kind: "VerificationPlan",
      version: 1,
      summary: "Verify that the requested target no longer exists.",
      steps: [],
      tools: ["search_files", "list_dir"],
      expected_output: "Confirmation that the requested file is absent.",
      timeout_ms: 15000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      acceptance_criteria: ["The requested target path is no longer present in the project."],
      actions: [
        ...queries.map((query) => ({
          tool: "search_files" as const,
          args: { query },
          reason: `Check whether ${query} still exists.`,
        })),
        {
          tool: "list_dir",
          args: { path: PROJECT_ROOT_TOKEN },
          reason: "Re-list the project root after targeted deletion.",
        },
      ],
    };
  }

  private buildDeterministicCleanupExecutionPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const candidates = this.discoveredCleanupCandidates(state).slice(0, 8);

    if (candidates.length === 0) {
      return {
        kind: "VerificationPlan",
        version: 1,
        summary: "No safe cleanup candidates were discovered. Verify project state and stop.",
        steps: [],
        tools: ["list_dir"],
        expected_output: "Confirmation that there are no obvious safe junk files left to remove.",
        timeout_ms: 15000,
        retry_policy: { max_attempts: 1, retry_on: [] },
        acceptance_criteria: ["No safe removable junk files remain."],
        actions: [
          {
            tool: "list_dir",
            args: { path: PROJECT_ROOT_TOKEN },
            reason: "Re-list the project root after cleanup discovery.",
          },
        ],
      };
    }

    return {
      kind: "ExecutionPlan",
      version: 1,
      summary: "Delete only the concrete cleanup candidates discovered earlier.",
      steps: [],
      tools: ["delete_path"],
      expected_output: "Exact safe junk files removed from the project.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      files_to_modify: candidates,
      commands: [],
      actions: candidates.map((path) => ({
        tool: "delete_path" as const,
        args: { path },
        reason: `Delete discovered cleanup candidate ${path}.`,
        mutable: true,
      })),
    };
  }

  private buildDeterministicCleanupVerificationPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const remaining = this.discoveredCleanupCandidates(state);
    const candidateQueries = Array.from(new Set(
      remaining.length > 0
        ? remaining.map((path) => path.split("/").pop() || path)
        : this.cleanupSearchQueries().slice(0, 4),
    )).slice(0, 4);

    return {
      kind: "VerificationPlan",
      version: 1,
      summary: remaining.length === 0
        ? "Verify cleanup outcome after removing the discovered junk files."
        : "Verify whether cleanup candidates still remain after deletion attempts.",
      steps: [],
      tools: ["list_dir", "search_files"],
      expected_output: "The remaining project structure and any cleanup candidates still present.",
      timeout_ms: 15000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      acceptance_criteria: ["No safe removable junk files remain."],
      actions: [
        {
          tool: "list_dir",
          args: { path: PROJECT_ROOT_TOKEN },
          reason: "Inspect the current project root after cleanup actions.",
        },
        ...candidateQueries.map((query) => ({
          tool: "search_files" as const,
          args: { query },
          reason: `Check whether cleanup candidate ${query} still exists.`,
        })),
      ],
    };
  }

  private batchedDiscoveryActions(state: WorkflowStateEnvelope): WorkflowPlanAction[] {
    const fileQueries = new Set<string>(["package.json", "app.js", "server.js", "index.js"]);
    const contentQueries = new Set<string>();
    const keywordHints = this.workflowKeywordHints(state.task);

    if (/\bexpress\b/i.test(state.task)) contentQueries.add("express");
    if (/\bpackage\.json\b/i.test(state.task)) fileQueries.add("package.json");

    for (const target of state.explicitTargets) {
      const parts = target.split(/[\\/]/);
      const query = parts[parts.length - 1]?.trim();
      if (query) fileQueries.add(query);
    }

    for (const query of keywordHints.fileQueries) {
      fileQueries.add(query);
    }

    for (const query of keywordHints.contentQueries) {
      contentQueries.add(query);
    }

    const actions: WorkflowPlanAction[] = [
      {
        tool: "list_dir",
        args: { path: PROJECT_ROOT_TOKEN },
        reason: "List the project root once before deeper inspection.",
      },
      ...Array.from(fileQueries).slice(0, 6).map((query) => ({
        tool: "search_files" as const,
        args: { query },
        reason: `Search for ${query}.`,
      })),
      ...Array.from(contentQueries).slice(0, 4).map((query) => ({
        tool: "search_in_files" as const,
        args: { query, max_results: "25" },
        reason: `Search file contents for ${query}.`,
      })),
    ];

    return actions;
  }

  private buildDeterministicDiscoveryPlan(state: WorkflowStateEnvelope): PlannerPlan {
    if (this.workflowTaskIsTargetedDeletion(state)) {
      return this.buildDeterministicTargetDeleteDiscoveryPlan(state);
    }
    if (this.workflowTaskNeedsDeletion(state.task)) {
      return this.buildDeterministicCleanupDiscoveryPlan(state);
    }

    return {
      kind: "DiscoverySpec",
      version: 1,
      summary: "Discover the project structure, key config files, and likely entry points in one batched pass.",
      steps: [
        { id: "discover_root", title: "Inspect root", description: "List the project root and identify obvious entry points." },
        { id: "discover_config", title: "Find config", description: "Search for package.json and related setup files." },
        { id: "discover_entry", title: "Find entry files", description: "Search for common server or app entry files." },
      ],
      tools: ["list_dir", "search_files", "search_in_files"],
      expected_output: "Root contents, package/dependency clues, and candidate entry files.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      scope_hint: "local_multi_file",
      targets: state.explicitTargets,
      path_patterns: ["package.json", "app.js", "server.js", "index.js"],
      content_patterns: /\bexpress\b/i.test(state.task) ? ["express"] : [],
      actions: this.batchedDiscoveryActions(state),
    };
  }

  private getReadWorkflowFiles(state: WorkflowStateEnvelope): string[] {
    const files = new Set<string>();
    for (const snapshot of state.snapshots) {
      for (const result of snapshot.tool_results) {
        if (result.tool === "batch_read" || result.tool === "read_file") {
          for (const artifact of result.artifacts) {
            files.add(artifact);
          }
        }
      }
    }
    return Array.from(files);
  }

  private buildDeterministicContextPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const resolvedFiles = this.getResolvedWorkflowFiles(state);
    const readFiles = this.getReadWorkflowFiles(state);
    const sufficient = this.isWorkflowContextReady(state);
    const requiredFiles = this.workflowMinFilesRequired(state);
    const missing: string[] = [];

    if (resolvedFiles.length < requiredFiles) {
      missing.push(`Need at least ${requiredFiles} relevant files but only found ${resolvedFiles.length}.`);
    }
    if (readFiles.length === 0) {
      missing.push("Relevant files have not been read yet.");
    }
    if (state.explicitTargets.length > 0 && !sufficient) {
      missing.push("Not all explicit file or symbol targets were resolved.");
    }

    return {
      kind: "ContextPlan",
      version: 1,
      summary: sufficient
        ? "Context is sufficient. The agent can move to execution."
        : "Context is still incomplete. Read the discovered files before execution.",
      steps: [
        { id: "check_targets", title: "Check targets", description: "Confirm the relevant files and symbols have been located." },
        { id: "check_reads", title: "Check reads", description: "Ensure enough files have been read to support execution." },
      ],
      tools: [],
      expected_output: sufficient ? "Context is sufficient." : "List of missing context items.",
      timeout_ms: 5000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      scope_hint: "local_multi_file",
      sufficiency: sufficient ? "sufficient" : "insufficient",
      missing,
      actions: [],
    };
  }

  private buildDeterministicReadPlan(state: WorkflowStateEnvelope): PlannerPlan {
    const resolvedFiles = this.getResolvedWorkflowFiles(state);
    const alreadyRead = new Set(this.getReadWorkflowFiles(state));
    const files = resolvedFiles
      .filter((file) => !alreadyRead.has(file))
      .slice(0, state.thresholds.maxReadFiles);
    const fallbackQueries = Array.from(new Set([
      ...state.explicitTargets.map((target) => target.split(/[\\/]/).pop() || target),
      "package.json",
      "app.js",
      "server.js",
      "index.js",
    ].filter(Boolean))).slice(0, 5);
    const actions: WorkflowPlanAction[] = files.length > 0
      ? [{
        tool: "batch_read",
        args: { paths: files.join("\n") },
        reason: "Read all discovered relevant files together.",
      }]
      : fallbackQueries.map((query) => ({
        tool: "search_files" as const,
        args: { query },
        reason: `Search again for ${query} before reading files.`,
      }));

    return {
      kind: "ReadPlan",
      version: 1,
      summary: "Read the discovered files in one batched pass before execution.",
      steps: [
        { id: "read_candidates", title: "Read candidates", description: "Batch-read the discovered files relevant to the task." },
      ],
      tools: ["batch_read"],
      expected_output: "The relevant file contents needed for execution planning.",
      timeout_ms: 30000,
      retry_policy: { max_attempts: 1, retry_on: [] },
      scope_hint: "local_multi_file",
      files,
      symbols: state.explicitTargets.filter((target) => !target.includes(".")),
      actions,
    };
  }

  private repeatedPlannerLoop(state: WorkflowStateEnvelope, phase: WorkflowPhase, plan: PlannerPlan): boolean {
    const visible = this.visibleWorkflowSnapshots(state.snapshots).slice(-3);
    if (visible.length < 2) return false;
    return visible.every((snapshot) =>
      snapshot.phase === phase &&
      snapshot.plan?.kind === plan.kind &&
      snapshot.summary === plan.summary &&
      snapshot.tool_results.length === 0,
    );
  }

  private async requestWorkflowPlan(
    settings: AISettings,
    state: WorkflowStateEnvelope,
    phase: WorkflowPhase,
    latestUserMessage: string,
  ): Promise<PlannerPlan | null> {
    if (phase === "discovery") {
      return this.buildDeterministicDiscoveryPlan(state);
    }

    if (phase === "context_validation") {
      return this.buildDeterministicContextPlan(state);
    }

    if (phase === "read") {
      return this.buildDeterministicReadPlan(state);
    }

    if (this.workflowTaskIsTargetedDeletion(state) && phase === "execution") {
      return this.buildDeterministicTargetDeleteExecutionPlan(state);
    }

    if (this.workflowTaskIsTargetedDeletion(state) && (phase === "verification" || phase === "remediation")) {
      return this.buildDeterministicTargetDeleteVerificationPlan(state);
    }

    if (this.workflowTaskNeedsDeletion(state.task) && phase === "execution") {
      return this.buildDeterministicCleanupExecutionPlan(state);
    }

    if (this.workflowTaskNeedsDeletion(state.task) && (phase === "verification" || phase === "remediation")) {
      return this.buildDeterministicCleanupVerificationPlan(state);
    }

    const prompt = buildWorkflowPlannerPrompt({
      phase,
      task: state.task,
      projectContext: this.projectContext,
      workflowState: state,
      latestResults: this.getLatestWorkflowResults(state),
      latestInputs: state.collectedInputs,
      latestUserMessage,
    });

    const raw = await callAIOnce(settings, prompt, 1200, { throwOnError: true });
    const parsed = parsePlannerPlan(raw);
    if (!parsed) return null;

    if ("scope_hint" in parsed && parsed.scope_hint) {
      state.thresholds = {
        ...state.thresholds,
        ...(parsed.scope_hint === "single_file" ? { minFilesCovered: 1, maxReadFiles: 3, maxContextChars: 12000 } : {}),
        ...(parsed.scope_hint === "local_multi_file" ? { minFilesCovered: 3, maxReadFiles: 6, maxContextChars: 18000 } : {}),
        ...(parsed.scope_hint === "broad" ? { minFilesCovered: 5, maxReadFiles: 8, maxContextChars: 24000 } : {}),
      };
    }

    if (parsed.kind === "ReadPlan") {
      parsed.files = parsed.files.slice(0, state.thresholds.maxReadFiles);
    }

    if (
      (phase === "execution" || phase === "verification" || phase === "remediation") &&
      (parsed.kind === "DiscoverySpec" || parsed.kind === "ContextPlan" || parsed.kind === "ReadPlan")
    ) {
      return {
        kind: "FailureReport",
        version: 1,
        summary: `Planner returned ${parsed.kind} during ${phase}.`,
        steps: [],
        tools: [],
        expected_output: "Stop the loop instead of repeating discovery.",
        timeout_ms: 5000,
        retry_policy: { max_attempts: 1, retry_on: [] },
        failure_summary: `Planner returned ${parsed.kind} during ${phase}, which would cause a loop.`,
        manual_next_steps: ["Retry the task with more specific instructions or inspect the planner prompt."],
      };
    }

    return parsed;
  }

  private async executeWorkflowActions(plan: PlannerPlan): Promise<{ results: ExecutorResult[]; denied: boolean }> {
    const actions = plannerPlanToActions(plan).map(toExecutorAction);
    const results: ExecutorResult[] = [];

    for (const action of actions) {
      if (this.agentAborted) {
        return { results, denied: true };
      }

      if (executorActionNeedsApproval(action)) {
        const tc: ToolCall = {
          id: action.id,
          name: action.tool,
          args: action.args,
          status: "pending",
        };
        const toolEl = this.renderToolCall(tc);
        const approved = await this.requestApproval(tc, toolEl);
        if (!approved) {
          tc.status = "denied";
          tc.result = "User denied this action.";
          this.updateToolCallUI(tc);
          return {
            results: [
              ...results,
              {
                actionId: action.id,
                tool: action.tool,
                ok: false,
                output: "",
                artifacts: [],
                error: "User denied this action.",
                durationMs: 0,
              },
            ],
            denied: true,
          };
        }

        tc.status = "running";
        this.updateToolCallUI(tc);
        const result = await executeExecutorAction(action, this.toolExecCtx());
        tc.status = result.ok ? "done" : "error";
        tc.result = result.ok ? result.output : (result.error || "Action failed.");
        this.updateToolCallUI(tc);
        results.push(result);
        continue;
      }

      results.push(await executeExecutorAction(action, this.toolExecCtx()));
    }

    return { results, denied: false };
  }

  private workflowResultDeltas(plan: PlannerPlan, results: ExecutorResult[]): string[] {
    if (results.length === 0) {
      if (plan.kind === "ContextPlan") {
        return plan.sufficiency === "sufficient"
          ? ["Context is sufficient."]
          : (plan.missing.length > 0 ? plan.missing : ["Context is incomplete."]);
      }
      if (plan.kind === "ClarificationPlan") {
        return ["Waiting for user input."];
      }
      return ["No actions were needed for this phase."];
    }
    return results.map((result) => {
      if (result.ok) {
        const artifactSummary = result.artifacts.length ? ` (${result.artifacts.length} artifact${result.artifacts.length === 1 ? "" : "s"})` : "";
        return `${result.tool} succeeded${artifactSummary}`;
      }
      return `${result.tool} failed: ${result.error || "unknown error"}`;
    });
  }

  private async submitWorkflowAnswers(answers: Record<string, string>) {
    if (!this.session.workflowState) return;

    const state = appendWorkflowSnapshot(
      {
        ...this.session.workflowState,
        status: "running",
        pendingQuestions: undefined,
        pendingPhase: undefined,
        collectedInputs: {
          ...this.session.workflowState.collectedInputs,
          ...answers,
        },
      },
      createWorkflowSnapshot(
        this.session.workflowState.pendingPhase || this.session.workflowState.activePhase,
        this.session.workflowState.snapshots.length + 1,
        "done",
        "User supplied clarification answers.",
        {
          inputs: answers,
          deltas: Object.entries(answers).map(([key, value]) => `${key}: ${value}`),
        },
      ),
    );

    await this.saveWorkflowState(state);
    this.renderMessages();
    await this.runWorkflowLoop(this.getAISettings(), "", true);
  }

  private async failWorkflow(
    state: WorkflowStateEnvelope,
    phase: WorkflowPhase,
    summary: string,
    extra: Partial<WorkflowSnapshot> = {},
  ) {
    const failed = appendWorkflowSnapshot(
      {
        ...state,
        status: "failed",
        activePhase: "failed",
      },
      createWorkflowSnapshot(
        phase,
        state.snapshots.length + 1,
        "error",
        summary,
        extra,
      ),
    );
    await this.saveWorkflowState(failed);
    await this.persistWorkflowContextNote(failed, summary);
    this.renderMessages();
  }

  private async runWorkflowLoop(settings: AISettings, latestUserMessage: string, resume = false) {
    this.isStreaming = true;
    this.agentAborted = false;
    this.abortController = new AbortController();
    this.showStopButton(true);

    const awaitingInputContinuation = !resume
      && this.session.workflowState?.status === "awaiting_input"
      && Boolean(latestUserMessage.trim());
    let state = this.currentWorkflowState(latestUserMessage, resume);
    state = {
      ...state,
      task: awaitingInputContinuation ? state.task : (latestUserMessage.trim() || state.task),
      status: "running",
    };
    await this.saveWorkflowState(state);

    try {
      let iterations = 0;
      while (iterations < WORKFLOW_MAX_ITERATIONS) {
        if (this.agentAborted) {
          state = appendWorkflowSnapshot(
            {
              ...state,
              status: "interrupted",
            },
            createWorkflowSnapshot(
              state.activePhase,
              state.snapshots.length + 1,
              "interrupted",
              "Workflow interrupted by user.",
            ),
          );
          await this.saveWorkflowState(state);
          break;
        }

        if (state.status !== "running") break;
        iterations++;

        const phase = state.activePhase;
        let plan = await this.requestWorkflowPlan(settings, state, phase, latestUserMessage || state.task);
        if (!plan) {
          await this.failWorkflow(state, phase, "Workflow planner returned an invalid plan.");
          break;
        }

        if (this.repeatedPlannerLoop(state, phase, plan)) {
          await this.failWorkflow(state, phase, "Planner repeated the same no-op phase. Workflow stopped to avoid a request loop.", {
            plan,
          });
          break;
        }

        if (plan.kind === "ClarificationPlan") {
          if (!plan.questions || plan.questions.length === 0) {
            await this.failWorkflow(state, phase, "ClarificationPlan returned without concrete questions.", {
              plan,
            });
            break;
          }
          const summary = this.planSummary(plan);
          state = appendWorkflowSnapshot(
            {
              ...state,
              status: "awaiting_input",
              pendingQuestions: plan.questions,
              pendingPhase: phase,
              latestSummary: summary,
            },
            createWorkflowSnapshot(
              phase,
              state.snapshots.length + 1,
              "awaiting_input",
              summary,
              { plan },
            ),
          );
          await this.saveWorkflowState(state);
          break;
        }

        if (plan.kind === "FailureReport") {
          const report = plan as FailureReport;
          await this.failWorkflow(state, phase, report.failure_summary || this.planSummary(report), {
            plan,
            deltas: report.manual_next_steps || [],
          });
          break;
        }

        const effectivePhase = this.workflowPhaseForPlan(plan, phase);
        let plannedActions = plannerPlanToActions(plan);
        let actionIssues = this.workflowPlanActionIssues(plan, state);

        if (actionIssues.length > 0 && plan.kind !== "ContextPlan") {
          const repaired = await this.repairPlannerActions(settings, state, effectivePhase, plan, actionIssues);
          if (repaired) {
            plan = repaired;
            plannedActions = plannerPlanToActions(plan);
            actionIssues = this.workflowPlanActionIssues(plan, state);
          }
        }

        if (plan.kind === "ExecutionPlan" && !this.isWorkflowContextReady(state)) {
          state = appendWorkflowSnapshot(
            {
              ...state,
              activePhase: "context_validation",
            },
            createWorkflowSnapshot(
              "context_validation",
              state.snapshots.length + 1,
              "error",
              "Planner attempted execution before context thresholds were met.",
              {
                plan,
                deltas: ["Returning to context validation."],
              },
            ),
          );
          await this.saveWorkflowState(state);
          continue;
        }

        if (plannedActions.length === 0 && plan.kind !== "ContextPlan") {
          const repaired = await this.repairPlannerActions(settings, state, effectivePhase, plan);
          if (repaired) {
            plan = repaired;
            plannedActions = plannerPlanToActions(plan);
            actionIssues = this.workflowPlanActionIssues(plan, state);
          }
        }

        if (actionIssues.length > 0 && plan.kind !== "ContextPlan") {
          await this.failWorkflow(state, effectivePhase, `Planner returned invalid ${plan.kind} actions.`, {
            plan,
            deltas: actionIssues,
          });
          break;
        }

        if (plannedActions.length === 0 && plan.kind !== "ContextPlan") {
          await this.failWorkflow(state, effectivePhase, `Planner returned ${plan.kind} without executable actions.`, {
            plan,
            deltas: this.planDebugLines(plan),
          });
          break;
        }

        state = appendWorkflowSnapshot(
          {
            ...state,
            activePhase: effectivePhase,
          },
          createWorkflowSnapshot(
            effectivePhase,
            state.snapshots.length + 1,
            "running",
            this.planSummary(plan),
            {
              plan,
              inputs: state.collectedInputs,
              deltas: plannedActions.length > 0
                ? [`Running ${plannedActions.length} batched action${plannedActions.length === 1 ? "" : "s"}.`]
                : ["Evaluating current context."],
            },
          ),
        );
        await this.saveWorkflowState(state);

        const actionRun = await this.executeWorkflowActions(plan);
        const resultSnapshot = createWorkflowSnapshot(
          effectivePhase,
          state.snapshots.length + 1,
          actionRun.denied ? "interrupted" : actionRun.results.every((result) => result.ok) ? "done" : "error",
          this.planSummary(plan),
          {
            plan,
            inputs: state.collectedInputs,
            tool_results: actionRun.results,
            deltas: this.workflowResultDeltas(plan, actionRun.results),
          },
        );

        state = appendWorkflowSnapshot(
          {
            ...state,
            latestSummary: summarizeWorkflowState(state),
          },
          resultSnapshot,
        );

        if (actionRun.denied) {
          state = {
            ...state,
            status: "interrupted",
            latestSummary: "Workflow paused because an action was denied.",
          };
          await this.saveWorkflowState(state);
          this.renderMessages();
          break;
        }

        const allOk = actionRun.results.every((result) => result.ok);

        if (!allOk && effectivePhase !== "verification" && effectivePhase !== "remediation") {
          state = {
            ...state,
            activePhase: effectivePhase === "execution" ? "remediation" : "context_validation",
          };
          await this.saveWorkflowState(state);
          continue;
        }

        if (effectivePhase === "discovery") {
          state = { ...state, activePhase: "context_validation" };
        } else if (effectivePhase === "context_validation") {
          if (plan.kind === "ContextPlan" && plan.sufficiency === "sufficient" && this.isWorkflowContextReady(state)) {
            state = { ...state, activePhase: "execution" };
          } else {
            state = { ...state, activePhase: "read" };
          }
        } else if (effectivePhase === "read") {
          state = { ...state, activePhase: "context_validation" };
        } else if (effectivePhase === "execution") {
          state = { ...state, activePhase: "verification" };
        } else if (effectivePhase === "verification") {
          if (allOk) {
            if (!this.targetedDeleteObjectiveSatisfied(state)) {
              await this.failWorkflow(
                state,
                effectivePhase,
                "Verification ran, but the requested delete target still appears to exist.",
                {
                  plan,
                  deltas: ["For targeted delete tasks, verification only passes when search confirms the target is gone."],
                },
              );
              break;
            }
            if (!this.cleanupObjectiveSatisfied(state, actionRun.results)) {
              await this.failWorkflow(
                state,
                effectivePhase,
                "Verification ran, but cleanup was not completed because no file deletions were confirmed.",
                {
                  plan,
                  deltas: ["For cleanup tasks, verification cannot pass until delete_path succeeds or there are explicitly no candidate files to delete."],
                },
              );
              break;
            }
            state = appendWorkflowSnapshot(
              {
                ...state,
                status: "completed",
                activePhase: "complete",
                latestSummary: "Workflow complete. Verification passed.",
              },
              createWorkflowSnapshot(
                "complete",
                state.snapshots.length + 1,
                "done",
                "Workflow complete. Verification passed.",
              ),
            );
            await this.saveWorkflowState(state);
            await this.persistWorkflowContextNote(state, "Workflow complete. Verification passed.");
            this.renderMessages();
            break;
          }

          if (state.retryCount >= WORKFLOW_MAX_RETRIES) {
            state = {
              ...state,
              latestSummary: "Verification failed repeatedly. Requesting failure report.",
            };
          } else {
            state = {
              ...state,
              retryCount: state.retryCount + 1,
              activePhase: "remediation",
            };
          }
        } else if (effectivePhase === "remediation") {
          state = { ...state, activePhase: "verification" };
        }

        await this.saveWorkflowState(state);
      }

      if (iterations >= WORKFLOW_MAX_ITERATIONS && state.status === "running") {
        await this.failWorkflow(state, state.activePhase, `Workflow reached the ${WORKFLOW_MAX_ITERATIONS}-iteration limit.`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.failWorkflow(
        state,
        state.activePhase,
        `Workflow request failed during ${workflowPhaseLabel(state.activePhase).toLowerCase()}: ${msg}`,
        {
          deltas: [msg],
        },
      );
    } finally {
      this.isStreaming = false;
      this.agentAborted = false;
      this.abortController = null;
      this.showStopButton(false);
      this.sendBtn.removeAttribute("disabled");
      this.sendBtn.textContent = "Send";
      this.session.updatedAt = Date.now();
      await saveSession(this.session);
      this.renderSessionList();
      this.scrollToBottom();
    }
  }

  // ── Agent Mode (agentic loop with tool calls) ──

  private async runAgentLoop(settings: AISettings) {
    const lastUserMsg = [...this.session.messages].reverse().find((m) => m.role === "user")?.content || "";
    await this.runWorkflowLoop(settings, lastUserMsg);
    return;

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
        } catch (e: any) {
          const name = e instanceof Error ? e.name : "";
          if (name === "AbortError") {
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
            } catch (e: any) {
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
