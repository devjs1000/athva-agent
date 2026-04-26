import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getProjects, addProject, removeProject } from "./store/projects";
import { FileExplorer } from "./modules/file-explorer";
import { Editor } from "./modules/editor";
import {
  SettingsUI,
  loadSettings,
  saveSettings,
  type AppSettings,
  type WorkspaceActionId,
  type WorkspaceActionPlacement,
} from "./modules/settings";
import { showConfirmDialog } from "./modules/dialogs";
import { Chatbot } from "./modules/chatbot";
import { AgentMemory } from "./modules/agent-memory";
import { MemorySettingsUI } from "./modules/memory-settings-ui";
import { QuickOpen } from "./modules/quick-open";
import { GlobalSearch } from "./modules/global-search";
import { GitStatusBar } from "./modules/git-status";
import { SourceControl } from "./modules/source-control";
import { TerminalPanel } from "./modules/terminal";
import { ScriptRunner } from "./modules/script-runner";
import { SidebarTimeWidget } from "./modules/sidebar-time-widget";
import { CodeReviewPanel } from "./modules/code-review-panel";
import { QualityPanel } from "./modules/quality-panel";
import { ExtensionsPanel } from "./modules/extensions-panel";
import { setOnSendToChat } from "./modules/ai-completer";
import { updateStatusBar } from "./modules/token-usage";
import { SnippetsPanel } from "./modules/snippets-panel";
import { createTailwindCompleter, setTailwindEnabled } from "./modules/tailwind-completer";
import { ExportsTracker } from "./modules/exports-tracker";
import { applyTheme, registerMonacoThemeSetter, registerTerminalThemeSetter } from "./modules/theme-engine";

// ── State ──
let appSettings: AppSettings;
let editor!: Editor;
let fileExplorer!: FileExplorer;
let settingsUI!: SettingsUI;
let quickOpen!: QuickOpen;
let globalSearch!: GlobalSearch;
let gitStatus!: GitStatusBar;
let terminal!: TerminalPanel;
let scriptRunner!: ScriptRunner;
let sourceControl!: SourceControl;
let codeReviewPanel!: CodeReviewPanel;
let qualityPanel!: QualityPanel;
let extensionsPanel!: ExtensionsPanel;
let chatbot!: Chatbot;
let snippetsPanel!: SnippetsPanel;
let exportsTracker!: ExportsTracker;
let currentProjectPath: string = "";
let appUnlocked = false;
let lastSecuritySignature = "";
let actionMenuEl: HTMLElement | null = null;

const ACTION_PLACEMENT_LABELS: Record<WorkspaceActionPlacement, string> = {
  "top-left": "Top Left",
  "top-center": "Top Center",
  "top-right": "Top Right",
  "left-sidebar-strip": "Left Sidebar Strip",
  "right-sidebar-strip": "Right Sidebar Strip",
  "bottom-left": "Bottom Left",
  "bottom-center": "Bottom Center",
  "bottom-right": "Bottom Right",
};

const ACTION_PLACEMENT_ORDER: WorkspaceActionPlacement[] = [
  "top-left",
  "top-center",
  "top-right",
  "left-sidebar-strip",
  "right-sidebar-strip",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const ACTION_ITEM_ORDER: WorkspaceActionId[] = [
  "settings",
  "run-script",
  "format",
  "ai-review",
  "quality-panel",
  "extensions-panel",
  "snippets",
  "source-control",
  "terminal",
  "chat",
];

function isEnvFileName(name: string): boolean {
  return /^\.env(\..+)?$/i.test(name.trim());
}

// function base64UrlToBytes(value: string): Uint8Array {
//   const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
//   const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
//   const binary = atob(padded);
//   const out = new Uint8Array(binary.length);
//   for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
//   return out;
// }

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function sha256Base64(input: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", input as any);
  return base64Encode(new Uint8Array(hash));
}

function refreshSecuritySession(settings: AppSettings) {
  const security = settings.security;
  const signature = [
    security.enabled ? "1" : "0",
    security.method || "",
    security.pinHash || "",
    security.pinSalt || "",
    security.fingerprintCredentialId || "",
    security.lockBeforeProjectOpen ? "1" : "0",
    security.protectEnvFiles ? "1" : "0",
  ].join("|");
  if (signature !== lastSecuritySignature) {
    appUnlocked = false;
    lastSecuritySignature = signature;
  }
}

async function ensureUnlocked(reason: string): Promise<boolean> {
  const security = appSettings.security;
  if (!security?.enabled) return true;
  if (appUnlocked) return true;
  return promptUnlock(reason);
}

async function promptUnlock(reason: string): Promise<boolean> {
  const security = appSettings.security;
  if (!security?.enabled) return true;
  const pinConfigured = !!(security.pinSalt && security.pinHash);
  const fpConfigured = !!security.fingerprintCredentialId;
  const allowPin = security.method === "pin" || security.method === "pin_or_fingerprint";
  const allowFp = security.method === "fingerprint" || security.method === "pin_or_fingerprint";
  const canUnlock =
    (allowPin && pinConfigured) ||
    (allowFp && fpConfigured);
  if (!canUnlock) {
    await showConfirmDialog(
      "Unlock Not Configured",
      "Set a PIN and/or fingerprint in Settings > Security to enable locking.",
      "OK"
    );
    return false;
  }
  const ok = await showUnlockDialog(reason);
  if (ok) appUnlocked = true;
  return ok;
}

async function verifyPin(pin: string): Promise<boolean> {
  const security = appSettings.security;
  const salt = security.pinSalt || "";
  const expected = security.pinHash || "";
  if (!salt || !expected) return false;
  const encoded = new TextEncoder().encode(`${salt}:${pin}`);
  const hash = await sha256Base64(encoded);
  return hash === expected;
}

async function verifyFingerprint(): Promise<boolean> {
  const security = appSettings.security;
  if (!security.fingerprintCredentialId) return false;
  return invoke<boolean>("touchid_authenticate", { reason: "Unlock Athva" }).catch(() => false);
}

async function showUnlockDialog(reason: string): Promise<boolean> {
  const overlay = document.getElementById("unlock-dialog")!;
  const titleEl = document.getElementById("unlock-dialog-title")!;
  const msgEl = document.getElementById("unlock-dialog-message")!;
  const pinField = document.getElementById("unlock-pin-field")!;
  const pinEl = document.getElementById("unlock-dialog-pin") as HTMLInputElement;
  const errorEl = document.getElementById("unlock-dialog-error")!;
  const fpHint = document.getElementById("unlock-fp-hint")!;
  const fpHintText = document.getElementById("unlock-fp-hint-text")!;
  const okBtn = document.getElementById("unlock-dialog-ok") as HTMLButtonElement;
  const fpBtn = document.getElementById("unlock-dialog-fingerprint") as HTMLButtonElement;
  const cancelBtn = document.getElementById("unlock-dialog-cancel") as HTMLButtonElement;

  const security = appSettings.security;
  const pinConfigured = !!(security.pinSalt && security.pinHash);
  const fpConfigured = !!security.fingerprintCredentialId;

  const allowPin = security.method === "pin" || security.method === "pin_or_fingerprint";
  const allowFp = security.method === "fingerprint" || security.method === "pin_or_fingerprint";

  pinField.classList.toggle("hidden", !allowPin);
  okBtn.classList.toggle("hidden", !allowPin);
  fpBtn.classList.toggle("hidden", !allowFp);
  fpHint.classList.add("hidden");

  fpBtn.disabled = !(allowFp && fpConfigured);
  okBtn.disabled = !(allowPin && pinConfigured);

  titleEl.textContent = "Unlock";
  msgEl.textContent = reason;
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  pinEl.value = "";

  overlay.classList.remove("hidden");

  return await new Promise((resolve) => {
    const fail = (message: string) => {
      fpHint.classList.add("hidden");
      errorEl.textContent = message;
      errorEl.classList.remove("hidden");
    };

    const onOk = async () => {
      if (!allowPin) return;
      const pin = pinEl.value.trim();
      if (!pin) return fail("Enter your PIN.");
      const ok = await verifyPin(pin).catch(() => false);
      if (!ok) return fail("Incorrect PIN.");
      cleanup();
      resolve(true);
    };

    const onFingerprint = async () => {
      if (!allowFp) return;
      if (!fpConfigured) return fail("Touch ID is not set up in Settings.");
      fpHint.classList.remove("hidden");
      fpHintText.textContent = "Waiting for Touch ID…";
      errorEl.classList.add("hidden");
      const ok = await verifyFingerprint().catch(() => false);
      fpHint.classList.add("hidden");
      if (!ok) return fail("Touch ID verification failed. Try your PIN.");
      cleanup();
      resolve(true);
    };

    const onCancel = () => { cleanup(); resolve(false); };
    const onOverlay = (e: MouseEvent) => { if (e.target === overlay) onCancel(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!okBtn.disabled && !okBtn.classList.contains("hidden")) void onOk();
        else if (!fpBtn.disabled && !fpBtn.classList.contains("hidden")) void onFingerprint();
      }
    };
    const onOkClick = () => void onOk();
    const onFpClick = () => void onFingerprint();

    function cleanup() {
      overlay.classList.add("hidden");
      fpHint.classList.add("hidden");
      okBtn.removeEventListener("click", onOkClick);
      fpBtn.removeEventListener("click", onFpClick);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
    }

    // Auto-trigger fingerprint whenever fp is configured (both fingerprint-only and pin_or_fingerprint)
    if (allowFp && fpConfigured) {
      setTimeout(() => void onFingerprint(), 150);
    } else {
      (allowPin && pinConfigured ? pinEl : cancelBtn).focus();
    }

    okBtn.addEventListener("click", onOkClick);
    fpBtn.addEventListener("click", onFpClick);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

// ── DOM Helpers ──
function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Pages ──
const pages = () => ({
  welcome: $("welcome-page"),
  workspace: $("workspace-page"),
  settings: $("settings-page"),
  createDialog: $("create-dialog"),
});

function showPage(name: "welcome" | "workspace" | "settings") {
  const p = pages();
  p.welcome.classList.add("hidden");
  p.workspace.classList.add("hidden");
  p.settings.classList.add("hidden");
  p.createDialog.classList.add("hidden");
  p[name].classList.remove("hidden");

  if (name === "workspace" && editor) {
    setTimeout(() => editor.resize(), 0);
  }
}

// ── Welcome Page ──
async function renderRecentProjects() {
  const listEl = $("recent-projects");
  const store = await getProjects();
  const projects = store.projects;

  if (projects.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No recent projects</p>`;
    return;
  }

  listEl.innerHTML = projects
    .map(
      (p) => `
    <div class="recent-item" data-path="${escapeHtml(p.path)}">
      <div class="recent-item-info">
        <span class="recent-item-name">${escapeHtml(p.name)}</span>
        <span class="recent-item-path">${escapeHtml(p.path)}</span>
      </div>
      <button class="recent-item-remove" data-remove="${escapeHtml(p.path)}" title="Remove from recent">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
      </button>
    </div>
  `
    )
    .join("");

  listEl.querySelectorAll(".recent-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".recent-item-remove")) return;
      openProject((el as HTMLElement).dataset.path!);
    });
  });

  listEl.querySelectorAll(".recent-item-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await removeProject((btn as HTMLElement).dataset.remove!);
      await renderRecentProjects();
    });
  });
}

// ── Project Opening ──
async function openProject(path: string) {
  if (appSettings.security?.enabled && appSettings.security.lockBeforeProjectOpen) {
    const ok = await ensureUnlocked("Unlock to open project");
    if (!ok) return;
  }
  const project = await addProject(path);
  currentProjectPath = project.path;
  $("workspace-project-name").textContent = project.name;
  showPage("workspace");

  editor.closeAllTabs();
  await fileExplorer.loadRoot(project.path);
  quickOpen.setProjectRoot(project.path);
  globalSearch.setProjectRoot(project.path);
  gitStatus.setProject(project.path);
  sourceControl.setProject(project.path);
  terminal.setProject(project.path);
  scriptRunner.setProject(project.path);
  extensionsPanel.setProject(project.path);
  await snippetsPanel.setProjectPath(project.path);
  void codeReviewPanel.refreshIfOpen();
  void qualityPanel.refresh_if_open();
  void chatbot.setProjectPath(project.path);
  await exportsTracker.onProjectOpen(project.path);
  syncTopBarActionStates();
}

async function handleOpenFolder() {
  const selected = await open({ directory: true, multiple: false, title: "Open Project Folder" });
  if (selected) await openProject(selected as string);
}

function showCreateDialog() {
  const input = $("project-path-input") as HTMLInputElement;
  input.value = "";
  $("create-dialog").classList.remove("hidden");
  input.focus();
}

function hideCreateDialog() {
  $("create-dialog").classList.add("hidden");
}

async function handleBrowsePath() {
  const selected = await open({ directory: true, multiple: false, title: "Select Project Location" });
  if (selected) ($("project-path-input") as HTMLInputElement).value = selected as string;
}

async function handleConfirmCreate() {
  const path = ($("project-path-input") as HTMLInputElement).value.trim();
  if (!path) return;
  hideCreateDialog();
  await openProject(path);
}

// ── Chat Panel Toggle ──
function toggleChat() {
  const panel = $("chat-panel");
  const resizeHandle = $("chat-resize");
  const isVisible = !panel.classList.contains("hidden");
  const trigger = document.getElementById("btn-toggle-chat");

  if (isVisible) {
    panel.classList.add("hidden");
    resizeHandle.classList.add("hidden");
  } else {
    panel.classList.remove("hidden");
    resizeHandle.classList.remove("hidden");
  }
  trigger?.classList.toggle("active", !isVisible);

  setTimeout(() => editor.resize(), 0);
}

function isChatOpen(): boolean {
  return !$("chat-panel").classList.contains("hidden");
}

function syncTopBarActionStates() {
  document.getElementById("btn-toggle-chat")?.classList.toggle("active", isChatOpen());
  document.getElementById("btn-toggle-terminal")?.classList.toggle("active", terminal?.getIsVisible?.() ?? false);
  document.getElementById("btn-toggle-scm")?.classList.toggle("active", sourceControl?.isOpen?.() ?? false);
  document.getElementById("btn-toggle-snippets")?.classList.toggle("active", snippetsPanel?.isVisible?.() ?? false);
}

function renderWorkspaceActionPlacements() {
  const placements = appSettings.workspaceActions.placements;
  ACTION_PLACEMENT_ORDER.forEach((placement) => {
    const zone = document.getElementById(`workspace-action-zone-${placement}`) as HTMLElement | null;
    if (!zone) return;
    const items = ACTION_ITEM_ORDER
      .map((actionId) => {
        if (placements[actionId] !== placement) return null;
        return document.querySelector<HTMLElement>(`.workspace-action-item[data-action-id="${actionId}"]`);
      })
      .filter((item): item is HTMLElement => !!item);

    items.forEach((item) => zone.appendChild(item));
  });
}

async function persistWorkspaceActionPlacement(actionId: WorkspaceActionId, placement: WorkspaceActionPlacement) {
  if (appSettings.workspaceActions.placements[actionId] === placement) return;
  appSettings = {
    ...appSettings,
    workspaceActions: {
      placements: {
        ...appSettings.workspaceActions.placements,
        [actionId]: placement,
      },
    },
  };
  settingsUI.updateSettings(appSettings);
  renderWorkspaceActionPlacements();
  await saveSettings(appSettings);
}

function closeWorkspaceActionMenu() {
  if (!actionMenuEl) return;
  actionMenuEl.classList.add("hidden");
}

function openWorkspaceActionMenu(actionId: WorkspaceActionId, anchorRect: DOMRect) {
  if (!actionMenuEl) return;
  const activePlacement = appSettings.workspaceActions.placements[actionId];
  actionMenuEl.innerHTML = `
    <div class="workspace-action-menu-title">Move Control</div>
    ${ACTION_PLACEMENT_ORDER.map(
      (placement) => `
        <button
          class="workspace-action-menu-option${placement === activePlacement ? " active" : ""}"
          data-action-id="${actionId}"
          data-placement="${placement}"
          type="button"
        >
          <span>${ACTION_PLACEMENT_LABELS[placement]}</span>
          <span class="workspace-action-check">${placement === activePlacement ? "✓" : ""}</span>
        </button>
      `
    ).join("")}
  `;
  const top = Math.min(window.innerHeight - 16, anchorRect.bottom + 8);
  const left = Math.min(window.innerWidth - 220, Math.max(8, anchorRect.left));
  actionMenuEl.style.top = `${top}px`;
  actionMenuEl.style.left = `${left}px`;
  actionMenuEl.classList.remove("hidden");
}

function setupWorkspaceActionCustomization() {
  actionMenuEl = document.createElement("div");
  actionMenuEl.id = "workspace-action-menu";
  actionMenuEl.className = "workspace-action-menu hidden";
  document.body.appendChild(actionMenuEl);

  document.querySelectorAll<HTMLElement>(".workspace-action-item").forEach((item) => {
    const actionId = item.dataset.actionId as WorkspaceActionId | undefined;
    if (!actionId) return;
    const button = item.querySelector("button");
    if (button) {
      const title = button.getAttribute("title") || "";
      if (!title.includes("Right-click to move")) {
        button.setAttribute("title", `${title} • Right-click to move`);
      }
    }
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceActionMenu(actionId, item.getBoundingClientRect());
    });
  });

  document.addEventListener("click", async (event) => {
    const option = (event.target as HTMLElement).closest(".workspace-action-menu-option") as HTMLButtonElement | null;
    if (!option) {
      if (!(event.target as HTMLElement).closest(".workspace-action-menu")) {
        closeWorkspaceActionMenu();
      }
      return;
    }
    const actionId = option.dataset.actionId as WorkspaceActionId;
    const placement = option.dataset.placement as WorkspaceActionPlacement;
    closeWorkspaceActionMenu();
    await persistWorkspaceActionPlacement(actionId, placement);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWorkspaceActionMenu();
  });

  renderWorkspaceActionPlacements();
}

// ── Sidebar Resize ──
function setupResizeHandle(handleId: string, target: HTMLElement, side: "left" | "right") {
  const handle = $(handleId);
  let startX: number;
  let startWidth: number;

  const onMouseMove = (e: MouseEvent) => {
    const dx = e.clientX - startX;
    const newWidth = side === "left" ? startWidth + dx : startWidth - dx;
    target.style.width = `${Math.max(160, Math.min(600, newWidth))}px`;
    editor.resize();
  };

  const onMouseUp = () => {
    handle.classList.remove("active");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = target.getBoundingClientRect().width;
    handle.classList.add("active");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// ── Settings ──
function onSettingsChange(settings: AppSettings) {
  appSettings = settings;
  editor.applySettings(settings.editor);
  setTailwindEnabled(!!settings.editor.tailwindAutocomplete);
  syncChatAutoApproveToggle();
  refreshSecuritySession(settings);
  applyTheme(settings.appearance);
  renderWorkspaceActionPlacements();
}

async function openFileWithGuards(path: string, name: string, line?: number, column?: number) {
  const fileName = name || path.split("/").pop() || "";
  const shouldProtectEnv = appSettings.security?.enabled && appSettings.security.protectEnvFiles;
  const isEnv = isEnvFileName(fileName);
  if (shouldProtectEnv && isEnv) {
    if (!appUnlocked) {
      // Show masked content immediately, then prompt to unlock
      const masked = await invoke<string>("read_env_masked", { path }).catch(() => "********\n");
      editor.openFileWithContent(path, name, masked, true);
      fileExplorer.setActiveFile(path);
    }
    // Always prompt for unlock when clicking an env file with protection enabled
    const ok = await promptUnlock("Unlock to reveal .env secrets");
    if (ok) {
      await editor.reloadFile(path);
    }
    if (line !== undefined) editor.gotoPosition(line, column ?? 1);
    return;
  }
  await editor.openFile(path, name, line, column);
  fileExplorer.setActiveFile(path);
}

function syncChatAutoApproveToggle() {
  const toggle = document.getElementById("chat-auto-approve") as HTMLInputElement | null;
  if (!toggle) return;
  toggle.checked = appSettings.agentAccess.autoApprove;
}

// ── Init ──
window.addEventListener("DOMContentLoaded", async () => {
  // Load settings
  appSettings = await loadSettings();
  refreshSecuritySession(appSettings);

  // Init editor
  editor = new Editor("monaco-editor", "editor-tabs", "editor-empty");
  editor.applySettings(appSettings.editor);
  editor.setAISettings(() => appSettings.ai);
  registerMonacoThemeSetter((theme) => editor.setMonacoTheme(theme));

  // Apply theme after registering the Ace setter so the editor theme is set correctly
  applyTheme(appSettings.appearance);

  // Init snippets panel
  snippetsPanel = new SnippetsPanel("snippets-panel");
  snippetsPanel.onInsert((snippet) => editor.insertSnippet(snippet));
  const snippetsCompleter = snippetsPanel.getCompleter();
  editor.addCompletionProvider(snippetsCompleter.languages, snippetsCompleter.provider);
  setupWorkspaceActionCustomization();

  // Init Tailwind completer
  setTailwindEnabled(!!appSettings.editor.tailwindAutocomplete);
  const twCompleter = createTailwindCompleter();
  editor.addCompletionProvider(twCompleter.languages, twCompleter.provider);

  // Init file explorer
  fileExplorer = new FileExplorer("file-tree", (path, name) => {
    void openFileWithGuards(path, name);
  });

  // Init sidebar time widget
  new SidebarTimeWidget("sidebar-time-widget");

  // Init settings UI
  settingsUI = new SettingsUI(appSettings, onSettingsChange);

  const chatAutoApproveToggle = $("chat-auto-approve") as HTMLInputElement;
  syncChatAutoApproveToggle();
  chatAutoApproveToggle.addEventListener("change", async () => {
    appSettings = {
      ...appSettings,
      agentAccess: {
        ...appSettings.agentAccess,
        autoApprove: chatAutoApproveToggle.checked,
      },
    };
    settingsUI.updateSettings(appSettings);
    await saveSettings(appSettings);
  });

  // Init agent memory
  const agentMemory = new AgentMemory(
    () => appSettings.ai,
    () => currentProjectPath
  );
  await agentMemory.init().catch(() => { });

  const memorySettingsUI = new MemorySettingsUI(
    agentMemory,
    () => appSettings,
    async () => { }
  );

  // Init chatbot
  chatbot = new Chatbot(
    "chat-messages",
    "chat-input",
    "btn-send-chat",
    "chat-sessions",
    () => appSettings.ai,
    () => appSettings.agentAccess,
    () => currentProjectPath
  );
  chatbot.setMemory(agentMemory, () => appSettings);

  // Refresh file explorer and reload open tab when agent writes/creates files
  chatbot.setOnFileChanged((path: string) => {
    if (currentProjectPath) {
      fileExplorer.loadRoot(currentProjectPath);
    }
    // If the changed file is currently open in the editor, reload it
    if (path && editor.getActiveFilePath() === path) {
      editor.reloadFile(path);
    }
  });

  // Wire editor right-click "Ask AI" submenu to chat panel
  editor.setOnAskAI((prompt: string) => {
    const panel = $("chat-panel");
    if (panel.classList.contains("hidden")) toggleChat();
    const chatInput = $("chat-input") as HTMLTextAreaElement;
    chatInput.value = prompt;
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  });

  // Wire "Send to Chat" from editor selection actions
  setOnSendToChat((text: string) => {
    // Open chat panel if hidden
    const panel = $("chat-panel");
    if (panel.classList.contains("hidden")) {
      toggleChat();
    }
    // Prefill the chat input
    const chatInput = $("chat-input") as HTMLTextAreaElement;
    chatInput.value = text;
    chatInput.focus();
    // Move cursor to end
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  });

  // Init git status bar
  gitStatus = new GitStatusBar();

  // Init terminal
  terminal = new TerminalPanel(() => editor.resize());
  registerTerminalThemeSetter((colors, isLight) => terminal.setTheme(colors, isLight));

  // Init script runner
  scriptRunner = new ScriptRunner(terminal);

  // Init source control
  sourceControl = new SourceControl(() => editor.resize(), () => appSettings.ai);

  // Init code review panel
  codeReviewPanel = new CodeReviewPanel(
    () => editor.resize(),
    () => appSettings.ai,
    () => currentProjectPath,
    () => {
      const path = editor.getActiveFilePath();
      const content = editor.getActiveFileContent();
      if (!path || !content.trim()) return null;
      return { path, content };
    },
    (content: string) => editor.setContent(content)
  );

  // Init quality panel
  qualityPanel = new QualityPanel(
    () => editor.resize(),
    () => currentProjectPath
  );
  extensionsPanel = new ExtensionsPanel(
    () => editor.resize(),
    () => currentProjectPath
  );

  // Init quick open
  quickOpen = new QuickOpen((path, name) => {
    void openFileWithGuards(path, name);
  });
  editor.setOnCreateEditorTab(() => {
    if (!currentProjectPath) return;
    quickOpen.open();
  });
  editor.setOnUnlockProtected((path) => {
    void (async () => {
      const ok = await ensureUnlocked("Unlock to reveal secrets");
      if (!ok) return;
      await editor.reloadFile(path);
    })();
  });

  // Init global search
  globalSearch = new GlobalSearch(
    (path, name, line) => {
      void openFileWithGuards(path, name, line);
    },
    (paths) => {
      paths.forEach((p) => editor.reloadFile(p));
      if (currentProjectPath) fileExplorer.loadRoot(currentProjectPath);
    }
  );

  // Setup resize handles
  setupResizeHandle("sidebar-resize", $("sidebar"), "left");
  setupResizeHandle("source-control-resize", $("source-control-panel"), "right");
  setupResizeHandle("review-resize", $("review-panel"), "right");
  setupResizeHandle("quality-resize", $("quality-panel"), "right");
  setupResizeHandle("extensions-resize", $("extensions-panel"), "right");
  setupResizeHandle("chat-resize", $("chat-panel"), "right");

  // ── Welcome page buttons ──
  $("btn-open-folder").addEventListener("click", handleOpenFolder);
  $("btn-create-project").addEventListener("click", showCreateDialog);
  $("btn-browse-path").addEventListener("click", handleBrowsePath);
  $("btn-cancel-create").addEventListener("click", hideCreateDialog);
  $("btn-confirm-create").addEventListener("click", handleConfirmCreate);

  // Create dialog keyboard
  ($("project-path-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConfirmCreate();
    if (e.key === "Escape") hideCreateDialog();
  });
  $("create-dialog").addEventListener("click", (e) => {
    if (e.target === $("create-dialog")) hideCreateDialog();
  });

  // ── Workspace buttons ──
  $("btn-back-home").addEventListener("click", () => {
    showPage("welcome");
    renderRecentProjects();
  });
  $("btn-settings").addEventListener("click", () => {
    settingsUI.updateSettings(appSettings);
    showPage("settings");
    void memorySettingsUI.refresh();
  });
  $("btn-run-script").addEventListener("click", () => scriptRunner.open());
  $("btn-format").addEventListener("click", () => editor.formatDocument());
  $("btn-ai-review").addEventListener("click", () => {
    if (codeReviewPanel.isOpen()) codeReviewPanel.close();
    else codeReviewPanel.open();
  });
  $("btn-quality-panel").addEventListener("click", () => {
    if (qualityPanel.isOpen()) qualityPanel.close();
    else void qualityPanel.open();
  });
  $("btn-extensions-panel").addEventListener("click", () => {
    if (extensionsPanel.isOpen()) extensionsPanel.close();
    else void extensionsPanel.open();
  });
  $("btn-toggle-terminal").addEventListener("click", () => {
    terminal.toggle();
    syncTopBarActionStates();
  });
  function setActiveTab(tab: "explorer" | "search") {
    $("sidebar-tab-explorer").classList.toggle("active", tab === "explorer");
    $("sidebar-tab-search").classList.toggle("active", tab === "search");
  }

  $("btn-refresh-explorer").addEventListener("click", async () => {
    if (currentProjectPath) {
      const btn = $("btn-refresh-explorer");
      btn.classList.add("spinning");
      await fileExplorer.loadRoot(currentProjectPath);
      btn.classList.remove("spinning");
    }
  });

  $("sidebar-tab-explorer").addEventListener("click", () => {
    globalSearch.close();
    setActiveTab("explorer");
  });

  $("sidebar-tab-search").addEventListener("click", () => {
    if (currentProjectPath) {
      globalSearch.open();
      setActiveTab("search");
    }
  });

  $("btn-toggle-snippets").addEventListener("click", () => {
    snippetsPanel.toggle();
    $("snippets-resize").classList.toggle("hidden", !snippetsPanel.isVisible());
    syncTopBarActionStates();
  });
  $("btn-toggle-scm").addEventListener("click", () => {
    sourceControl.toggle();
    syncTopBarActionStates();
  });
  $("btn-toggle-chat").addEventListener("click", () => {
    toggleChat();
    syncTopBarActionStates();
  });
  $("btn-close-chat").addEventListener("click", () => {
    toggleChat();
    syncTopBarActionStates();
  });
  $("btn-edit-context").addEventListener("click", () => chatbot.openContextEditor());

  // ── Settings buttons ──
  $("btn-close-settings").addEventListener("click", () => showPage("workspace"));

  // ── Global keyboard shortcuts ──
  document.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    const isWorkspace = !$("workspace-page").classList.contains("hidden");

    // Ctrl/Cmd + Shift + F → Global Search
    if (isMod && e.shiftKey && e.key === "F") {
      e.preventDefault();
      if (isWorkspace && currentProjectPath) {
        if (globalSearch.isOpen()) {
          globalSearch.close();
          setActiveTab("explorer");
        } else {
          globalSearch.open();
          setActiveTab("search");
        }
      }
      return;
    }

    // Ctrl/Cmd + P → Quick Open
    if (isMod && e.key === "p") {
      e.preventDefault();
      if (isWorkspace && currentProjectPath) {
        quickOpen.open();
      }
      return;
    }

    // Ctrl/Cmd + N → New tab picker
    if (isMod && e.key === "n" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (isWorkspace) {
        editor.openNewTabPicker();
      }
      return;
    }

    // Ctrl/Cmd + F → Find in file (ace handles it, but ensure focus)
    if (isMod && e.key === "f" && !e.shiftKey) {
      if (isWorkspace && editor.hasOpenFile() && !quickOpen.isOpen()) {
        e.preventDefault();
        editor.openSearch();
      }
      return;
    }

    // Shift+Alt+F / Shift+Option+F / Cmd+Shift+I → Format document
    if ((e.shiftKey && e.altKey && e.key === "F") || (isMod && e.shiftKey && e.key === "I")) {
      if (isWorkspace && editor.hasOpenFile()) {
        e.preventDefault();
        editor.formatDocument();
      }
      return;
    }

    // Ctrl/Cmd + H → Replace in file
    if (isMod && e.key === "h") {
      if (isWorkspace && editor.hasOpenFile() && !quickOpen.isOpen()) {
        e.preventDefault();
        editor.openReplace();
      }
      return;
    }

    // Ctrl/Cmd + Shift + G → Toggle Source Control
    if (isMod && e.shiftKey && e.key === "G") {
      e.preventDefault();
      if (isWorkspace) {
        sourceControl.toggle();
      }
      return;
    }

    // Ctrl/Cmd + ` → Toggle terminal
    if (isMod && e.key === "`") {
      e.preventDefault();
      if (isWorkspace) {
        terminal.toggle();
      }
      return;
    }

    // Escape → close quick open
    if (e.key === "Escape" && quickOpen.isOpen()) {
      e.preventDefault();
      quickOpen.close();
      return;
    }
  });

  // ── Exports tracker ──
  exportsTracker = new ExportsTracker();
  const etC = exportsTracker.getCompleter();
  editor.addCompletionProvider(etC.languages, etC.provider);
  const etP = exportsTracker.getPathCompleter();
  editor.addCompletionProvider(etP.languages, etP.provider);
  const etN = exportsTracker.getNamedImportCompleter();
  editor.addCompletionProvider(etN.languages, etN.provider);
  const etM = exportsTracker.getMemberCompleter();
  editor.addCompletionProvider(etM.languages, etM.provider);
  editor.setOnNavigate(async ({ path, content, row, column }) => {
    const target = await exportsTracker.resolveDefinition(path, content, row, column);
    if (!target) return;

    await openFileWithGuards(
      target.path,
      target.path.split("/").pop() || target.path,
      target.line,
      target.column
    );
  });
  editor.setOnHoverInfo(({ path, content, row, column }) =>
    exportsTracker.resolveHoverInfo(path, content, row, column)
  );
  editor.setOnSave((path: string, content: string) => {
    void exportsTracker.onFileSave(path, content);
  });
  fileExplorer.setOnRename((oldPath: string, newPath: string) => {
    void exportsTracker.onFileRenamed(oldPath, newPath);
  });

  // ── Battery monitor ──
  if ("getBattery" in navigator) {
    const battery = await (navigator as any).getBattery();
    function updateBattery(bat: any) {
      const el = $("battery-status");
      const level = Math.round(bat.level * 100);
      const charging: boolean = bat.charging;
      el.classList.remove("hidden");
      el.classList.toggle("battery-low", !charging && level < 20);
      el.classList.toggle("battery-charging", charging);
      const icon = charging
        ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.585 2.568a.5.5 0 0 1 .226.58L8.677 6H11a.5.5 0 0 1 .39.812l-5 6a.5.5 0 0 1-.868-.44L6.677 9H4a.5.5 0 0 1-.39-.812l5-6a.5.5 0 0 1 .975.38z"/></svg>`
        : level <= 10
          ? `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 6h10v4H2V6zm0-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H2zm12 1.5h.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5H14v-3z"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 6h10v4H2V6zm0-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H2zm12 1.5h.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5H14v-3z"/></svg>`;
      el.innerHTML = `${icon}<span>${level}%</span>`;
      el.title = charging ? `Battery: ${level}% (charging)` : `Battery: ${level}%`;
    }
    updateBattery(battery);
    battery.addEventListener("levelchange", () => updateBattery(battery));
    battery.addEventListener("chargingchange", () => updateBattery(battery));
  }

  // ── Token usage status bar ──
  updateStatusBar();
  syncTopBarActionStates();

  // ── Render welcome ──
  await renderRecentProjects();

  const startupPath = await invoke<string | null>("get_startup_open_path").catch(() => null);
  if (startupPath) {
    await openProject(startupPath);
  }
});
