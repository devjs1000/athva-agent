import { open } from "@tauri-apps/plugin-dialog";
import { getProjects, addProject, removeProject } from "./store/projects";
import { FileExplorer } from "./modules/file-explorer";
import { Editor } from "./modules/editor";
import { SettingsUI, loadSettings, type AppSettings } from "./modules/settings";
import { Chatbot } from "./modules/chatbot";
import { QuickOpen } from "./modules/quick-open";
import { GitStatusBar } from "./modules/git-status";
import { TerminalPanel } from "./modules/terminal";
import { ScriptRunner } from "./modules/script-runner";
import { setOnSendToChat } from "./modules/ai-completer";

// ── State ──
let appSettings: AppSettings;
let editor!: Editor;
let fileExplorer!: FileExplorer;
let settingsUI!: SettingsUI;
let quickOpen!: QuickOpen;
let gitStatus!: GitStatusBar;
let terminal!: TerminalPanel;
let scriptRunner!: ScriptRunner;
let currentProjectPath: string = "";

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
  const project = await addProject(path);
  currentProjectPath = project.path;
  $("workspace-project-name").textContent = project.name;
  showPage("workspace");

  await fileExplorer.loadRoot(project.path);
  quickOpen.setProjectRoot(project.path);
  gitStatus.setProject(project.path);
  terminal.setProject(project.path);
  scriptRunner.setProject(project.path);
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

  if (isVisible) {
    panel.classList.add("hidden");
    resizeHandle.classList.add("hidden");
  } else {
    panel.classList.remove("hidden");
    resizeHandle.classList.remove("hidden");
  }

  setTimeout(() => editor.resize(), 0);
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
}

// ── Init ──
window.addEventListener("DOMContentLoaded", async () => {
  // Load settings
  appSettings = await loadSettings();

  // Init editor
  editor = new Editor("ace-editor", "editor-tabs", "editor-empty");
  editor.applySettings(appSettings.editor);
  editor.setAISettings(() => appSettings.ai);

  // Init file explorer
  fileExplorer = new FileExplorer("file-tree", (path, name) => {
    editor.openFile(path, name);
    fileExplorer.setActiveFile(path);
  });

  // Init settings UI
  settingsUI = new SettingsUI(appSettings, onSettingsChange);

  // Init chatbot
  new Chatbot("chat-messages", "chat-input", "btn-send-chat", "chat-sessions", () => appSettings.ai);

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

  // Init script runner
  scriptRunner = new ScriptRunner(terminal);

  // Init quick open
  quickOpen = new QuickOpen((path, name) => {
    editor.openFile(path, name);
    fileExplorer.setActiveFile(path);
  });

  // Setup resize handles
  setupResizeHandle("sidebar-resize", $("sidebar"), "left");
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
  });
  $("btn-run-script").addEventListener("click", () => scriptRunner.open());
  $("btn-format").addEventListener("click", () => editor.formatDocument());
  $("btn-toggle-terminal").addEventListener("click", () => terminal.toggle());
  $("btn-toggle-chat").addEventListener("click", toggleChat);
  $("btn-close-chat").addEventListener("click", toggleChat);

  // ── Settings buttons ──
  $("btn-close-settings").addEventListener("click", () => showPage("workspace"));

  // ── Global keyboard shortcuts ──
  document.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    const isWorkspace = !$("workspace-page").classList.contains("hidden");

    // Ctrl/Cmd + P → Quick Open
    if (isMod && e.key === "p") {
      e.preventDefault();
      if (isWorkspace && currentProjectPath) {
        quickOpen.open();
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

  // ── Render welcome ──
  renderRecentProjects();
});
