import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
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
import { setOnSendToChat } from "./modules/ai-completer";
import { showConfirmDialog } from "./modules/dialogs";

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
let currentProjectPath: string = "";

interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
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
  const project = await addProject(path);
  currentProjectPath = project.path;
  $("workspace-project-name").textContent = project.name;
  showPage("workspace");

  await fileExplorer.loadRoot(project.path);
  quickOpen.setProjectRoot(project.path);
  globalSearch.setProjectRoot(project.path);
  gitStatus.setProject(project.path);
  sourceControl.setProject(project.path);
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

function ensureChatOpen() {
  const panel = $("chat-panel");
  if (panel.classList.contains("hidden")) {
    toggleChat();
  }
}

function createTitlebarMenu(buttonId: string, items: Array<{ id: string; label: string; onClick: () => void | Promise<void> }>) {
  const button = $(buttonId);
  const menu = document.createElement("div");
  menu.className = "context-menu hidden";

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "context-menu-item";
    el.textContent = item.label;
    el.dataset.menuAction = item.id;
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      await item.onClick();
    });
    menu.appendChild(el);
  });

  document.body.appendChild(menu);

  const closeMenu = () => menu.classList.add("hidden");

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = button.getBoundingClientRect();
    const isHidden = menu.classList.contains("hidden");

    document.querySelectorAll(".context-menu").forEach((el) => {
      if (el !== menu) el.classList.add("hidden");
    });

    if (!isHidden) {
      closeMenu();
      return;
    }

    menu.style.left = `${Math.max(8, rect.right - 200)}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.classList.remove("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node) && e.target !== button) {
      closeMenu();
    }
  });
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
  const chatbot = new Chatbot(
    "chat-messages",
    "chat-input",
    "btn-send-chat",
    "chat-sessions",
    () => appSettings.ai,
    () => appSettings.agentAccess,
    () => currentProjectPath
  );
  chatbot.setMemory(agentMemory, () => appSettings);

  const runAIReview = async (target: "file" | "changes") => {
    if (target === "file") {
      if (!editor.hasOpenFile()) {
        await showConfirmDialog("AI Review", "Open a file first to review it.", "OK");
        return;
      }

      const filePath = editor.getActiveFilePath();
      const fileContent = editor.getActiveFileContent();
      if (!filePath || !fileContent.trim()) {
        await showConfirmDialog("AI Review", "The current file is empty or unavailable.", "OK");
        return;
      }

      const prompt =
        `Review the current file like a senior engineer.\n` +
        `Findings first, ordered by severity.\n` +
        `Focus on bugs, risky behavior, regressions, and missing tests.\n` +
        `If there are no findings, say "No findings" and mention residual risks or testing gaps.\n` +
        `Keep it concise.\n\n` +
        `File: ${filePath}\n\n` +
        `\`\`\`\n${fileContent}\n\`\`\``;

      ensureChatOpen();
      await chatbot.sendExternal(prompt, "chat");
      return;
    }

    if (!currentProjectPath) {
      await showConfirmDialog("AI Review", "Open a project first to review changes.", "OK");
      return;
    }

    try {
      const files = await invoke<GitFileChange[]>("git_changed_files", { path: currentProjectPath });
      if (files.length === 0) {
        await showConfirmDialog("AI Review", "There are no git changes to review.", "OK");
        return;
      }

      let diffStat = "";
      try {
        diffStat = await invoke<string>("git_diff_stat", { path: currentProjectPath });
      } catch {}

      const summary = files
        .map((file) => `${file.staged ? "[staged]" : "[unstaged]"} ${file.status} ${file.path}`)
        .join("\n");

      const diffSections: string[] = [];
      let remaining = 14000;

      for (const file of files) {
        if (remaining <= 0) break;
        const rawDiff = await invoke<string>("git_diff_file", {
          path: currentProjectPath,
          file: file.path,
          staged: file.staged,
        });

        if (!rawDiff.trim()) continue;

        const clippedDiff = rawDiff.length > remaining
          ? `${rawDiff.slice(0, remaining)}\n... [diff truncated]`
          : rawDiff;

        diffSections.push(
          `File: ${file.path} (${file.staged ? "staged" : "unstaged"}, ${file.status})\n\`\`\`diff\n${clippedDiff}\n\`\`\``
        );
        remaining -= clippedDiff.length;
      }

      const prompt =
        `Review the current git changes like a senior engineer.\n` +
        `Findings first, ordered by severity with file references.\n` +
        `Focus on bugs, risky behavior, regressions, and missing tests.\n` +
        `If there are no findings, say "No findings" and mention residual risks or testing gaps.\n` +
        `Keep it concise.\n\n` +
        `Changed files:\n${summary}\n\n` +
        `${diffStat ? `Diff stat:\n${diffStat}\n\n` : ""}` +
        `Diffs${remaining <= 0 ? " (truncated)" : ""}:\n${diffSections.join("\n\n")}`;

      ensureChatOpen();
      await chatbot.sendExternal(prompt, "chat");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await showConfirmDialog("AI Review", `Could not load git changes.\n\n${message}`, "OK");
    }
  };

  // Refresh file explorer when agent writes/creates files
  chatbot.setOnFileChanged((_path: string) => {
    if (currentProjectPath) {
      fileExplorer.loadRoot(currentProjectPath);
    }
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

  // Init quick open
  quickOpen = new QuickOpen((path, name) => {
    editor.openFile(path, name);
    fileExplorer.setActiveFile(path);
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
  createTitlebarMenu("btn-ai-review", [
    {
      id: "file",
      label: `Review Current File`,
      onClick: () => runAIReview("file"),
    },
    {
      id: "changes",
      label: `Review Changes`,
      onClick: () => runAIReview("changes"),
    },
  ]);
  $("btn-toggle-terminal").addEventListener("click", () => terminal.toggle());
  function setActiveTab(tab: "explorer" | "search") {
    $("sidebar-tab-explorer").classList.toggle("active", tab === "explorer");
    $("sidebar-tab-search").classList.toggle("active", tab === "search");
  }

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

  $("btn-toggle-scm").addEventListener("click", () => sourceControl.toggle());
  $("btn-toggle-chat").addEventListener("click", toggleChat);
  $("btn-close-chat").addEventListener("click", toggleChat);

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

  // ── Render welcome ──
  renderRecentProjects();
});
