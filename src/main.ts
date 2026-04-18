import { open } from "@tauri-apps/plugin-dialog";
import { getProjects, addProject, removeProject } from "./store/projects";
import { FileExplorer } from "./modules/file-explorer";
import { Editor } from "./modules/editor";
import { SettingsUI, loadSettings, saveSettings, type AppSettings } from "./modules/settings";
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
import { setOnSendToChat } from "./modules/ai-completer";
import { updateStatusBar } from "./modules/token-usage";
import { SnippetsPanel } from "./modules/snippets-panel";
import { createTailwindCompleter, setTailwindEnabled } from "./modules/tailwind-completer";
import { ExportsTracker } from "./modules/exports-tracker";

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
let chatbot!: Chatbot;
let snippetsPanel!: SnippetsPanel;
let exportsTracker!: ExportsTracker;
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

  editor.closeAllTabs();
  await fileExplorer.loadRoot(project.path);
  quickOpen.setProjectRoot(project.path);
  globalSearch.setProjectRoot(project.path);
  gitStatus.setProject(project.path);
  sourceControl.setProject(project.path);
  terminal.setProject(project.path);
  scriptRunner.setProject(project.path);
  await snippetsPanel.setProjectPath(project.path);
  void codeReviewPanel.refreshIfOpen();
  void qualityPanel.refresh_if_open();
  void chatbot.setProjectPath(project.path);
  await exportsTracker.onProjectOpen(project.path);
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
  setTailwindEnabled(!!settings.editor.tailwindAutocomplete);
  syncChatAutoApproveToggle();
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

  // Init editor
  editor = new Editor("ace-editor", "editor-tabs", "editor-empty");
  editor.applySettings(appSettings.editor);
  editor.setAISettings(() => appSettings.ai);

  // Init snippets panel
  snippetsPanel = new SnippetsPanel("snippets-panel");
  snippetsPanel.onInsert((snippet) => editor.insertSnippet(snippet));
  editor.addCompleter(snippetsPanel.getCompleter());

  // Init Tailwind completer
  setTailwindEnabled(!!appSettings.editor.tailwindAutocomplete);
  editor.addCompleter(createTailwindCompleter());

  // Init file explorer
  fileExplorer = new FileExplorer("file-tree", (path, name) => {
    editor.openFile(path, name);
    fileExplorer.setActiveFile(path);
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
  await agentMemory.init().catch(() => {});

  const memorySettingsUI = new MemorySettingsUI(
    agentMemory,
    () => appSettings,
    async () => {}
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

  // Init quick open
  quickOpen = new QuickOpen((path, name) => {
    editor.openFile(path, name);
    fileExplorer.setActiveFile(path);
  });
  editor.setOnCreateEditorTab(() => {
    if (!currentProjectPath) return;
    quickOpen.open();
  });

  // Init global search
  globalSearch = new GlobalSearch(
    (path, name, line) => {
      editor.openFile(path, name, line);
      fileExplorer.setActiveFile(path);
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
  $("btn-ai-review").addEventListener("click", () => void codeReviewPanel.open());
  $("btn-quality-panel").addEventListener("click", () => void qualityPanel.open());
  $("btn-toggle-terminal").addEventListener("click", () => terminal.toggle());
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
    $("btn-toggle-snippets").classList.toggle("active", snippetsPanel.isVisible());
    $("snippets-resize").classList.toggle("hidden", !snippetsPanel.isVisible());
  });
  $("btn-toggle-scm").addEventListener("click", () => sourceControl.toggle());
  $("btn-toggle-chat").addEventListener("click", toggleChat);
  $("btn-close-chat").addEventListener("click", toggleChat);
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
  editor.addCompleter(exportsTracker.getCompleter());
  editor.addCompleter(exportsTracker.getPathCompleter());
  editor.addCompleter(exportsTracker.getNamedImportCompleter());
  editor.addCompleter(exportsTracker.getMemberCompleter());
  editor.setOnNavigate(async ({ path, content, row, column }) => {
    const target = await exportsTracker.resolveDefinition(path, content, row, column);
    if (!target) return;

    await editor.openFile(
      target.path,
      target.path.split("/").pop() || target.path,
      target.line,
      target.column
    );
    fileExplorer.setActiveFile(target.path);
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

  // ── Render welcome ──
  renderRecentProjects();
});
