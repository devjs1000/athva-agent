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
import { ExtensionsPanel, type ExtensionDiagnostic, type ExtensionPreviewPayload } from "./modules/extensions-panel";
import { setOnSendToChat } from "./modules/ai-completer";
import { updateStatusBar } from "./modules/token-usage";
import { SnippetsPanel } from "./modules/snippets-panel";
import { createTailwindCompleter, setTailwindEnabled } from "./modules/tailwind-completer";
import { ExportsTracker } from "./modules/exports-tracker";
import { applyTheme, registerMonacoThemeDefiner, registerMonacoThemeSetter, registerRuntimeThemes, registerTerminalThemeSetter } from "./modules/theme-engine";
import { registerRuntimeFileIconThemes, setActiveRuntimeFileIconTheme } from "./modules/file-icons";
import { setExtensionSnippets } from "./modules/snippet-store";
import { loadInstalledExtensionSupport, type ExtensionCompatibilityIssue, type ExtensionSupportSnapshot, type InstalledExtensionRecord, type ExtensionViewContainer } from "./modules/vscode-extension-support";
import { CommandPalette } from "./modules/command-palette";
import { getOrCreateRuntime, type ExtensionRuntime, type TreeNode } from "./modules/extension-runtime";
import { ProjectSwitcher } from "./modules/project-switcher";
import { DocsWorkspace } from "./modules/docs-workspace";
import { ContextManager } from "./modules/context-manager";
import { ScreenSaver } from "./modules/screen-saver";
import { renderMarkdown } from "./modules/markdown-renderer";

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
let commandPalette!: CommandPalette;
let projectSwitcher!: ProjectSwitcher;
let chatbot!: Chatbot;
let snippetsPanel!: SnippetsPanel;
let exportsTracker!: ExportsTracker;
let docsWorkspace!: DocsWorkspace;
let contextManager!: ContextManager;
let screenSaver!: ScreenSaver;
let currentProjectPath: string = "";
let appUnlocked = false;
let lastSecuritySignature = "";
let actionMenuEl: HTMLElement | null = null;
let extensionSupportByIdentifier = new Map<string, ExtensionSupportSnapshot>();
let installedExtensionRecords: InstalledExtensionRecord[] = [];
const extensionPreviewPayloads = new Map<string, ExtensionPreviewPayload>();
const extensionDiagnosticsByIdentifier = new Map<string, ExtensionDiagnostic[]>();

function recordExtensionDiagnostic(identifier: string, diag: Omit<ExtensionDiagnostic, "timestamp">) {
  const list = extensionDiagnosticsByIdentifier.get(identifier) ?? [];
  const next: ExtensionDiagnostic = { ...diag, timestamp: Date.now() };
  const key = `${next.source}:${next.title}:${next.message}`;
  const deduped = list.filter((d) => `${d.source}:${d.title}:${d.message}` !== key);
  deduped.unshift(next);
  extensionDiagnosticsByIdentifier.set(identifier, deduped.slice(0, 80));
  extensionsPanel?.refreshDetail?.();
}

function getExtensionDiagnostics(identifier: string): ExtensionDiagnostic[] {
  return extensionDiagnosticsByIdentifier.get(identifier) ?? [];
}

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
  "explorer",
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
const starredProjects = new Set<string>(
  JSON.parse(localStorage.getItem("athva-starred") ?? "[]") as string[]
);

function saveStar() {
  localStorage.setItem("athva-starred", JSON.stringify([...starredProjects]));
}

function detectBadge(name: string, path: string): { cls: string; label: string } {
  const lower = (name + path).toLowerCase();
  if (lower.includes("react")) return { cls: "badge-react", label: "REACT" };
  if (lower.includes(".ts") || lower.includes("typescript") || lower.includes("-ts")) return { cls: "badge-ts", label: "TS" };
  if (lower.includes("python") || lower.includes(".py")) return { cls: "badge-py", label: "PY" };
  if (lower.includes("rust") || lower.includes(".rs")) return { cls: "badge-rs", label: "RS" };
  if (lower.includes("golang") || lower.includes("-go")) return { cls: "badge-go", label: "GO" };
  if (lower.includes(".js") || lower.includes("javascript") || lower.includes("express") || lower.includes("node")) return { cls: "badge-js", label: "JS" };
  return { cls: "badge-dir", label: "DIR" };
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

async function renderRecentProjects() {
  const listEl = $("recent-projects");
  const store = await getProjects();

  // Starred first, then by last_opened descending
  const projects = [...store.projects].sort((a, b) => {
    const as = starredProjects.has(a.path) ? 1 : 0;
    const bs = starredProjects.has(b.path) ? 1 : 0;
    if (as !== bs) return bs - as;
    return b.last_opened - a.last_opened;
  });

  if (projects.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No recent projects</p>`;
    return;
  }

  listEl.innerHTML = projects
    .map((p) => {
      const badge = detectBadge(p.name, p.path);
      const isStarred = starredProjects.has(p.path);
      const time = relativeTime(p.last_opened);
      return `
        <div class="recent-item" data-path="${escapeHtml(p.path)}">
          <span class="recent-item-badge ${badge.cls}">${badge.label}</span>
          <div class="recent-item-info">
            <span class="recent-item-name">${escapeHtml(p.name)}</span>
            <span class="recent-item-path">${escapeHtml(p.path)}</span>
          </div>
          <div class="recent-item-right">
            <span class="recent-item-time">${time}</span>
            <button class="recent-item-star${isStarred ? " starred" : ""}" data-star="${escapeHtml(p.path)}" title="Star project" aria-label="Star project">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>
            </button>
            <button class="recent-item-remove" data-remove="${escapeHtml(p.path)}" title="Remove from recent" aria-label="Remove from recent">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  listEl.querySelectorAll(".recent-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".recent-item-remove") || t.closest(".recent-item-star")) return;
      openProject((el as HTMLElement).dataset.path!);
    });
  });

  listEl.querySelectorAll(".recent-item-star").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = (btn as HTMLElement).dataset.star!;
      if (starredProjects.has(path)) {
        starredProjects.delete(path);
      } else {
        starredProjects.add(path);
      }
      saveStar();
      renderRecentProjects();
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

  await editor.closeAllTabs();
  editor.setProjectRoot(project.path);
  docsWorkspace?.close();
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

// ── Clone Repository ──
let cloneProcess: import("@tauri-apps/plugin-shell").Child | null = null;
let clonedProjectPath: string | null = null;

function showCloneDialog() {
  ($("clone-url-input") as HTMLInputElement).value = "";
  ($("clone-dest-input") as HTMLInputElement).value = "";
  $("clone-form").classList.remove("hidden");
  $("clone-progress").classList.add("hidden");
  $("btn-confirm-clone").removeAttribute("disabled");
  $("clone-dialog").classList.remove("hidden");
  setTimeout(() => ($("clone-url-input") as HTMLInputElement).focus(), 50);
}

function hideCloneDialog() {
  $("clone-dialog").classList.add("hidden");
  cloneProcess = null;
  clonedProjectPath = null;
}

async function handleBrowseCloneDest() {
  const selected = await open({ directory: true, multiple: false, title: "Select Clone Destination" });
  if (selected) ($("clone-dest-input") as HTMLInputElement).value = selected as string;
}

function appendCloneOutput(text: string) {
  const out = $("clone-output") as HTMLPreElement;
  const trimmed = text.trimEnd();
  if (!trimmed) return;

  const line = document.createElement("span");
  if (/error:|fatal:|could not/i.test(trimmed)) {
    line.className = "line-err";
  } else if (/cloning into|receiving|resolving|compressing|counting/i.test(trimmed)) {
    line.className = "line-info";
  } else if (/done\.|finished|complete/i.test(trimmed)) {
    line.className = "line-ok";
  }
  line.textContent = trimmed + "\n";
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

async function handleConfirmClone() {
  const url = ($("clone-url-input") as HTMLInputElement).value.trim();
  const dest = ($("clone-dest-input") as HTMLInputElement).value.trim();

  if (!url) {
    ($("clone-url-input") as HTMLInputElement).focus();
    return;
  }
  if (!dest) {
    ($("clone-dest-input") as HTMLInputElement).focus();
    return;
  }

  // Switch to progress view
  $("clone-form").classList.add("hidden");
  $("clone-progress").classList.remove("hidden");
  $("btn-open-cloned").classList.add("hidden");

  const out = $("clone-output") as HTMLPreElement;
  out.innerHTML = "";
  const bar = $("clone-progress-bar");
  bar.style.width = "15%";
  bar.className = "clone-progress-bar";

  appendCloneOutput(`Cloning ${url} into ${dest}…`);

  // Derive expected project folder name from URL
  const repoName = url.replace(/\.git$/, "").split("/").pop() ?? "repo";
  clonedProjectPath = `${dest}/${repoName}`;

  let fakeProgress = 15;
  const progressTick = setInterval(() => {
    if (fakeProgress < 85) {
      fakeProgress += Math.random() * 6;
      bar.style.width = `${Math.min(fakeProgress, 85)}%`;
    }
  }, 600);

  try {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const cmd = Command.create("zsh", ["-l", "-c", `git clone --progress "${url}" "${dest}/${repoName}" 2>&1`], {
      encoding: "utf-8",
    });

    cmd.stdout.on("data", (data: string) => appendCloneOutput(data));
    cmd.stderr.on("data", (data: string) => appendCloneOutput(data));

    cmd.on("close", (payload: { code: number | null }) => {
      clearInterval(progressTick);
      if (payload.code === 0) {
        bar.style.width = "100%";
        bar.classList.add("done");
        appendCloneOutput("✓ Clone complete.");
        $("btn-open-cloned").classList.remove("hidden");
      } else {
        bar.classList.add("error");
        appendCloneOutput(`✗ Clone failed (exit ${payload.code}).`);
        clonedProjectPath = null;
      }
      $("btn-cancel-clone-progress").textContent = "Close";
      cloneProcess = null;
    });

    cmd.on("error", (err: string) => {
      clearInterval(progressTick);
      bar.classList.add("error");
      appendCloneOutput(`✗ Error: ${err}`);
      $("btn-cancel-clone-progress").textContent = "Close";
      cloneProcess = null;
    });

    cloneProcess = await cmd.spawn();
  } catch (e) {
    clearInterval(progressTick);
    bar.classList.add("error");
    appendCloneOutput(`✗ Failed to start git: ${e}`);
    $("btn-cancel-clone-progress").textContent = "Close";
  }
}

async function handleCancelCloneProgress() {
  if (cloneProcess) {
    await cloneProcess.kill();
    cloneProcess = null;
  }
  hideCloneDialog();
}

async function handleOpenCloned() {
  if (!clonedProjectPath) return;
  const path = clonedProjectPath;
  hideCloneDialog();
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

function closeExtensionViewPanel() {
  document.getElementById("ext-view-panel")?.classList.add("hidden");
  document.getElementById("ext-view-panel-resize")?.classList.add("hidden");
  document.querySelectorAll(".ext-view-container-btn").forEach((b) => b.classList.remove("active"));
  activeVcId = null;
}

function panelSide(panelId: string): "left" | "right" {
  return document.getElementById(panelId)?.parentElement?.id === "left-panel-stack" ? "left" : "right";
}

function closePanelsOnSameSide(panelId: string) {
  const side = panelSide(panelId);
  const sameSide = (candidateId: string) => candidateId !== panelId && panelSide(candidateId) === side;

  if (side === "left") {
    $("sidebar").classList.add("hidden");
    $("sidebar-resize").classList.add("hidden");
  }
  if (sameSide("snippets-panel") && snippetsPanel?.isVisible?.()) {
    snippetsPanel.hide();
    document.getElementById("snippets-resize")?.classList.add("hidden");
  }
  if (sameSide("source-control-panel") && sourceControl?.isOpen?.()) sourceControl.toggle();
  if (sameSide("review-panel") && codeReviewPanel?.isOpen?.()) codeReviewPanel.close();
  if (sameSide("quality-panel") && qualityPanel?.isOpen?.()) qualityPanel.close();
  if (sameSide("extensions-panel") && extensionsPanel?.isOpen?.()) extensionsPanel.close();
  if (sameSide("ext-view-panel")) closeExtensionViewPanel();
  if (sameSide("chat-panel") && isChatOpen()) toggleChat();
}

function showExplorerSidebarOnly() {
  toggleSidebar(true);
  if (panelSide("snippets-panel") === "left" && snippetsPanel?.isVisible?.()) {
    snippetsPanel.hide();
    document.getElementById("snippets-resize")?.classList.add("hidden");
  }
  if (panelSide("source-control-panel") === "left" && sourceControl?.isOpen?.()) sourceControl.toggle();
  if (panelSide("review-panel") === "left" && codeReviewPanel?.isOpen?.()) codeReviewPanel.close();
  if (panelSide("quality-panel") === "left" && qualityPanel?.isOpen?.()) qualityPanel.close();
  if (panelSide("extensions-panel") === "left" && extensionsPanel?.isOpen?.()) extensionsPanel.close();
  if (panelSide("ext-view-panel") === "left") closeExtensionViewPanel();
}

function syncTopBarActionStates() {
  document.getElementById("btn-toggle-chat")?.classList.toggle("active", isChatOpen());
  document.getElementById("btn-toggle-terminal")?.classList.toggle("active", terminal?.getIsVisible?.() ?? false);
  document.getElementById("btn-toggle-scm")?.classList.toggle("active", sourceControl?.isOpen?.() ?? false);
  document.getElementById("btn-toggle-snippets")?.classList.toggle("active", snippetsPanel?.isVisible?.() ?? false);
  document.getElementById("btn-toggle-sidebar")?.classList.toggle("active", !$("sidebar").classList.contains("hidden"));
}

function toggleSidebar(force?: boolean) {
  const sidebar = $("sidebar");
  const resizeHandle = $("sidebar-resize");
  const shouldShow = force ?? sidebar.classList.contains("hidden");
  sidebar.classList.toggle("hidden", !shouldShow);
  resizeHandle.classList.toggle("hidden", !shouldShow);
  syncTopBarActionStates();
  setTimeout(() => editor.resize(), 0);
}

function applyPanelSidePlacement(panelId: string, resizeId: string | null, actionId: WorkspaceActionId) {
  const placement = appSettings.workspaceActions.placements[actionId];
  const isLeft = placement === "left-sidebar-strip";
  const panelEl = document.getElementById(panelId);
  const resizeEl = resizeId ? document.getElementById(resizeId) : null;
  if (!panelEl) return;

  if (isLeft) {
    const stack = document.getElementById("left-panel-stack")!;
    stack.appendChild(panelEl);
    if (resizeEl) stack.appendChild(resizeEl);
  } else {
    const workspace = document.getElementById("workspace-main")!;
    if (resizeEl) workspace.appendChild(resizeEl);
    workspace.appendChild(panelEl);
  }
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

  // Reposition panels to match their button's sidebar side
  applyPanelSidePlacement("snippets-panel", "snippets-resize", "snippets");
  applyPanelSidePlacement("source-control-panel", "source-control-resize", "source-control");
  applyPanelSidePlacement("review-panel", "review-resize", "ai-review");
  applyPanelSidePlacement("quality-panel", "quality-resize", "quality-panel");
  applyPanelSidePlacement("extensions-panel", "extensions-resize", "extensions-panel");
  applyPanelSidePlacement("ext-view-panel", "ext-view-panel-resize", "extensions-panel");
  applyPanelSidePlacement("chat-panel", "chat-resize", "chat");
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
  actionMenuEl.classList.remove("hidden");
  const menuWidth = 210;
  const menuHeight = Math.min(360, actionMenuEl.offsetHeight || 320);
  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const preferAbove = spaceBelow < menuHeight + 16 && spaceAbove > spaceBelow;
  const top = preferAbove
    ? Math.max(8, anchorRect.top - menuHeight - 8)
    : Math.min(window.innerHeight - menuHeight - 8, anchorRect.bottom + 8);
  const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, anchorRect.left));
  actionMenuEl.style.top = `${top}px`;
  actionMenuEl.style.left = `${left}px`;
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
function setupResizeHandle(handleId: string, target: HTMLElement, side?: "left" | "right") {
  const handle = $(handleId);
  let startX: number;
  let startWidth: number;

  const onMouseMove = (e: MouseEvent) => {
    const resolvedSide = side ?? (handle.closest("#left-panel-stack") !== null ? "left" : "right");
    const dx = e.clientX - startX;
    const newWidth = resolvedSide === "left" ? startWidth + dx : startWidth - dx;
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
  setActiveRuntimeFileIconTheme(settings.appearance.fileIconTheme || "");
  applyTheme(settings.appearance);
  renderWorkspaceActionPlacements();
  screenSaver?.updateSettings(settings.appearance.screenSaver);
  if (currentProjectPath) {
    void fileExplorer.loadRoot(currentProjectPath);
  }
}

async function reloadInstalledExtensionSupport() {
  const installed = await invoke<InstalledExtensionRecord[]>("list_installed_vscode_extensions", { projectPath: currentProjectPath || "" }).catch(() => []);
  installedExtensionRecords = installed;
  const resolved = await loadInstalledExtensionSupport(installed);
  extensionSupportByIdentifier = resolved.supportByIdentifier;
  registerRuntimeThemes(resolved.runtimeThemes);
  registerRuntimeFileIconThemes(resolved.runtimeFileIconThemes);
  setExtensionSnippets(resolved.snippets);
  commandPalette?.setExtensionCommands(resolved.allCommands);
  renderExtensionViewContainerRail(resolved.allViewContainers);
  editor.registerExtensionLanguages(
    resolved.allLanguages.map((lang) => ({
      extensions: lang.extensions,
      monacoLanguageId: lang.id,
    }))
  );

  let shouldSaveSettings = false;
  if (appSettings.appearance.theme.startsWith("ext-theme-") && !resolved.runtimeThemes.some((theme) => theme.id === appSettings.appearance.theme)) {
    appSettings = {
      ...appSettings,
      appearance: {
        ...appSettings.appearance,
        theme: "dark",
      },
    };
    shouldSaveSettings = true;
  }
  if (appSettings.appearance.fileIconTheme && !resolved.runtimeFileIconThemes.some((theme) => theme.id === appSettings.appearance.fileIconTheme)) {
    appSettings = {
      ...appSettings,
      appearance: {
        ...appSettings.appearance,
        fileIconTheme: "",
      },
    };
    shouldSaveSettings = true;
  }

  setActiveRuntimeFileIconTheme(appSettings.appearance.fileIconTheme || "");
  applyTheme(appSettings.appearance);

  if (currentProjectPath) {
    await snippetsPanel.setProjectPath(currentProjectPath);
    await fileExplorer.loadRoot(currentProjectPath);
  }
  if (shouldSaveSettings) {
    await saveSettings(appSettings);
  }
}

function getExtensionSupport(identifier: string): ExtensionSupportSnapshot | null {
  return extensionSupportByIdentifier.get(identifier) ?? null;
}

function getExtensionSettingsState(identifier: string) {
  const support = extensionSupportByIdentifier.get(identifier);
  if (!support) return null;
  if (!support.colorThemes.length && !support.fileIconThemes.length) return null;
  return {
    identifier,
    displayName: support.displayName,
    colorThemes: support.colorThemes,
    fileIconThemes: support.fileIconThemes,
    currentColorTheme: support.colorThemes.some((theme) => theme.id === appSettings.appearance.theme) ? appSettings.appearance.theme : "",
    currentFileIconTheme: support.fileIconThemes.some((theme) => theme.id === appSettings.appearance.fileIconTheme) ? appSettings.appearance.fileIconTheme : "",
    snippetCount: support.snippetCount,
  };
}

async function saveExtensionSettingsState(
  _identifier: string,
  state: { colorTheme?: string; fileIconTheme?: string }
) {
  let changed = false;
  if (typeof state.colorTheme === "string" && state.colorTheme !== appSettings.appearance.theme) {
    appSettings = {
      ...appSettings,
      appearance: {
        ...appSettings.appearance,
        theme: state.colorTheme || "dark",
      },
    };
    changed = true;
  }
  if (typeof state.fileIconTheme === "string" && state.fileIconTheme !== appSettings.appearance.fileIconTheme) {
    appSettings = {
      ...appSettings,
      appearance: {
        ...appSettings.appearance,
        fileIconTheme: state.fileIconTheme || "",
      },
    };
    changed = true;
  }
  if (!changed) return;
  settingsUI.updateSettings(appSettings);
  setActiveRuntimeFileIconTheme(appSettings.appearance.fileIconTheme || "");
  applyTheme(appSettings.appearance);
  if (currentProjectPath) {
    await fileExplorer.loadRoot(currentProjectPath);
  }
  await saveSettings(appSettings);
}

async function applyExtensionColorTheme(themeId: string) {
  appSettings = {
    ...appSettings,
    appearance: {
      ...appSettings.appearance,
      theme: themeId,
    },
  };
  settingsUI.updateSettings(appSettings);
  applyTheme(appSettings.appearance);
  await saveSettings(appSettings);
}

async function applyExtensionFileIconTheme(themeId: string) {
  appSettings = {
    ...appSettings,
    appearance: {
      ...appSettings.appearance,
      fileIconTheme: themeId,
    },
  };
  settingsUI.updateSettings(appSettings);
  setActiveRuntimeFileIconTheme(themeId);
  if (currentProjectPath) {
    await fileExplorer.loadRoot(currentProjectPath);
  }
  await saveSettings(appSettings);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, duration = 3000) {
  const el = document.getElementById("global-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

let activeVcId: string | null = null;

function renderExtensionViewContainerRail(viewContainers: ExtensionViewContainer[]) {
  const rail = document.getElementById("workspace-action-zone-left-sidebar-strip");
  if (!rail) return;
  rail.querySelectorAll(".ext-view-container-btn").forEach((el) => el.remove());

  for (const vc of viewContainers) {
    const btn = document.createElement("button");
    btn.className = "btn-icon ext-view-container-btn";
    btn.title = vc.title;
    btn.dataset.vcId = vc.id;
    if (vc.iconSvg) {
      btn.innerHTML = vc.iconSvg;
    } else {
      btn.textContent = vc.title.slice(0, 2).toUpperCase();
    }
    btn.addEventListener("click", () => {
      openExtensionViewPanel(vc);
    });
    rail.appendChild(btn);
  }
}

function openExtensionViewPanel(vc: ExtensionViewContainer) {
  const panel = document.getElementById("ext-view-panel");
  const resizeEl = document.getElementById("ext-view-panel-resize");
  const titleEl = document.getElementById("ext-view-panel-title");
  const bodyEl = document.getElementById("ext-view-panel-body");
  if (!panel || !bodyEl) return;

  if (activeVcId === vc.id && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    resizeEl?.classList.add("hidden");
    activeVcId = null;
    document.querySelectorAll(".ext-view-container-btn").forEach((b) => b.classList.remove("active"));
    editor.resize();
    return;
  }

  activeVcId = vc.id;
  closePanelsOnSameSide("ext-view-panel");
  document.querySelectorAll(".ext-view-container-btn").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.vcId === vc.id);
  });

  if (titleEl) titleEl.textContent = vc.title.toUpperCase();

  panel.classList.remove("hidden");
  resizeEl?.classList.remove("hidden");
  editor.resize();

  void loadExtensionViewPanel(vc, bodyEl);
}

async function loadExtensionViewPanel(vc: ExtensionViewContainer, bodyEl: HTMLElement) {
  const snapshot = extensionSupportByIdentifier.get(vc.extensionIdentifier);
  const views = snapshot?.views.filter((v) => v.containerId === vc.id) ?? [];
  const hasNotebookRuntime = !!snapshot?.unsupportedFeatures.some((feature) =>
    feature.toLowerCase().includes("notebook")
  );

  if (hasNotebookRuntime) {
    recordExtensionDiagnostic(vc.extensionIdentifier, {
      source: "extension-view",
      title: "Notebook/Jupyter APIs unsupported",
      message: "Notebook/Jupyter runtime APIs are not implemented in Athva yet. Use Open Marketplace to manage this extension.",
    });
    bodyEl.innerHTML = renderExtViewError(
      snapshot?.displayName ?? vc.extensionIdentifier,
      "Notebook/Jupyter runtime APIs are not implemented in Athva yet. Use Open Marketplace to manage this extension."
    );
    return;
  }

  if (!snapshot?.hasRuntime) {
    bodyEl.innerHTML = renderExtensionViewPanelBody(vc, views, false, snapshot?.displayName ?? vc.extensionIdentifier, vc.extensionIdentifier);
    return;
  }

  // Show loading state while runtime starts
  bodyEl.innerHTML = renderExtViewLoading(vc.title);

  const installed = snapshot ? findInstalledRecord(vc.extensionIdentifier) : null;
  if (!installed) {
    bodyEl.innerHTML = renderExtensionViewPanelBody(vc, views, true, snapshot?.displayName ?? vc.extensionIdentifier, vc.extensionIdentifier);
    return;
  }

  const runtime = getOrCreateRuntime({
    extensionId: vc.extensionIdentifier,
    installPath: installed.install_path,
    mainPath: resolveExtMainPath(installed.install_path, snapshot),
    workspaceFolders: currentProjectPath ? [currentProjectPath] : [],
    configuration: {},
    onStatus: (status, msg) => {
      if (activeVcId !== vc.id) return;
      const el = document.getElementById("ext-view-panel-body");
      if (!el) return;
      if (status === "error") {
        recordExtensionDiagnostic(vc.extensionIdentifier, {
          source: "extension-host",
          title: "Runtime error",
          message: msg ?? "Unknown error",
        });
        el.innerHTML = renderExtViewError(snapshot.displayName, msg ?? "Unknown error");
      }
    },
    onHostError: (message, stack) => {
      recordExtensionDiagnostic(vc.extensionIdentifier, {
        source: "extension-host",
        title: "Host error",
        message,
        stack,
      });
      if (activeVcId !== vc.id) return;
      const el = document.getElementById("ext-view-panel-body");
      if (!el) return;
      el.innerHTML = renderExtViewError(snapshot.displayName, message, stack);
    },
    onViewRegistered: (viewId, viewType) => {
      if (activeVcId !== vc.id) return;
      if (viewType === "webview") {
        recordExtensionDiagnostic(vc.extensionIdentifier, {
          source: "extension-view",
          title: "Webview view unsupported",
          message: "This extension uses a webview UI that cannot be embedded in Athva's sidebar.",
        });
        bodyEl.innerHTML = renderWebviewPlaceholder(snapshot.displayName, vc.extensionIdentifier);
        return;
      }
      void renderLiveTree(viewId, bodyEl, runtime, snapshot, vc);
    },
    onTreeChanged: (viewId) => {
      if (activeVcId !== vc.id) return;
      void renderLiveTree(viewId, bodyEl, runtime, snapshot, vc);
    },
    onNotification: (level, message) => showToast(message, level === "error" ? 5000 : 3000),
  });

  if (runtime.getStatus() === "stopped" || runtime.getStatus() === "error") {
    try {
      await runtime.start();
    } catch {
      recordExtensionDiagnostic(vc.extensionIdentifier, {
        source: "extension-host",
        title: "Failed to start extension host",
        message: "Failed to start extension host. Is Node.js installed?",
      });
      bodyEl.innerHTML = renderExtViewError(snapshot.displayName, "Failed to start extension host. Is Node.js installed?");
      return;
    }
  } else if (runtime.getStatus() === "active") {
    for (const viewId of runtime.getRegisteredViews()) {
      if (!views.some((v) => v.id === viewId)) continue;
      if (runtime.isWebviewView(viewId)) {
        bodyEl.innerHTML = renderWebviewPlaceholder(snapshot.displayName, vc.extensionIdentifier);
      } else {
        await renderLiveTree(viewId, bodyEl, runtime, snapshot, vc);
      }
    }
  }
}

function findInstalledRecord(identifier: string) {
  return installedExtensionRecords.find((e) => e.identifier === identifier) ?? null;
}

function resolveExtMainPath(installPath: string, snapshot: { runtimeMain?: string }): string {
  const main = snapshot.runtimeMain ?? "./dist/extension";
  const normalized = main.replace(/\\/g, "/").replace(/^\.\//, "");
  const withJs = normalized.endsWith(".js") ? normalized : normalized + ".js";
  // VSIX layout: installPath/extension/<main> OR installPath/<main>
  const candidates = [
    `${installPath}/extension/${withJs}`,
    `${installPath}/${withJs}`,
  ];
  return candidates[0];
}

async function renderLiveTree(
  viewId: string,
  bodyEl: HTMLElement,
  runtime: ExtensionRuntime,
  snapshot: { displayName: string; views: Array<{ id: string; name: string }> },
  _vc: ExtensionViewContainer,
) {
  const view = snapshot.views.find((v) => v.id === viewId);
  if (!view) return;

  const nodes = await runtime.getChildren(viewId);
  const existing = bodyEl.querySelector(`[data-view-id="${viewId}"]`);
  const html = renderTreeSection(view.name, viewId, nodes, runtime);
  if (existing) {
    existing.outerHTML = html;
  } else {
    bodyEl.innerHTML = html;
  }

  // Wire expand clicks
  bodyEl.querySelectorAll<HTMLElement>(".ext-tree-node[data-collapsible='1']").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const nodeId = el.dataset.nodeId!;
      const childrenEl = el.querySelector(".ext-tree-children") as HTMLElement | null;
      if (childrenEl) {
        childrenEl.classList.toggle("hidden");
        el.querySelector(".ext-tree-chevron")?.classList.toggle("expanded");
        return;
      }
      el.classList.add("loading");
      const children = await runtime.getChildren(viewId, nodeId);
      el.classList.remove("loading");
      if (children.length) {
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "ext-tree-children";
        childrenDiv.innerHTML = children.map((n) => renderTreeNode(n, 1)).join("");
        el.appendChild(childrenDiv);
        wireTreeExpand(childrenDiv, viewId, runtime);
      }
    });
  });
}

function wireTreeExpand(container: HTMLElement, viewId: string, runtime: ExtensionRuntime) {
  container.querySelectorAll<HTMLElement>(".ext-tree-node[data-collapsible='1']").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const nodeId = el.dataset.nodeId!;
      const childrenEl = el.querySelector(".ext-tree-children") as HTMLElement | null;
      if (childrenEl) {
        childrenEl.classList.toggle("hidden");
        el.querySelector(".ext-tree-chevron")?.classList.toggle("expanded");
        return;
      }
      el.classList.add("loading");
      const children = await runtime.getChildren(viewId, nodeId);
      el.classList.remove("loading");
      if (children.length) {
        const div = document.createElement("div");
        div.className = "ext-tree-children";
        div.innerHTML = children.map((n) => renderTreeNode(n, 1)).join("");
        el.appendChild(div);
        wireTreeExpand(div, viewId, runtime);
      }
    });
  });
}

function renderTreeSection(name: string, viewId: string, nodes: TreeNode[], _runtime: ExtensionRuntime): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const content = nodes.length
    ? nodes.map((n) => renderTreeNode(n, 0)).join("")
    : `<div class="ext-tree-empty">No items</div>`;
  return `<div class="ext-view-section" data-view-id="${esc(viewId)}">
    <div class="ext-view-section-header">
      <svg class="ext-view-chevron expanded" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
      ${esc(name.toUpperCase())}
    </div>
    <div class="ext-tree-content">${content}</div>
  </div>`;
}

function renderTreeNode(node: TreeNode, depth: number): string {
  const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const indent = depth * 12;
  const isCollapsible = node.collapsibleState === 1 || node.collapsibleState === 2;
  const icon = node.iconId
    ? `<span class="ext-tree-codicon codicon-${esc(node.iconId)}"></span>`
    : `<span class="ext-tree-icon-dot"></span>`;
  return `<div class="ext-tree-node" data-node-id="${esc(node.id)}" data-collapsible="${isCollapsible ? 1 : 0}" style="padding-left:${indent + 8}px" title="${esc(node.tooltip ?? "")}">
    ${isCollapsible ? `<svg class="ext-tree-chevron" width="8" height="8" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>` : `<span class="ext-tree-chevron-spacer"></span>`}
    ${icon}
    <span class="ext-tree-label">${esc(node.label)}</span>
    ${node.description ? `<span class="ext-tree-description">${esc(node.description)}</span>` : ""}
  </div>`;
}

function renderWebviewPlaceholder(displayName: string, identifier: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const message = "This extension uses a webview UI that cannot be embedded in Athva's sidebar.";
  return `<div class="ext-view-runtime-state" style="padding:12px">
    <div class="ext-view-runtime-icon-row">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.6"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zm1.5-.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z"/></svg>
      <span>${esc(displayName)}</span>
    </div>
    <p class="ext-view-runtime-desc">${esc(message)}</p>
    <div class="ext-view-runtime-actions">
      <button class="extensions-copy-btn" data-ext-view-action="copy-diagnostic" data-ext-name="${esc(displayName)}" data-ext-message="${esc(message)}">Copy</button>
      <a class="ext-view-marketplace-link" href="#" data-ext-marketplace="${esc(identifier)}" data-ext-name="${esc(displayName)}">Open on Marketplace ↗</a>
    </div>
  </div>`;
}

function renderExtViewLoading(title: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div class="ext-view-loading">
    <div class="ext-view-loading-spinner"></div>
    <span>Starting ${esc(title)}…</span>
  </div>`;
}

function renderExtViewError(name: string, message: string, stack?: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeStack = typeof stack === "string" && stack.trim() ? stack.trim() : "";
  return `<div class="ext-view-runtime-state" style="padding:12px">
    <div class="ext-view-runtime-icon-row">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="ext-view-runtime-svg"><path d="M8 0C3.58 0 0 3.58 0 8s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zM7 11.5v-1h2v1H7zm0-2v-5h2v5H7z"/></svg>
      <span>Error starting ${esc(name)}</span>
    </div>
    <p class="ext-view-runtime-desc">${esc(message)}</p>
    ${safeStack ? `<pre class="extensions-diagnostic-stack">${esc(safeStack)}</pre>` : ""}
    <div class="ext-view-runtime-actions">
      <button class="extensions-copy-btn" data-ext-view-action="copy-diagnostic" data-ext-name="${esc(name)}" data-ext-message="${esc(message)}" data-ext-stack="${esc(safeStack)}">Copy</button>
    </div>
  </div>`;
}

function renderExtensionViewPanelBody(
  _vc: ExtensionViewContainer,
  views: Array<{ id: string; name: string }>,
  hasRuntime: boolean,
  extensionDisplayName: string,
  extensionIdentifier: string,
): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (!views.length) {
    return `<div class="ext-view-empty">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" opacity="0.3"><path d="M1.5 1h13l.5.5v13l-.5.5h-13l-.5-.5v-13l.5-.5zM2 2v12h12V2H2z"/></svg>
      <div>No views declared in this extension</div>
    </div>`;
  }

  const viewSections = views.map((view) => `
    <div class="ext-view-section">
      <div class="ext-view-section-header">
        <svg class="ext-view-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
        ${escape(view.name.toUpperCase())}
      </div>
      <div class="ext-view-content">
        ${hasRuntime
          ? `<div class="ext-view-runtime-state">
              <div class="ext-view-runtime-icon-row">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="ext-view-runtime-svg"><path d="M8 0C3.58 0 0 3.58 0 8s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zM7 11.5v-1h2v1H7zm0-2v-5h2v5H7z"/></svg>
                <span>Runtime required</span>
              </div>
              <p class="ext-view-runtime-desc">
                <strong>${escape(extensionDisplayName)}</strong> populates this view by running Node.js extension code in VS Code's extension host process. Athva does not yet run extension scripts.
              </p>
              <a class="ext-view-marketplace-link" href="#" data-ext-marketplace="${escape(extensionIdentifier)}" data-ext-name="${escape(extensionDisplayName)}">View on Marketplace ↗</a>
            </div>`
          : `<div class="ext-view-passive-note">This view has no runtime dependencies.</div>`
        }
      </div>
    </div>
  `).join("");

  return viewSections;
}

function openExtensionMarketplacePage(identifier: string, displayName: string) {
  const openVsxPath = identifier.split(".").map(encodeURIComponent).join("/");
  editor.openWebTab(`https://open-vsx.org/extension/${openVsxPath}`, `Extension: ${displayName}`);
}

function openExtensionPreviewPage(payload: ExtensionPreviewPayload) {
  extensionPreviewPayloads.set(payload.identifier, payload);
  const rating = payload.averageRating && payload.ratingCount
    ? `${payload.averageRating.toFixed(1)}★ (${payload.ratingCount})`
    : "No ratings";
  const installs = typeof payload.installs === "number" ? payload.installs.toLocaleString() : "Unknown";
  const supported = payload.supportedFeatures.length ? payload.supportedFeatures.join(", ") : "None";
  const unsupported = payload.unsupportedFeatures.length ? payload.unsupportedFeatures.join(", ") : "None";
  const readme = payload.readme?.trim()
    ? renderMarkdown(payload.readme)
    : `<p class="extension-page-empty">No README preview available.</p>`;
  const icon = payload.iconUrl
    ? `<img class="extension-page-icon" src="${escapeHtml(payload.iconUrl)}" alt="" />`
    : `<div class="extension-page-icon extension-page-icon-placeholder">${escapeHtml(payload.displayName.slice(0, 1).toUpperCase())}</div>`;
  const installedLabel = payload.installed ? "Installed" : "Not Installed";
  const installedClass = payload.installed ? "installed" : "not-installed";
  const primaryAction = payload.installed
    ? `<button class="extension-page-primary muted" data-extension-preview-action="uninstall" data-identifier="${escapeHtml(payload.identifier)}">Uninstall</button>`
    : `<button class="extension-page-primary" data-extension-preview-action="install" data-identifier="${escapeHtml(payload.identifier)}" ${payload.downloadUrl ? "" : "disabled"}>Install</button>`;
  const compatibilityHtml = renderExtensionCompatibilityIssues(payload.identifier, payload.compatibilityIssues);
  const featuresHtml = `
    <div class="extension-page-feature-grid">
      <section>
        <h2>Athva Supported Features</h2>
        <ul>${payload.supportedFeatures.length ? payload.supportedFeatures.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>None detected</li>"}</ul>
      </section>
      <section>
        <h2>Not Supported Yet</h2>
        <ul>${payload.unsupportedFeatures.length ? payload.unsupportedFeatures.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : "<li>None detected</li>"}</ul>
      </section>
    </div>
    ${compatibilityHtml}
  `;
  const html = `
    <article class="extension-page">
      <header class="extension-page-hero">
        ${icon}
        <div class="extension-page-title-block">
          <h1>${escapeHtml(payload.displayName)}</h1>
          <div class="extension-page-publisher">${escapeHtml(payload.publisher)} <span>${escapeHtml(payload.identifier)}</span></div>
          <p>${escapeHtml(payload.description || "No description provided.")}</p>
          <div class="extension-page-actions">
            ${primaryAction}
            <span class="extension-page-state ${installedClass}">${installedLabel}</span>
            <button data-extension-preview-action="marketplace" data-identifier="${escapeHtml(payload.identifier)}">Open Marketplace</button>
          </div>
        </div>
      </header>
      <nav class="extension-page-tabs">
        <button class="active" data-extension-page-tab="details">Details</button>
        <button data-extension-page-tab="features">Features</button>
        <button data-extension-page-tab="changelog">Changelog</button>
      </nav>
      <div class="extension-page-content">
        <main class="extension-page-readme">
          <section class="extension-page-tab-panel md-preview-body" data-extension-page-panel="details">${readme}</section>
          <section class="extension-page-tab-panel hidden" data-extension-page-panel="features">${featuresHtml}</section>
          <section class="extension-page-tab-panel hidden" data-extension-page-panel="changelog">
            <h2>Changelog</h2>
            <p class="extension-page-empty">No changelog is available from the installed package metadata.</p>
          </section>
        </main>
        <aside class="extension-page-rail">
          <section>
            <h2>Installation</h2>
            <dl>
              <dt>Identifier</dt><dd>${escapeHtml(payload.identifier)}</dd>
              <dt>Version</dt><dd>${escapeHtml(payload.version)}</dd>
              <dt>Installed</dt><dd>${installedLabel}</dd>
            </dl>
          </section>
          <section>
            <h2>Marketplace</h2>
            <dl>
              <dt>Installs</dt><dd>${escapeHtml(installs)}</dd>
              <dt>Rating</dt><dd>${escapeHtml(rating)}</dd>
            </dl>
          </section>
          <section>
            <h2>Athva Support</h2>
            <dl>
              <dt>Supported</dt><dd>${escapeHtml(supported)}</dd>
              <dt>Unsupported</dt><dd>${escapeHtml(unsupported)}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </article>
  `;
  const safeId = payload.identifier.replace(/[^a-zA-Z0-9._-]/g, "-");
  const path = `athva://extensions/${safeId}`;
  editor.openHtmlTab(path, `Extension: ${payload.displayName}`, html);
}

function renderExtensionCompatibilityIssues(
  identifier: string,
  issues: ExtensionCompatibilityIssue[]
): string {
  if (!issues.length) {
    return `
      <section class="extension-page-compat">
        <div class="extension-page-compat-head">
          <div>
            <h2>Compatibility Diagnostics</h2>
            <p class="extension-page-empty">No known Athva compatibility blockers were detected for this package.</p>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="extension-page-compat">
      <div class="extension-page-compat-head">
        <div>
          <h2>Compatibility Diagnostics</h2>
          <p class="extension-page-empty">These VS Code extension capabilities are not currently supported in Athva.</p>
        </div>
        <button class="extensions-copy-btn" data-extension-preview-action="copy-errors" data-identifier="${escapeHtml(identifier)}">Copy</button>
      </div>
      <div class="extension-page-compat-list">
        ${issues.map((issue) => `
          <article class="extensions-compat-issue">
            <div class="extensions-compat-issue-head">
              <strong>${escapeHtml(issue.title)}</strong>
              <span class="extensions-compat-issue-code">${escapeHtml(issue.code)}</span>
            </div>
            <p>${escapeHtml(issue.summary)}</p>
            <ul class="extensions-support-list">${issue.details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function formatExtensionCompatibilityIssuesForClipboard(
  displayName: string,
  identifier: string,
  issues: ExtensionCompatibilityIssue[]
): string {
  const lines = [
    `Extension: ${displayName}`,
    `Identifier: ${identifier}`,
    "",
    "Unsupported VS Code features in Athva:",
  ];
  for (const issue of issues) {
    lines.push(`- ${issue.title} [${issue.code}]`);
    lines.push(`  ${issue.summary}`);
    for (const detail of issue.details) {
      lines.push(`  • ${detail}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function installExtensionFromPreview(identifier: string) {
  const payload = extensionPreviewPayloads.get(identifier);
  if (!payload || !currentProjectPath || payload.installed || !payload.downloadUrl) return;
  await invoke("install_vscode_extension", {
    projectPath: currentProjectPath,
    publisher: payload.publisher,
    extensionName: payload.extensionName,
    version: payload.version,
    downloadUrl: payload.downloadUrl,
  });
  await reloadInstalledExtensionSupport();
  await extensionsPanel.refresh();
  openExtensionPreviewPage({ ...payload, installed: true });
}

async function uninstallExtensionFromPreview(identifier: string) {
  const payload = extensionPreviewPayloads.get(identifier);
  if (!payload || !payload.installed) return;
  await invoke("uninstall_vscode_extension", { identifier });
  await reloadInstalledExtensionSupport();
  await extensionsPanel.refresh();
  openExtensionPreviewPage({ ...payload, installed: false });
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
  const docRoot = docsWorkspace?.containsPath(path) ? docsWorkspace.getRootPath() : undefined;
  await editor.openFile(path, name, line, column, docRoot);
  fileExplorer.setActiveFile(path);
  if (docRoot) {
    docsWorkspace.setActivePage(path);
  } else if (docsWorkspace?.isOpen()) {
    docsWorkspace.close();
  }
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
  registerMonacoThemeDefiner((name, theme) => editor.defineMonacoTheme(name, theme));

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
  fileExplorer = new FileExplorer(
    "file-tree",
    (path, name) => {
      void openFileWithGuards(path, name);
    },
    (path, name) => {
      if (name === "DOCS") {
        void docsWorkspace.openRoot(path).then((pages) => {
          if (!pages.length) return;
          if (!docsWorkspace.containsPath(editor.getActiveFilePath())) {
            void openFileWithGuards(pages[0].path, pages[0].name);
            return;
          }
          docsWorkspace.setActivePage(editor.getActiveFilePath());
        });
        return;
      }

      if (path.endsWith("/.athva/contexts")) {
        docsWorkspace.close();
        void editor.openContextsView(path);
      }
    }
  );

  docsWorkspace = new DocsWorkspace(
    "docs-sidebar-panel",
    "docs-sidebar-title",
    "docs-pages-list",
    "docs-pages-empty",
    (page) => {
      void openFileWithGuards(page.path, page.name);
    }
  );

  // Init sidebar time widget
  new SidebarTimeWidget("sidebar-time-widget");

  // Init settings UI
  settingsUI = new SettingsUI(appSettings, onSettingsChange);

  // Init screen saver
  screenSaver = new ScreenSaver();
  screenSaver.updateSettings(appSettings.appearance.screenSaver);

  document.addEventListener("athva:screensaver-preview", ((e: CustomEvent) => {
    screenSaver.preview(e.detail);
  }) as EventListener);

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

  contextManager = new ContextManager();

  // Init chatbot
  chatbot = new Chatbot(
    "chat-messages",
    "chat-input",
    "btn-send-chat",
    "chat-sessions",
    () => appSettings.ai,
    () => appSettings.agentAccess,
    () => currentProjectPath,
    contextManager,
  );
  chatbot.setMemory(agentMemory, () => appSettings);
  editor.setContextsViewContext(contextManager, (path, name) => {
    void openFileWithGuards(path, name);
  });
  fileExplorer.setOnResetContexts(async () => {
    await contextManager.resetContexts();
    if (currentProjectPath) {
      await fileExplorer.loadRoot(currentProjectPath);
    }
    await editor.refreshContextsView();
  });
  fileExplorer.setOnInitContexts(async () => {
    await contextManager.initContexts();
    if (currentProjectPath) {
      await fileExplorer.loadRoot(currentProjectPath);
    }
    await editor.refreshContextsView();
  });
  fileExplorer.setOnCompactContexts(async () => {
    await contextManager.compactContexts();
    if (currentProjectPath) {
      await fileExplorer.loadRoot(currentProjectPath);
    }
    await editor.refreshContextsView();
  });

  // Refresh file explorer and reload open tab when agent writes/creates files
  chatbot.setOnFileChanged((path: string) => {
    if (currentProjectPath) {
      fileExplorer.loadRoot(currentProjectPath);
    }
    // If the changed file is currently open in the editor, reload it
    if (path && editor.getActiveFilePath() === path) {
      editor.reloadFile(path);
    }
    if (path?.includes("/.athva/contexts/")) {
      void editor.refreshContextsView();
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
    () => currentProjectPath,
    {
      openInEditor: openExtensionMarketplacePage,
      openPreviewPage: openExtensionPreviewPage,
      getSupport: getExtensionSupport,
      getDiagnostics: getExtensionDiagnostics,
      getSettingsState: getExtensionSettingsState,
      saveSettingsState: saveExtensionSettingsState,
      afterInstallChange: async () => {
        await reloadInstalledExtensionSupport();
      },
      applyColorTheme: async (themeId) => {
        await applyExtensionColorTheme(themeId);
      },
      applyFileIconTheme: async (themeId) => {
        await applyExtensionFileIconTheme(themeId);
      },
    }
  );

  // Init command palette
  commandPalette = new CommandPalette((command) => {
    const ownerSnapshot = [...extensionSupportByIdentifier.values()].find((s) =>
      s.commands.some((c) => c.command === command.command)
    );
    if (ownerSnapshot?.hasRuntime) {
      showToast(`"${command.title}" requires the VS Code extension runtime — not supported in Athva yet.`, 4000);
    } else {
      showToast(`Command "${command.title}" has no handler in Athva.`, 3000);
    }
  });

  await reloadInstalledExtensionSupport();

  // Init quick open
  quickOpen = new QuickOpen((path, name) => {
    void openFileWithGuards(path, name);
  });

  projectSwitcher = new ProjectSwitcher((path) => {
    void openProject(path);
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

  // Extension view panel close button
  document.getElementById("btn-close-ext-view-panel")?.addEventListener("click", () => {
    closeExtensionViewPanel();
    editor.resize();
  });

  // Setup resize handles
  setupResizeHandle("sidebar-resize", $("sidebar"), "left");
  setupResizeHandle("source-control-resize", $("source-control-panel"));
  setupResizeHandle("review-resize", $("review-panel"));
  setupResizeHandle("quality-resize", $("quality-panel"));
  setupResizeHandle("extensions-resize", $("extensions-panel"));
  setupResizeHandle("ext-view-panel-resize", $("ext-view-panel"));
  setupResizeHandle("chat-resize", $("chat-panel"));

  // ── Welcome page buttons ──
  $("btn-open-folder").addEventListener("click", handleOpenFolder);
  $("btn-create-project").addEventListener("click", showCreateDialog);
  $("btn-clone-repo").addEventListener("click", showCloneDialog);
  $("btn-browse-clone-dest").addEventListener("click", handleBrowseCloneDest);
  $("btn-cancel-clone").addEventListener("click", hideCloneDialog);
  $("btn-confirm-clone").addEventListener("click", handleConfirmClone);
  $("btn-cancel-clone-progress").addEventListener("click", handleCancelCloneProgress);
  $("btn-open-cloned").addEventListener("click", handleOpenCloned);
  $("clone-dialog").addEventListener("click", (e) => {
    if (e.target === $("clone-dialog") && !cloneProcess) hideCloneDialog();
  });
  ($("clone-url-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConfirmClone();
    if (e.key === "Escape") hideCloneDialog();
  });
  ($("clone-dest-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleConfirmClone();
    if (e.key === "Escape") hideCloneDialog();
  });
  $("btn-command-palette-welcome").addEventListener("click", () => ($("command-palette-overlay") as HTMLElement).classList.remove("hidden"));
  $("btn-search-files-welcome").addEventListener("click", () => {
    showPage("workspace");
    setTimeout(() => ($("sidebar-tab-search") as HTMLElement)?.click(), 100);
  });
  $("btn-toggle-terminal-welcome").addEventListener("click", () => {
    showPage("workspace");
    setTimeout(() => ($("btn-toggle-terminal") as HTMLElement)?.click(), 100);
  });
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
    else {
      closePanelsOnSameSide("review-panel");
      codeReviewPanel.open();
    }
  });
  $("btn-quality-panel").addEventListener("click", () => {
    if (qualityPanel.isOpen()) qualityPanel.close();
    else {
      closePanelsOnSameSide("quality-panel");
      void qualityPanel.open();
    }
  });
  $("btn-extensions-panel").addEventListener("click", () => {
    if (extensionsPanel.isOpen()) extensionsPanel.close();
    else {
      closePanelsOnSameSide("extensions-panel");
      void extensionsPanel.open();
    }
  });
  $("btn-toggle-terminal").addEventListener("click", () => {
    terminal.toggle();
    syncTopBarActionStates();
  });
  $("btn-toggle-sidebar").addEventListener("click", () => toggleSidebar());
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
    showExplorerSidebarOnly();
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
    if (!snippetsPanel.isVisible()) closePanelsOnSameSide("snippets-panel");
    snippetsPanel.toggle();
    $("snippets-resize").classList.toggle("hidden", !snippetsPanel.isVisible());
    syncTopBarActionStates();
  });
  $("btn-toggle-scm").addEventListener("click", () => {
    if (!sourceControl.isOpen()) closePanelsOnSameSide("source-control-panel");
    sourceControl.toggle();
    syncTopBarActionStates();
  });
  $("btn-toggle-chat").addEventListener("click", () => {
    if (!isChatOpen()) closePanelsOnSameSide("chat-panel");
    toggleChat();
    syncTopBarActionStates();
  });
  $("btn-close-chat").addEventListener("click", () => {
    toggleChat();
    syncTopBarActionStates();
  });
  document.addEventListener("click", (event) => {
    const previewTab = (event.target as HTMLElement).closest("[data-extension-page-tab]") as HTMLElement | null;
    if (previewTab) {
      event.preventDefault();
      const root = previewTab.closest(".extension-page");
      const tab = previewTab.dataset.extensionPageTab;
      root?.querySelectorAll<HTMLElement>("[data-extension-page-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.extensionPageTab === tab);
      });
      root?.querySelectorAll<HTMLElement>("[data-extension-page-panel]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.extensionPagePanel !== tab);
      });
      return;
    }

    const previewAction = (event.target as HTMLElement).closest("[data-extension-preview-action]") as HTMLElement | null;
    if (previewAction) {
      event.preventDefault();
      const identifier = previewAction.dataset.identifier;
      if (!identifier) return;
      const payload = extensionPreviewPayloads.get(identifier);
      const action = previewAction.dataset.extensionPreviewAction;
      if (action === "install") {
        void installExtensionFromPreview(identifier);
      } else if (action === "uninstall") {
        void uninstallExtensionFromPreview(identifier);
      } else if (action === "marketplace" && payload) {
        openExtensionMarketplacePage(identifier, payload.displayName);
      } else if (action === "copy-errors" && payload?.compatibilityIssues.length) {
        void navigator.clipboard.writeText(
          formatExtensionCompatibilityIssuesForClipboard(payload.displayName, payload.identifier, payload.compatibilityIssues)
        ).then(() => {
          showToast(`Copied compatibility errors for ${payload.displayName}.`, 3000);
        }).catch(() => {
          showToast("Failed to copy compatibility errors.", 4000);
        });
      }
      return;
    }

    const extViewAction = (event.target as HTMLElement).closest("[data-ext-view-action]") as HTMLElement | null;
    if (extViewAction) {
      event.preventDefault();
      const action = extViewAction.dataset.extViewAction;
      if (action === "copy-diagnostic") {
        const name = extViewAction.dataset.extName || "Extension";
        const message = extViewAction.dataset.extMessage || "";
        const stack = extViewAction.dataset.extStack || "";
        const text = [
          name,
          message ? `\n${message}` : "",
          stack ? `\n\nStack:\n${stack}` : "",
        ].join("").trim();
        void navigator.clipboard.writeText(text).then(() => {
          showToast("Copied extension diagnostic.", 2500);
        }).catch(() => {
          showToast("Failed to copy extension diagnostic.", 4000);
        });
      }
      return;
    }

    const target = (event.target as HTMLElement).closest("[data-ext-marketplace]") as HTMLElement | null;
    if (!target) return;
    event.preventDefault();
    const identifier = target.dataset.extMarketplace;
    const displayName = target.dataset.extName || identifier;
    if (!identifier) return;
    openExtensionMarketplacePage(identifier, displayName || identifier);
  });
  $("btn-edit-context").addEventListener("click", () => {
    if (!currentProjectPath) return;
    void editor.openContextsView(contextManager.getRootPath());
  });

  // ── Settings buttons ──
  $("btn-close-settings").addEventListener("click", () => showPage("workspace"));

  // ── Global keyboard shortcuts ──
  document.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    const isWorkspace = !$("workspace-page").classList.contains("hidden");

    // Ctrl/Cmd + R → Project Switcher
    if (isMod && e.key === "r" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (projectSwitcher.isOpen()) {
        projectSwitcher.close();
      } else {
        void projectSwitcher.open();
      }
      return;
    }

    // Escape → close project switcher
    if (e.key === "Escape" && projectSwitcher?.isOpen()) {
      e.preventDefault();
      projectSwitcher.close();
      return;
    }

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

    // Ctrl/Cmd + Shift + P → Command Palette
    if (isMod && e.shiftKey && e.key === "P") {
      e.preventDefault();
      if (isWorkspace) commandPalette?.open();
      return;
    }

    // Ctrl/Cmd + P → Quick Open
    if (isMod && e.key === "p" && !e.shiftKey) {
      e.preventDefault();
      if (isWorkspace && currentProjectPath) {
        quickOpen.open();
      }
      return;
    }

    // Ctrl/Cmd + B → Toggle sidebar
    if (isMod && e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (isWorkspace) toggleSidebar();
      return;
    }

    // Ctrl/Cmd + N → New untitled file
    if (isMod && e.key === "n" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (isWorkspace) {
        editor.createUntitledFile();
      }
      return;
    }

    // Ctrl/Cmd + S → Save active file
    if (isMod && e.key.toLowerCase() === "s" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (isWorkspace) {
        void editor.saveActiveTab();
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

    // Ctrl + ` or Cmd + ` → Toggle terminal
    if ((e.ctrlKey && e.key === "`") || (isMod && e.key === "`")) {
      e.preventDefault();
      if (isWorkspace) {
        terminal.toggle();
        syncTopBarActionStates();
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

  // ── Clipboard / selection shortcuts for Monaco (Tauri WKWebView bypass) ──
  // WKWebView on macOS may consume Cmd+A/C/X/V before they reach Monaco's internal
  // event handling. We intercept them here at the document level and forward to the
  // editor only when Monaco has text focus.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (!editor?.hasEditorFocus()) return;
    if (e.key === "a") { e.preventDefault(); editor.selectAll(); }
    else if (e.key === "c") { e.preventDefault(); editor.copySelection(); }
    else if (e.key === "x") { e.preventDefault(); editor.cutSelection(); }
    else if (e.key === "v") { e.preventDefault(); editor.pasteFromClipboard(); }
  }, true); // capture phase — runs before Monaco's own listeners

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
  editor.setOnTabSaved((path: string, _content: string, meta) => {
    if (meta?.created && currentProjectPath) {
      void fileExplorer.loadRoot(currentProjectPath);
      if (docsWorkspace.containsPath(path)) {
        void docsWorkspace.reload().then(() => docsWorkspace.setActivePage(path));
      }
      if (path.includes("/.athva/contexts/")) void editor.refreshContextsView();
    }
  });
  editor.setOnDocLinkNavigate(async (fromPath, href) => {
    const page = docsWorkspace.resolvePageLink(fromPath, href);
    if (!page) return false;
    await openFileWithGuards(page.path, page.name);
    return true;
  });
  fileExplorer.setOnRename((oldPath: string, newPath: string) => {
    void exportsTracker.onFileRenamed(oldPath, newPath);
    if (docsWorkspace.containsPath(oldPath) || docsWorkspace.containsPath(newPath)) {
      void docsWorkspace.reload().then(() => docsWorkspace.setActivePage(newPath));
    }
    if (oldPath.includes("/.athva/contexts/") || newPath.includes("/.athva/contexts/")) {
      void editor.refreshContextsView();
    }
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
