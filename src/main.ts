import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
import { ApiRequestsPanel } from "./modules/api-requests-panel";
import { VoiceCallPanel } from "./modules/voice-call-panel";
import { createTailwindCompleter, setTailwindEnabled } from "./modules/tailwind-completer";
import { ExportsTracker } from "./modules/exports-tracker";
import { applyTheme, registerMonacoThemeDefiner, registerMonacoThemeSetter, registerRuntimeThemes, registerTerminalThemeSetter } from "./modules/theme-engine";
import { registerRuntimeFileIconThemes, setActiveRuntimeFileIconTheme } from "./modules/file-icons";
import { setExtensionSnippets } from "./modules/snippet-store";
import { loadInstalledExtensionSupport, type ExtensionCommand, type ExtensionCompatibilityIssue, type ExtensionSupportSnapshot, type InstalledExtensionRecord, type ExtensionViewContainer } from "./modules/vscode-extension-support";
import { CommandPalette } from "./modules/command-palette";
import { getOrCreateRuntime, getRuntime, type ExtensionRuntime, type RuntimeCompletionItem, type TreeNode } from "./modules/extension-runtime";
import { ProjectSwitcher } from "./modules/project-switcher";
import { DocsWorkspace } from "./modules/docs-workspace";
import { ContextManager } from "./modules/context-manager";
import { ScreenSaver } from "./modules/screen-saver";
import { renderMarkdown } from "./modules/markdown-renderer";
import { initIdeLogsCapture } from "./modules/ide-logs";

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
let apiRequestsPanel!: ApiRequestsPanel;
let voiceCallPanel!: VoiceCallPanel;
let exportsTracker!: ExportsTracker;
let docsWorkspace!: DocsWorkspace;
let contextManager!: ContextManager;
let screenSaver!: ScreenSaver;
let currentProjectPath: string = "";
let appUnlocked = false;
let lastSecuritySignature = "";
let actionMenuEl: HTMLElement | null = null;
let actionMenuContextActionId: WorkspaceActionId = "extensions-panel";
const maximizedPanels = new Set<string>();
let extensionSupportByIdentifier = new Map<string, ExtensionSupportSnapshot>();
let installedExtensionRecords: InstalledExtensionRecord[] = [];
let currentBatteryLevel: number | null = null;
const extensionPreviewPayloads = new Map<string, ExtensionPreviewPayload>();
const extensionDiagnosticsByIdentifier = new Map<string, ExtensionDiagnostic[]>();
let extensionUpdatesByIdentifier = new Map<string, ExtensionUpdateInfo>();
let inlineWebviewAssetBridgeReady = false;
const webviewBridgeRuntimeById = new Map<string, ExtensionRuntime>();
const webviewBridgeViewIdById = new Map<string, string>();
const webviewBridgeIframeSelectorById = new Map<string, string>();
let runtimeCompletionProviderRegistered = false;
let extensionHostGithubToken = "";

async function refreshExtensionHostGithubToken() {
  try {
    const token = await invoke<string | null>("get_secret", { key: "github_token" });
    extensionHostGithubToken = typeof token === "string" ? token.trim() : "";
  } catch {
    extensionHostGithubToken = "";
  }
}

interface GitContributionDay {
  date: string;
  count: number;
}

interface GitLogEntryRaw {
  hash: string;
  short_hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string;
}

interface GitAuthorStatRaw {
  author: string;
  commits: number;
}

interface ExtensionUpdateCheckInput {
  publisher: string;
  extension_name: string;
  version: string;
}

interface ExtensionUpdateInfo {
  identifier: string;
  installed_version: string;
  latest_version: string;
  update_available: boolean;
}

async function syncNativeTranslucentMode(enabled: boolean): Promise<void> {
  try {
    await invoke("set_window_translucent_mode", { enabled });
  } catch {
    // Ignore on unsupported platforms or older builds.
  }
}

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

function inferUnsupportedVscodeApis(message: string, stack?: string): string[] {
  const haystack = `${message || ""}\n${stack || ""}`.toLowerCase();
  const add = new Set<string>();
  const mark = (api: string, needles: string[]) => {
    if (needles.some((needle) => haystack.includes(needle))) add.add(api);
  };

  mark("`vscode.LogLevel`", ["reading 'info'", "loglevel"]);
  mark("`vscode.chat`", ["createchatparticipant", "chatparticipant"]);
  mark("`vscode.lm`", ["registerlanguagemodelchatprovider", "selectchatmodels", ".lm."]);
  mark("`vscode.authentication`", ["registerauthenticationprovider", "getsession", "authentication"]);
  mark("`vscode.debug`", ["registerdebugconfigurationprovider", "startdebugging", "debugadapter"]);
  mark("`vscode.tasks`", ["registertaskprovider", "executetask", "fetchtasks"]);
  mark("`vscode.window.showQuickPick`", ["showquickpick"]);
  mark("`vscode.window.showInputBox`", ["showinputbox"]);
  mark("`vscode.workspace.findFiles`", ["findfiles", "relativepattern"]);
  mark("`vscode.languages` provider APIs", ["registerhoverprovider", "registerdefinitionprovider", "registerrenameprovider", "registersignaturehelpprovider", "registerinlayhintsprovider", "registerdocumentsemantictokensprovider"]);

  if (!add.size && haystack.includes("reading 'bind'")) {
    add.add("Unknown VS Code API object (extension called `.bind` on an undefined API value)");
  }
  return [...add];
}

function withUnsupportedApiHint(message: string, stack?: string): string {
  const inferred = inferUnsupportedVscodeApis(message, stack);
  if (!inferred.length) return message;
  return `${message}\nLikely unsupported/missing VS Code APIs: ${inferred.join(", ")}`;
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
  "api-requests",
  "source-control",
  "terminal",
  "chat",
];

const ACTION_LABELS: Record<WorkspaceActionId, string> = {
  explorer: "Explorer",
  settings: "Settings",
  "run-script": "Run Script",
  format: "Format",
  "ai-review": "AI Review",
  "quality-panel": "Quality Panel",
  "extensions-panel": "Extensions",
  snippets: "Snippets",
  "api-requests": "API Requests",
  "source-control": "Source Control",
  terminal: "Terminal",
  chat: "Chat",
};

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

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isoToDisplay(iso: string): string {
  const dt = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function clampDateRange(from: string, to: string): { from: string; to: string } {
  if (!from && !to) {
    const now = new Date();
    const prev = new Date(now);
    prev.setDate(now.getDate() - 29);
    return { from: toYmd(prev), to: toYmd(now) };
  }
  if (!from) return { from: to, to };
  if (!to) return { from, to: from };
  return from <= to ? { from, to } : { from: to, to: from };
}

function buildContributionHeatmap(last365: GitContributionDay[]): string {
  const byDate = new Map(last365.map((d) => [d.date, d.count]));
  const max = Math.max(1, ...last365.map((d) => d.count));
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 364);

  const cells: string[] = [];
  for (let i = 0; i < 365; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = toYmd(day);
    const count = byDate.get(key) ?? 0;
    const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
    cells.push(`<div class="scm-gh-cell l${level}" title="${escapeHtml(key)}: ${count} commit${count === 1 ? "" : "s"}"></div>`);
  }
  return `<div class="scm-gh-grid">${cells.join("")}</div>`;
}

// ── Git Graph ──────────────────────────────────────────────────────────────

const GG_LANE_W = 12;
const GG_ROW_H = 22;
const GG_MID = GG_ROW_H / 2;
const GG_R = 3.5;
const GG_COLORS = ["#4d9de0","#e15554","#3bb273","#e1bc29","#7768ae","#f4a261","#e76f51","#2a9d8f","#c77dff","#b5838d"];

interface LanedCommit extends GitLogEntryRaw {
  col: number;
  lanesBefore: (string | null)[];
  lanesAfter: (string | null)[];
  mergingLanes: number[];
  newBranchLanes: number[];
}

function ggLaneColor(i: number): string { return GG_COLORS[i % GG_COLORS.length]; }
function ggLaneX(i: number): number { return i * GG_LANE_W + GG_LANE_W / 2; }

function ggAuthorColor(name: string): string {
  let h = 0;
  for (const ch of name) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  return GG_COLORS[h % GG_COLORS.length];
}

function ggInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]?.toUpperCase() ?? "").slice(0, 2).join("");
}

function ggComputeLanes(commits: GitLogEntryRaw[]): LanedCommit[] {
  const lanes: (string | null)[] = [];
  const result: LanedCommit[] = [];
  for (const commit of commits) {
    const lanesBefore = [...lanes];
    let col = lanes.indexOf(commit.hash);
    if (col === -1) { col = lanes.indexOf(null); if (col === -1) { col = lanes.length; lanes.push(null); } }

    const mergingLanes: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== col && lanes[i] === commit.hash) { mergingLanes.push(i); lanes[i] = null; }
    }

    lanes[col] = commit.parents[0] ?? null;

    const newBranchLanes: number[] = [];
    for (let pi = 1; pi < commit.parents.length; pi++) {
      const ph = commit.parents[pi];
      if (!lanes.includes(ph)) {
        const empty = lanes.indexOf(null);
        const nc = empty === -1 ? lanes.length : empty;
        if (empty === -1) lanes.push(ph); else lanes[empty] = ph;
        newBranchLanes.push(nc);
      }
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    result.push({ ...commit, col, lanesBefore, lanesAfter: [...lanes], mergingLanes, newBranchLanes });
  }
  return result;
}

function ggRenderCell(c: LanedCommit): string {
  const { col, lanesBefore, lanesAfter, mergingLanes, newBranchLanes } = c;
  const maxCol = Math.max(lanesBefore.length, lanesAfter.length, col + 1);
  const w = maxCol * GG_LANE_W + GG_LANE_W / 2;
  const els: string[] = [];

  for (let i = 0; i < lanesBefore.length; i++) {
    if (lanesBefore[i] === null) continue;
    const x = ggLaneX(i), cc = ggLaneColor(i);
    if (mergingLanes.includes(i)) {
      const cx = ggLaneX(col);
      els.push(`<path d="M${x},0 Q${x},${GG_MID} ${cx},${GG_MID}" stroke="${cc}" stroke-width="1.5" fill="none"/>`);
    } else {
      els.push(`<line x1="${x}" y1="0" x2="${x}" y2="${GG_MID}" stroke="${cc}" stroke-width="1.5"/>`);
    }
  }
  for (let i = 0; i < lanesAfter.length; i++) {
    if (lanesAfter[i] === null) continue;
    const x = ggLaneX(i), cc = ggLaneColor(i);
    if (newBranchLanes.includes(i)) {
      const cx = ggLaneX(col);
      els.push(`<path d="M${cx},${GG_MID} Q${cx},${GG_ROW_H} ${x},${GG_ROW_H}" stroke="${cc}" stroke-width="1.5" fill="none"/>`);
    } else {
      els.push(`<line x1="${x}" y1="${GG_MID}" x2="${x}" y2="${GG_ROW_H}" stroke="${cc}" stroke-width="1.5"/>`);
    }
  }
  const cc = ggLaneColor(col);
  const isHead = c.refs.includes("HEAD");
  els.push(`<circle cx="${ggLaneX(col)}" cy="${GG_MID}" r="${GG_R}" fill="${cc}" stroke="${isHead ? "#fff" : cc}" stroke-width="${isHead ? 1.5 : 0}"/>`);
  return `<svg width="${w}" height="${GG_ROW_H}" viewBox="0 0 ${w} ${GG_ROW_H}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${els.join("")}</svg>`;
}

function ggParseRefs(refs: string): string {
  if (!refs.trim()) return "";
  return refs.split(",").map(r => {
    r = r.trim();
    let cls = "gg-ref-branch", name = r;
    if (r.startsWith("HEAD -> ")) { cls = "gg-ref-head"; name = r.slice(8); }
    else if (r === "HEAD") { cls = "gg-ref-head"; }
    else if (r.startsWith("tag: ")) { cls = "gg-ref-tag"; name = r.slice(5); }
    else if (r.includes("/")) { cls = "gg-ref-remote"; }
    return `<span class="${cls}">${escapeHtml(name)}</span>`;
  }).join("");
}

async function openGitGraphTool(projectPath: string) {
  const [commits, authorStats] = await Promise.all([
    invoke<GitLogEntryRaw[]>("git_log_graph", { path: projectPath, maxCount: 500 }).catch(() => [] as GitLogEntryRaw[]),
    invoke<GitAuthorStatRaw[]>("git_author_stats", { path: projectPath }).catch(() => [] as GitAuthorStatRaw[]),
  ]);

  const laned = ggComputeLanes(commits);
  const totalCommits = authorStats.reduce((s, a) => s + a.commits, 0) || 1;

  const graphRows = laned.map(c => {
    const svg = ggRenderCell(c);
    const refs = ggParseRefs(c.refs);
    const initials = ggInitials(c.author);
    const avatarColor = ggAuthorColor(c.author);
    return `<tr class="gg-row">
      <td class="gg-graph-col">${svg}</td>
      <td class="gg-hash-col"><span class="gg-hash">${escapeHtml(c.short_hash)}</span></td>
      <td class="gg-msg-col">${refs}<span class="gg-subject">${escapeHtml(c.subject)}</span></td>
      <td class="gg-author-col"><span class="gg-avatar" style="background:${avatarColor}">${escapeHtml(initials)}</span><span class="gg-author-name">${escapeHtml(c.author)}</span></td>
      <td class="gg-date-col">${escapeHtml(c.date)}</td>
    </tr>`;
  }).join("");

  const authorCards = authorStats.slice(0, 40).map(a => {
    const pct = Math.round((a.commits / totalCommits) * 100);
    const barW = Math.max(2, Math.round((a.commits / (authorStats[0]?.commits || 1)) * 100));
    const color = ggAuthorColor(a.author);
    const initials = ggInitials(a.author);
    return `<div class="gg-author-card">
      <div class="gg-avatar gg-avatar-lg" style="background:${color}">${escapeHtml(initials)}</div>
      <div class="gg-author-info">
        <div class="gg-author-card-name">${escapeHtml(a.author)}</div>
        <div class="gg-author-meta">${a.commits} commit${a.commits === 1 ? "" : "s"} · ${pct}% of total</div>
        <div class="gg-bar-track"><div class="gg-bar-fill" style="width:${barW}%;background:${color}"></div></div>
      </div>
    </div>`;
  }).join("");

  const pagePath = `athva://git-graph/${encodeURIComponent(projectPath)}`;
  const html = `<article class="git-graph-tool" data-project-path="${escapeHtml(projectPath)}">
  <style>
    .git-graph-tool{display:flex;flex-direction:column;height:100%;background:#0d1117;color:#c9d1d9;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
    .gg-toolbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #21262d;background:#161b22;flex-shrink:0}
    .gg-title{font-size:13px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#8b949e}
    .gg-tab-bar{display:flex;gap:4px}
    .gg-tab{background:none;border:1px solid transparent;color:#8b949e;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
    .gg-tab.gg-tab-active{background:#21262d;border-color:#30363d;color:#c9d1d9}
    .gg-panel{display:none;flex:1;min-height:0;overflow:auto}
    .gg-panel.gg-panel-active{display:flex;flex-direction:column}
    .gg-table-wrap{overflow:auto;flex:1}
    .gg-table{border-collapse:collapse;width:100%;font-size:12px}
    .gg-row{border-bottom:1px solid #161b22}
    .gg-row:hover{background:#161b22}
    .gg-graph-col{padding:0;white-space:nowrap;vertical-align:middle}
    .gg-hash-col{padding:0 8px;white-space:nowrap;vertical-align:middle}
    .gg-msg-col{padding:2px 8px;vertical-align:middle;max-width:340px}
    .gg-author-col{padding:2px 8px;white-space:nowrap;vertical-align:middle}
    .gg-date-col{padding:2px 8px;white-space:nowrap;vertical-align:middle;color:#8b949e;font-size:11px}
    .gg-hash{font-family:ui-monospace,SFMono-Regular,monospace;color:#58a6ff;font-size:11px}
    .gg-subject{color:#c9d1d9}
    .gg-ref-head,.gg-ref-branch,.gg-ref-remote,.gg-ref-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;margin-right:4px;white-space:nowrap}
    .gg-ref-head{background:#1a3a5c;color:#79c0ff;border:1px solid #1f6feb}
    .gg-ref-branch{background:#1a3a2a;color:#56d364;border:1px solid #238636}
    .gg-ref-remote{background:#2a1f3d;color:#d2a8ff;border:1px solid #6e40c9}
    .gg-ref-tag{background:#3a2a0a;color:#e3b341;border:1px solid #9e6a03}
    .gg-avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-size:10px;font-weight:700;color:#fff;width:20px;height:20px;flex-shrink:0;margin-right:6px;vertical-align:middle}
    .gg-avatar-lg{width:40px;height:40px;font-size:14px;margin-right:12px;flex-shrink:0}
    .gg-author-name{font-size:11px;color:#8b949e;vertical-align:middle}
    .gg-authors-grid{display:flex;flex-direction:column;gap:10px;padding:16px}
    .gg-author-card{display:flex;align-items:center;background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px 14px}
    .gg-author-info{flex:1;min-width:0}
    .gg-author-card-name{font-size:13px;font-weight:600;color:#c9d1d9;margin-bottom:3px}
    .gg-author-meta{font-size:11px;color:#8b949e;margin-bottom:6px}
    .gg-bar-track{background:#21262d;border-radius:999px;height:6px;overflow:hidden}
    .gg-bar-fill{height:100%;border-radius:999px;transition:width .3s}
    .gg-empty{padding:40px;text-align:center;color:#8b949e;font-size:13px}
  </style>
  <div class="gg-toolbar">
    <div class="gg-title">Git Graph · ${escapeHtml(projectPath.split("/").pop() ?? projectPath)}</div>
    <div class="gg-tab-bar">
      <button class="gg-tab gg-tab-active" data-gg-tab="graph">Graph (${commits.length})</button>
      <button class="gg-tab" data-gg-tab="authors">Authors (${authorStats.length})</button>
    </div>
  </div>
  <div class="gg-panel gg-panel-active" data-gg-panel="graph">
    <div class="gg-table-wrap">
      ${graphRows ? `<table class="gg-table"><tbody>${graphRows}</tbody></table>` : `<div class="gg-empty">No commits found.</div>`}
    </div>
  </div>
  <div class="gg-panel" data-gg-panel="authors">
    ${authorCards ? `<div class="gg-authors-grid">${authorCards}</div>` : `<div class="gg-empty">No author data found.</div>`}
  </div>
</article>`;

  editor.openHtmlTab(pagePath, "Git Graph", html);
}

async function openScmContributionTool(projectPath: string, from?: string, to?: string) {
  const range = clampDateRange(from ?? "", to ?? "");
  const now = new Date();
  const since365 = new Date(now);
  since365.setDate(now.getDate() - 364);

  const [rangeDays, yearDays] = await Promise.all([
    invoke<GitContributionDay[]>("git_contribution_days", {
      path: projectPath,
      since: range.from,
      until: range.to,
    }).catch(() => []),
    invoke<GitContributionDay[]>("git_contribution_days", {
      path: projectPath,
      since: toYmd(since365),
      until: toYmd(now),
    }).catch(() => []),
  ]);

  const total = rangeDays.reduce((sum, item) => sum + item.count, 0);
  const activeDays = rangeDays.filter((item) => item.count > 0).length;
  const maxDay = rangeDays.reduce((best, item) => (item.count > best.count ? item : best), { date: "", count: 0 });
  const avg = activeDays ? (total / activeDays).toFixed(2) : "0.00";
  const heatmap = buildContributionHeatmap(yearDays);
  const rows = rangeDays.length
    ? rangeDays
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((item) => `<tr><td>${escapeHtml(isoToDisplay(item.date))}</td><td>${item.count}</td></tr>`)
      .join("")
    : `<tr><td colspan="2">No commits in selected range.</td></tr>`;

  const toolId = `scm-contrib-${encodeURIComponent(projectPath)}`;
  const pagePath = `athva://scm/contributions/${encodeURIComponent(projectPath)}`;
  const html = `
    <article class="scm-contrib-tool" data-scm-tool-id="${toolId}" data-project-path="${escapeHtml(projectPath)}">
      <style>
        .scm-contrib-tool{padding:20px 24px;color:#d7deea;background:#0f141d;min-height:100%;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
        .scm-contrib-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
        .scm-contrib-title{font-size:20px;font-weight:700}
        .scm-contrib-sub{font-size:12px;color:#93a1ba}
        .scm-contrib-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
        .scm-contrib-range input{background:#0c1018;border:1px solid #27334b;color:#dce7ff;border-radius:8px;padding:6px 8px}
        .scm-contrib-range button{background:#1f6feb;border:1px solid #327fe8;color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer}
        .scm-contrib-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}
        .scm-contrib-card{background:#141b28;border:1px solid #263247;border-radius:10px;padding:10px}
        .scm-contrib-card .k{font-size:11px;color:#95a5c3}
        .scm-contrib-card .v{font-size:18px;font-weight:700;color:#eaf0ff}
        .scm-gh-wrap{background:#141b28;border:1px solid #263247;border-radius:10px;padding:12px}
        .scm-gh-grid{display:grid;grid-template-columns:repeat(53,1fr);gap:4px}
        .scm-gh-cell{aspect-ratio:1;border-radius:3px;background:#1a2130}
        .scm-gh-cell.l1{background:#123c2c}.scm-gh-cell.l2{background:#1b5b3f}.scm-gh-cell.l3{background:#2f8a5e}.scm-gh-cell.l4{background:#49b37a}
        .scm-contrib-table{margin-top:14px;background:#141b28;border:1px solid #263247;border-radius:10px;overflow:hidden}
        .scm-contrib-table table{width:100%;border-collapse:collapse}
        .scm-contrib-table th,.scm-contrib-table td{padding:8px 10px;border-bottom:1px solid #202b3f;font-size:12px}
        .scm-contrib-table th{text-align:left;color:#9bb0d2}
      </style>
      <div class="scm-contrib-head">
        <div>
          <div class="scm-contrib-title">GitHub-style Contribution Insights</div>
          <div class="scm-contrib-sub">Repository: ${escapeHtml(projectPath)}</div>
        </div>
      </div>
      <div class="scm-contrib-range">
        <label>From <input type="date" data-scm-contrib-from value="${escapeHtml(range.from)}" /></label>
        <label>To <input type="date" data-scm-contrib-to value="${escapeHtml(range.to)}" /></label>
        <button type="button" data-scm-contrib-action="apply-range">Apply Range</button>
      </div>
      <div class="scm-contrib-cards">
        <div class="scm-contrib-card"><div class="k">Total Commits</div><div class="v">${total}</div></div>
        <div class="scm-contrib-card"><div class="k">Active Days</div><div class="v">${activeDays}</div></div>
        <div class="scm-contrib-card"><div class="k">Avg / Active Day</div><div class="v">${avg}</div></div>
        <div class="scm-contrib-card"><div class="k">Best Day</div><div class="v">${maxDay.date ? `${maxDay.count} (${escapeHtml(isoToDisplay(maxDay.date))})` : "—"}</div></div>
      </div>
      <div class="scm-gh-wrap">
        <div class="scm-contrib-sub">Last 365 days</div>
        ${heatmap}
      </div>
      <div class="scm-contrib-table">
        <table>
          <thead><tr><th>Day</th><th>Commits</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </article>
  `;
  editor.openHtmlTab(pagePath, "SCM Contributions", html);
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
        <div class="recent-item" data-path="${escapeHtml(p.path)}" role="button" tabindex="0" aria-label="Open project ${escapeHtml(p.name)}">
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
    el.addEventListener("keydown", (e) => {
      const keyEvent = e as KeyboardEvent;
      if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
      const t = keyEvent.target as HTMLElement;
      if (t.closest(".recent-item-remove") || t.closest(".recent-item-star")) return;
      keyEvent.preventDefault();
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
  $("workspace-project-path").textContent = project.path;
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
  await checkAndNotifyExtensionUpdates();
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

interface PanelWindowConfig {
  panelId: string;
  resizeId?: string;
  actionsSelector: string;
  maximizeBtnId: string;
  axis: "width" | "height";
  close: () => void;
}

function applyPanelMaximizedState(config: PanelWindowConfig, isMaximized: boolean) {
  const panel = document.getElementById(config.panelId);
  const resize = config.resizeId ? document.getElementById(config.resizeId) : null;
  const maximizeBtn = document.getElementById(config.maximizeBtnId);
  if (!panel) return;

  panel.classList.toggle("panel-maximized", isMaximized);
  panel.classList.toggle("panel-maximized-height", isMaximized && config.axis === "height");
  if (resize) resize.classList.toggle("hidden", isMaximized || panel.classList.contains("hidden"));
  if (maximizeBtn) {
    maximizeBtn.setAttribute("title", isMaximized ? "Restore Panel" : "Maximize Panel");
    maximizeBtn.innerHTML = isMaximized
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h6.5A1.75 1.75 0 0 1 14 4.75v6.5A1.75 1.75 0 0 1 12.25 13h-6.5A1.75 1.75 0 0 1 4 11.25v-6.5zM5.75 4a.75.75 0 0 0-.75.75v6.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75v-6.5a.75.75 0 0 0-.75-.75h-6.5z"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 2A1.75 1.75 0 0 0 1 3.75v8.5C1 13.216 1.784 14 2.75 14h10.5A1.75 1.75 0 0 0 15 12.25v-8.5A1.75 1.75 0 0 0 13.25 2H2.75zm0 1h10.5c.414 0 .75.336.75.75v8.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-8.5c0-.414.336-.75.75-.75z"/></svg>`;
  }
  if (isMaximized) maximizedPanels.add(config.panelId);
  else maximizedPanels.delete(config.panelId);
  editor.resize();
}

function togglePanelMaximized(config: PanelWindowConfig) {
  const panel = document.getElementById(config.panelId);
  if (!panel || panel.classList.contains("hidden")) return;
  applyPanelMaximizedState(config, !maximizedPanels.has(config.panelId));
}

function setupPanelWindowControls() {
  const configs: PanelWindowConfig[] = [
    {
      panelId: "terminal-panel",
      resizeId: "terminal-resize",
      actionsSelector: ".terminal-header-actions",
      maximizeBtnId: "btn-maximize-terminal",
      axis: "height",
      close: () => terminal.toggle(),
    },
    {
      panelId: "snippets-panel",
      resizeId: "snippets-resize",
      actionsSelector: ".snippets-header-actions",
      maximizeBtnId: "btn-maximize-snippets",
      axis: "width",
      close: () => {
        snippetsPanel.hide();
        document.getElementById("snippets-resize")?.classList.add("hidden");
        syncTopBarActionStates();
      },
    },
    {
      panelId: "api-requests-panel",
      resizeId: "api-requests-resize",
      actionsSelector: ".api-req-header-actions",
      maximizeBtnId: "btn-maximize-api-requests",
      axis: "width",
      close: () => {
        apiRequestsPanel.hide();
        document.getElementById("api-requests-resize")?.classList.add("hidden");
        syncTopBarActionStates();
      },
    },
    {
      panelId: "source-control-panel",
      resizeId: "source-control-resize",
      actionsSelector: ".scm-header-actions",
      maximizeBtnId: "btn-maximize-scm",
      axis: "width",
      close: () => {
        if (sourceControl.isOpen()) sourceControl.toggle();
        syncTopBarActionStates();
      },
    },
    {
      panelId: "review-panel",
      resizeId: "review-resize",
      actionsSelector: ".review-header-actions",
      maximizeBtnId: "btn-maximize-review",
      axis: "width",
      close: () => codeReviewPanel.close(),
    },
    {
      panelId: "quality-panel",
      resizeId: "quality-resize",
      actionsSelector: ".quality-header-actions",
      maximizeBtnId: "btn-maximize-quality",
      axis: "width",
      close: () => qualityPanel.close(),
    },
    {
      panelId: "extensions-panel",
      resizeId: "extensions-resize",
      actionsSelector: ".extensions-header-actions",
      maximizeBtnId: "btn-maximize-extensions",
      axis: "width",
      close: () => extensionsPanel.close(),
    },
    {
      panelId: "ext-view-panel",
      resizeId: "ext-view-panel-resize",
      actionsSelector: "#ext-view-panel .extensions-header-actions",
      maximizeBtnId: "btn-maximize-ext-view-panel",
      axis: "width",
      close: () => closeExtensionViewPanel(),
    },
    {
      panelId: "chat-panel",
      resizeId: "chat-resize",
      actionsSelector: ".chat-header-actions",
      maximizeBtnId: "btn-maximize-chat",
      axis: "width",
      close: () => {
        if (isChatOpen()) toggleChat();
        syncTopBarActionStates();
      },
    },
  ];

  const maximizeIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 2A1.75 1.75 0 0 0 1 3.75v8.5C1 13.216 1.784 14 2.75 14h10.5A1.75 1.75 0 0 0 15 12.25v-8.5A1.75 1.75 0 0 0 13.25 2H2.75zm0 1h10.5c.414 0 .75.336.75.75v8.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-8.5c0-.414.336-.75.75-.75z"/></svg>`;

  configs.forEach((config) => {
    const panel = document.getElementById(config.panelId);
    const actions = document.querySelector(config.actionsSelector) as HTMLElement | null;
    if (!panel || !actions) return;

    if (!document.getElementById(config.maximizeBtnId)) {
      const maximizeBtn = document.createElement("button");
      maximizeBtn.id = config.maximizeBtnId;
      maximizeBtn.className = "btn-icon btn-icon-sm";
      maximizeBtn.title = "Maximize Panel";
      maximizeBtn.innerHTML = maximizeIcon;
      maximizeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanelMaximized(config);
      });
      actions.insertBefore(maximizeBtn, actions.lastElementChild);
    }

    const observer = new MutationObserver(() => {
      if (panel.classList.contains("hidden")) applyPanelMaximizedState(config, false);
      else if (maximizedPanels.has(config.panelId)) applyPanelMaximizedState(config, true);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["class"] });
  });
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
  if (sameSide("api-requests-panel") && apiRequestsPanel?.isVisible?.()) {
    apiRequestsPanel.hide();
    document.getElementById("api-requests-resize")?.classList.add("hidden");
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
  if (panelSide("api-requests-panel") === "left" && apiRequestsPanel?.isVisible?.()) {
    apiRequestsPanel.hide();
    document.getElementById("api-requests-resize")?.classList.add("hidden");
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
  document.getElementById("btn-toggle-api-requests")?.classList.toggle("active", apiRequestsPanel?.isVisible?.() ?? false);
  document.getElementById("btn-toggle-voice-call")?.classList.toggle("active", voiceCallPanel?.isVisible?.() ?? false);
  document.getElementById("btn-toggle-sidebar")?.classList.toggle("active", !$("sidebar").classList.contains("hidden"));
  document.getElementById("btn-toggle-zen")?.classList.toggle("active", !!appSettings?.appearance?.zenMode);
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
        const item = document.querySelector<HTMLElement>(`.workspace-action-item[data-action-id="${actionId}"]`);
        if (!item) return null;
        const visible = appSettings.workspaceActions.visibility[actionId] !== false;
        item.classList.toggle("hidden", !visible);
        if (!visible || placements[actionId] !== placement) return null;
        return item;
      })
      .filter((item): item is HTMLElement => !!item);

    items.forEach((item) => zone.appendChild(item));
  });

  // Reposition panels to match their button's sidebar side
  applyPanelSidePlacement("snippets-panel", "snippets-resize", "snippets");
  applyPanelSidePlacement("api-requests-panel", "api-requests-resize", "api-requests");
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
      ...appSettings.workspaceActions,
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

function closeActionSurface(actionId: WorkspaceActionId) {
  if (actionId === "explorer" && !$("sidebar").classList.contains("hidden")) toggleSidebar(false);
  if (actionId === "snippets" && snippetsPanel?.isVisible?.()) {
    snippetsPanel.hide();
    document.getElementById("snippets-resize")?.classList.add("hidden");
  }
  if (actionId === "api-requests" && apiRequestsPanel?.isVisible?.()) {
    apiRequestsPanel.hide();
    document.getElementById("api-requests-resize")?.classList.add("hidden");
  }
  if (actionId === "source-control" && sourceControl?.isOpen?.()) sourceControl.toggle();
  if (actionId === "ai-review" && codeReviewPanel?.isOpen?.()) codeReviewPanel.close();
  if (actionId === "quality-panel" && qualityPanel?.isOpen?.()) qualityPanel.close();
  if (actionId === "extensions-panel") {
    if (extensionsPanel?.isOpen?.()) extensionsPanel.close();
    closeExtensionViewPanel();
  }
  if (actionId === "chat" && isChatOpen()) toggleChat();
  if (actionId === "terminal" && terminal?.getIsVisible?.()) terminal.toggle();
}

async function persistWorkspaceActionVisibility(actionId: WorkspaceActionId, visible: boolean) {
  if (appSettings.workspaceActions.visibility[actionId] === visible) return;
  appSettings = {
    ...appSettings,
    workspaceActions: {
      ...appSettings.workspaceActions,
      visibility: {
        ...appSettings.workspaceActions.visibility,
        [actionId]: visible,
      },
    },
  };
  if (!visible) closeActionSurface(actionId);
  settingsUI.updateSettings(appSettings);
  renderWorkspaceActionPlacements();
  syncTopBarActionStates();
  await saveSettings(appSettings);
}

function closeWorkspaceActionMenu() {
  if (!actionMenuEl) return;
  actionMenuEl.classList.add("hidden");
}

function openWorkspaceActionMenu(actionId: WorkspaceActionId | undefined, anchorRect: DOMRect) {
  if (!actionMenuEl) return;
  const effectiveActionId = actionId ?? actionMenuContextActionId;
  actionMenuContextActionId = effectiveActionId;
  const activePlacement = appSettings.workspaceActions.placements[effectiveActionId];
  actionMenuEl.innerHTML = `
    <div class="workspace-action-menu-title">Customize Navbar</div>
    ${ACTION_ITEM_ORDER.map((id) => {
      const active = appSettings.workspaceActions.visibility[id] !== false;
      return `
        <button
          class="workspace-action-menu-option${id === effectiveActionId ? " active" : ""}"
          data-kind="toggle"
          data-action-id="${id}"
          type="button"
        >
          <span>${ACTION_LABELS[id]}</span>
          <span class="workspace-action-check">${active ? "✓" : ""}</span>
        </button>
      `;
    }).join("")}
    <div class="workspace-action-menu-title">Move ${ACTION_LABELS[effectiveActionId]}</div>
    ${ACTION_PLACEMENT_ORDER.map(
      (placement) => `
        <button
          class="workspace-action-menu-option${placement === activePlacement ? " active" : ""}"
          data-kind="placement"
          data-action-id="${effectiveActionId}"
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
    if (actionId === "extensions-panel") {
      item.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openWorkspaceActionMenu(actionId, item.getBoundingClientRect());
      });
    }
  });
  document.querySelectorAll<HTMLElement>(".workspace-action-zone, .workspace-action-rail").forEach((zone) => {
    zone.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest(".workspace-action-item")) return;
      event.preventDefault();
      event.stopPropagation();
      const pointRect = new DOMRect(event.clientX, event.clientY, 1, 1);
      openWorkspaceActionMenu(undefined, pointRect);
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
    const kind = option.dataset.kind || "placement";
    const actionId = option.dataset.actionId as WorkspaceActionId;
    if (kind === "toggle") {
      const nextVisible = appSettings.workspaceActions.visibility[actionId] === false;
      actionMenuContextActionId = actionId;
      await persistWorkspaceActionVisibility(actionId, nextVisible);
      openWorkspaceActionMenu(actionId, option.getBoundingClientRect());
      return;
    }
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
  applyBatteryAdaptiveAccent();
  applyZenMode(!!settings.appearance.zenMode);
  void syncNativeTranslucentMode(!!settings.appearance.translucentMode);
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
  applyBatteryAdaptiveAccent();

  if (currentProjectPath) {
    await snippetsPanel.setProjectPath(currentProjectPath);
    await apiRequestsPanel.setProjectPath(currentProjectPath);
    await fileExplorer.loadRoot(currentProjectPath);
  }
  if (shouldSaveSettings) {
    await saveSettings(appSettings);
  }
  ensureRuntimeCompletionProvider();
}

function ensureRuntimeCompletionProvider() {
  if (runtimeCompletionProviderRegistered) return;
  runtimeCompletionProviderRegistered = true;
  editor.addCompletionProvider(["typescript", "javascript", "typescriptreact", "javascriptreact"], {
    triggerCharacters: ["/", ".", "\"", "'", "-"],
    provideCompletionItems: async (model, position) => {
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, Math.max(0, position.column - 1));
      if (!/['"`][^'"`]*$/.test(before)) return { suggestions: [] };

      const runtimeExtensions = [...extensionSupportByIdentifier.values()].filter((item) => item.hasRuntime);
      if (!runtimeExtensions.length) return { suggestions: [] };

      const filePath = decodeURIComponent(model.uri.path || "");
      const content = model.getValue();
      const suggestions: any[] = [];
      const monacoRef = (window as any).monaco;

      for (const snapshot of runtimeExtensions) {
        const installed = findInstalledRecord(snapshot.identifier);
        if (!installed) continue;
        const runtime = getOrCreateRuntime({
          extensionId: snapshot.identifier,
          installPath: installed.install_path,
          mainPath: resolveExtMainPath(installed.install_path, snapshot),
          workspaceFolders: currentProjectPath ? [currentProjectPath] : [],
          configuration: {},
          githubToken: extensionHostGithubToken,
          onStatus: () => {},
          onHostError: (message, stack) => {
            const hinted = withUnsupportedApiHint(message, stack);
            recordExtensionDiagnostic(snapshot.identifier, {
              source: "extension-host",
              title: "Completion runtime error",
              message: hinted,
              stack,
            });
          },
        });
        if (runtime.getStatus() === "stopped" || runtime.getStatus() === "error") {
          try {
            await runtime.start();
          } catch {
            continue;
          }
        }
        const items = await runtime.provideCompletions({
          filePath,
          content,
          lineNumber: position.lineNumber,
          column: position.column,
          languageId: model.getLanguageId(),
        });
        for (const item of items) {
          suggestions.push(mapRuntimeCompletionToMonaco(item, position, monacoRef));
        }
      }
      return { suggestions: suggestions.slice(0, 200) };
    },
  });
}

function mapRuntimeCompletionToMonaco(
  item: RuntimeCompletionItem,
  position: { lineNumber: number; column: number },
  monacoRef: any,
) {
  const kind = monacoRef?.languages?.CompletionItemKind?.File ?? 17;
  return {
    label: item.label,
    kind: Number.isFinite(item.kind as number) ? item.kind : kind,
    insertText: item.insertText || item.label,
    detail: item.detail || "",
    documentation: item.documentation || "",
    range: {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: position.column,
      endColumn: position.column,
    },
    sortText: `1:${item.label}`,
  };
}

async function checkExtensionUpdates(silent = true): Promise<ExtensionUpdateInfo[]> {
  if (!installedExtensionRecords.length) {
    extensionUpdatesByIdentifier = new Map();
    return [];
  }
  try {
    const inputs: ExtensionUpdateCheckInput[] = installedExtensionRecords.map((ext) => ({
      publisher: ext.publisher,
      extension_name: ext.extension_name,
      version: ext.version,
    }));
    const updates = await invoke<ExtensionUpdateInfo[]>("check_vscode_extension_updates", {
      extensions: inputs,
    });
    extensionUpdatesByIdentifier = new Map(updates.map((item) => [item.identifier, item]));
    return updates;
  } catch (error) {
    if (!silent) {
      const msg = error instanceof Error ? error.message : String(error);
      showToast(`Extension update check failed: ${msg}`, 4000);
    }
    return [];
  }
}

function getExtensionUpdateInfo(identifier: string): ExtensionUpdateInfo | null {
  return extensionUpdatesByIdentifier.get(identifier) ?? null;
}

async function updateInstalledExtension(identifier: string): Promise<boolean> {
  const installed = installedExtensionRecords.find((item) => item.identifier === identifier);
  if (!installed || !currentProjectPath) return false;
  const updateInfo = extensionUpdatesByIdentifier.get(identifier);
  if (!updateInfo?.update_available) return false;
  await invoke("install_vscode_extension", {
    projectPath: currentProjectPath,
    publisher: installed.publisher,
    extensionName: installed.extension_name,
    version: updateInfo.latest_version,
    downloadUrl: null,
  });
  await reloadInstalledExtensionSupport();
  await checkExtensionUpdates(false);
  return true;
}

async function checkAndNotifyExtensionUpdates() {
  const updates = await checkExtensionUpdates(false);
  const pending = updates.filter((item) => item.update_available);
  if (!pending.length) return;
  extensionsPanel?.refreshDetail?.();
  const names = pending.slice(0, 4).map((item) => item.identifier).join(", ");
  const suffix = pending.length > 4 ? ` and ${pending.length - 4} more` : "";
  alert(`Extension updates available: ${names}${suffix}. Open Extensions and click Update.`);
}

function getExtensionSupport(identifier: string): ExtensionSupportSnapshot | null {
  return extensionSupportByIdentifier.get(identifier) ?? null;
}

function findExtensionCommandOwner(commandId: string): ExtensionSupportSnapshot | null {
  for (const support of extensionSupportByIdentifier.values()) {
    if (support.commands.some((command) => command.command === commandId)) {
      return support;
    }
  }
  return null;
}

async function executeExtensionCommand(command: ExtensionCommand): Promise<boolean> {
  const ownerSnapshot = findExtensionCommandOwner(command.command);
  if (!ownerSnapshot) {
    showToast(`Command "${command.title}" is not registered by any installed extension.`, 3000);
    return false;
  }
  if (!ownerSnapshot.hasRuntime) {
    showToast(`Command "${command.title}" belongs to "${ownerSnapshot.displayName}" but that extension has no runtime handler.`, 4000);
    return false;
  }
  const runtime = getRuntime(ownerSnapshot.identifier);
  if (!runtime) {
    showToast(`Command "${command.title}" is available, but the extension runtime is not active yet.`, 4000);
    return false;
  }
  try {
    await runtime.executeCommand(command.command);
    return true;
  } catch (error) {
    showToast(`Failed to run "${command.title}": ${String(error)}`, 4000);
    return false;
  }
}

function getActiveRuntimeForWorkspaceSearch(): ExtensionRuntime | null {
  for (const support of extensionSupportByIdentifier.values()) {
    if (!support.hasRuntime) continue;
    const runtime = getRuntime(support.identifier);
    if (runtime?.getStatus() === "active") return runtime;
  }
  return null;
}

function buildExtensionContextMenuItems() {
  return [...extensionSupportByIdentifier.values()]
    .filter((support) => support.hasRuntime && support.commands.length > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((support) => ({
      label: support.displayName,
      submenu: support.commands
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((command) => ({
          label: command.category ? `${command.category}: ${command.title}` : command.title,
          action: () => {
            void executeExtensionCommand(command);
          },
        })),
    }));
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
  applyBatteryAdaptiveAccent();
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
  applyBatteryAdaptiveAccent();
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
    githubToken: extensionHostGithubToken,
    onStatus: (status, msg) => {
      if (activeVcId !== vc.id) return;
      const el = document.getElementById("ext-view-panel-body");
      if (!el) return;
      if (status === "error") {
        const hinted = withUnsupportedApiHint(msg ?? "Unknown error");
        recordExtensionDiagnostic(vc.extensionIdentifier, {
          source: "extension-host",
          title: "Runtime error",
          message: hinted,
        });
        el.innerHTML = renderExtViewError(snapshot.displayName, hinted);
      }
    },
    onHostError: (message, stack) => {
      const hinted = withUnsupportedApiHint(message, stack);
      recordExtensionDiagnostic(vc.extensionIdentifier, {
        source: "extension-host",
        title: "Host error",
        message: hinted,
        stack,
      });
      if (activeVcId !== vc.id) return;
      const el = document.getElementById("ext-view-panel-body");
      if (!el) return;
      el.innerHTML = renderExtViewError(snapshot.displayName, hinted, stack);
    },
    onViewRegistered: (viewId, viewType) => {
      if (activeVcId !== vc.id) return;
      if (viewType === "webview") {
        const viewName = snapshot.views.find((v) => v.id === viewId)?.name ?? viewId;
        bodyEl.innerHTML = renderWebviewLoading(snapshot.displayName, viewName);
        return;
      }
      void renderLiveTree(viewId, bodyEl, runtime, snapshot, vc);
    },
    onTreeChanged: (viewId) => {
      if (activeVcId !== vc.id) return;
      void renderLiveTree(viewId, bodyEl, runtime, snapshot, vc);
    },
    onNotification: (level, message) => showToast(message, level === "error" ? 5000 : 3000),
    onWebviewHtml: (viewId, html) => {
      if (!html.trim()) return;
      const viewName = snapshot.views.find((v) => v.id === viewId)?.name ?? viewId;
      if (activeVcId === vc.id) {
        const bridgeId = `${vc.extensionIdentifier}:${viewId}`;
        webviewBridgeRuntimeById.set(bridgeId, runtime);
        webviewBridgeViewIdById.set(bridgeId, viewId);
        bodyEl.innerHTML = renderWebviewInline(snapshot.displayName, viewName, rewriteFileUrlsToAssetUrls(String(html ?? "")), bridgeId);
      }
    },
    onWebviewPostMessage: (viewId, message) => {
      const bridgeId = `${vc.extensionIdentifier}:${viewId}`;
      const commandMessage = message as { type?: string; command?: unknown; args?: unknown };
      if (commandMessage && commandMessage.type === "executeCommand" && typeof commandMessage.command === "string") {
        const args = Array.isArray(commandMessage.args) ? commandMessage.args : [];
        void runtime.executeCommand(commandMessage.command, ...args).catch(() => {});
        return;
      }
      const selector = webviewBridgeIframeSelectorById.get(bridgeId);
      if (!selector) return;
      const iframe = document.querySelector<HTMLIFrameElement>(selector);
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage({ __athvaWebviewFromHost: { bridgeId, message } }, "*");
    },
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
        const html = runtime.getWebviewHtml(viewId);
        if (html.trim()) {
          const viewName = snapshot.views.find((v) => v.id === viewId)?.name ?? viewId;
          const bridgeId = `${vc.extensionIdentifier}:${viewId}`;
          webviewBridgeRuntimeById.set(bridgeId, runtime);
          webviewBridgeViewIdById.set(bridgeId, viewId);
          bodyEl.innerHTML = renderWebviewInline(snapshot.displayName, viewName, rewriteFileUrlsToAssetUrls(String(html ?? "")), bridgeId);
        } else {
          const viewName = snapshot.views.find((v) => v.id === viewId)?.name ?? viewId;
          bodyEl.innerHTML = renderWebviewLoading(snapshot.displayName, viewName);
        }
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

function renderWebviewLoading(displayName: string, viewName: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const message = "Waiting for extension webview HTML…";
  return `<div class="ext-view-runtime-state" style="padding:12px">
    <div class="ext-view-runtime-icon-row">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.6"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zm1.5-.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11z"/></svg>
      <span>${esc(displayName)} / ${esc(viewName)}</span>
    </div>
    <p class="ext-view-runtime-desc">${esc(message)}</p>
  </div>`;
}

function renderWebviewInline(displayName: string, viewName: string, html: string, bridgeId: string): string {
  ensureInlineWebviewAssetBridge();
  const srcdoc = prepareInlineWebviewHtml(html, bridgeId).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const iframeId = `ext-webview-${bridgeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  webviewBridgeIframeSelectorById.set(bridgeId, `#${iframeId}`);
  return `<div class="ext-webview-shell" title="${displayName} / ${viewName}">
    <iframe
      id="${iframeId}"
      class="ext-webview-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      srcdoc="${srcdoc}"></iframe>
  </div>`;
}

function decodeFileUrl(url: string): string {
  try {
    if (!url.startsWith("file://")) return "";
    const raw = url.replace(/^file:\/\//i, "");
    const normalized = raw.startsWith("/") ? raw : `/${raw}`;
    return decodeURIComponent(normalized);
  } catch {
    return "";
  }
}

function normalizeVsixAssetPath(path: string): string {
  const input = String(path || "");
  // Installed VSIX layout in Athva is: <installDir>/extension/<assets...>
  // Some extensions still emit file URLs rooted at <installDir>/<assets...>.
  if (input.includes("/extensions/") && !input.includes("/extensions/extension/")) {
    const marker = "/webview/";
    const idx = input.indexOf(marker);
    if (idx > 0) {
      const prefix = input.slice(0, idx);
      const suffix = input.slice(idx);
      // If not already in /extension/*, insert it before known asset roots.
      if (!prefix.endsWith("/extension")) {
        return `${prefix}/extension${suffix}`;
      }
    }
  }
  return input;
}

function ensureInlineWebviewAssetBridge() {
  if (inlineWebviewAssetBridgeReady) return;
  inlineWebviewAssetBridgeReady = true;
  window.addEventListener("message", async (event) => {
    const req = (event.data as any)?.__athvaAssetReq;
    const webviewMsg = (event.data as any)?.__athvaWebviewMessage;
    if (webviewMsg && typeof webviewMsg === "object") {
      const bridgeId = String(webviewMsg.bridgeId ?? "");
      if (bridgeId) {
        const runtime = webviewBridgeRuntimeById.get(bridgeId);
        const viewId = webviewBridgeViewIdById.get(bridgeId);
        if (runtime && viewId) runtime.postWebviewMessage(viewId, webviewMsg.message);
      }
    }
    if (!req || typeof req !== "object") return;
    const id = String(req.id ?? "");
    const url = String(req.url ?? "");
    const target = event.source as Window | null;
    if (!id || !url || !target) return;

    const reply = (payload: { id: string; dataUrl?: string; error?: string }) => {
      target.postMessage({ __athvaAssetRes: payload }, "*");
    };

    if (!url.startsWith("file://")) {
      reply({ id, error: "unsupported-url" });
      return;
    }

    try {
      const path = normalizeVsixAssetPath(decodeFileUrl(url));
      if (!path) {
        reply({ id, error: "invalid-file-url" });
        return;
      }
      const assetUrl = convertFileSrc(path);
      reply({ id, dataUrl: assetUrl });
    } catch (err) {
      reply({ id, error: String(err) });
    }
  });
}

function rewriteFileUrlsToAssetUrls(html: string): string {
  const source = String(html ?? "");
  const re = /file:\/\/\/[^\s"'<>`\\)]+/gi;
  const matches = Array.from(new Set(source.match(re) ?? []));
  if (!matches.length) return source;

  let out = source;
  for (const fileUrl of matches) {
    try {
      const path = normalizeVsixAssetPath(decodeFileUrl(fileUrl));
      if (!path) continue;
      const assetUrl = convertFileSrc(path);
      const escaped = fileUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(escaped, "g"), assetUrl);
      // Some bundles emit JSON-escaped variants (file:\\/\\/\\/)
      out = out.replace(new RegExp(fileUrl.replace(/\//g, "\\/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), assetUrl.replace(/\//g, "\\/"));
    } catch {
      // Keep original URL if conversion fails.
    }
  }
  return out;
}

function prepareInlineWebviewHtml(input: string, bridgeId: string): string {
  const raw = String(input ?? "");
  // Webview bundles often ship a restrictive CSP meta tailored for vscode-webview://
  // origins. In srcdoc that CSP commonly blocks all scripts/styles and yields blank UI.
  const withoutMetaCsp = raw.replace(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,
    ""
  );
  const bridge = `
<style>
  :root {
    color-scheme: dark;
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-foreground: #d4d4d4;
    --vscode-input-background: #2d2d30;
    --vscode-input-foreground: #d4d4d4;
    --vscode-input-border: #3c3c3c;
    --vscode-panel-background: #1e1e1e;
    --vscode-sideBar-background: #252526;
  }
  html, body {
    background: var(--vscode-editor-background) !important;
    color: var(--vscode-editor-foreground) !important;
    margin: 0;
    min-height: 100%;
  }
</style>
<script>
  (function() {
    try {
      if (!Symbol.dispose) Symbol.dispose = Symbol.for("Symbol.dispose");
      if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol.for("Symbol.asyncDispose");
      if (!Object.prototype[Symbol.dispose]) {
        Object.defineProperty(Object.prototype, Symbol.dispose, {
          value: function() {},
          writable: true,
          configurable: true,
          enumerable: false
        });
      }
      if (!Object.prototype[Symbol.asyncDispose]) {
        Object.defineProperty(Object.prototype, Symbol.asyncDispose, {
          value: async function() {},
          writable: true,
          configurable: true,
          enumerable: false
        });
      }
    } catch (_) {}

    // Install a durable Tauri internals shim before extension scripts run.
    // Some extension webviews bundle @tauri-apps/api/core and call
    // window.__TAURI_INTERNALS__.transformCallback/invoke directly.
    var cbSeq = 1;
    var cbMap = Object.create(null);
    var tauriInternals = {
      invoke: function() { return Promise.resolve(null); },
      transformCallback: function(cb) {
        var id = cbSeq++;
        cbMap[id] = cb;
        return id;
      },
      unregisterCallback: function(id) {
        try { delete cbMap[id]; } catch (_) {}
      },
      convertFileSrc: function(path) {
        return String(path || "");
      }
    };
    try {
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: tauriInternals,
        writable: false,
        configurable: false,
        enumerable: false
      });
    } catch (_) {
      window.__TAURI_INTERNALS__ = tauriInternals;
    }
    try {
      if (!window.__TAURI__) window.__TAURI__ = {};
      if (!window.__TAURI__.core) {
        window.__TAURI__.core = {
          invoke: tauriInternals.invoke,
          transformCallback: tauriInternals.transformCallback,
          convertFileSrc: tauriInternals.convertFileSrc
        };
      }
    } catch (_) {}

    // Some webviews (Claude Code) call history.replaceState/pushState to add
    // session query params. In sandboxed about:srcdoc this throws:
    // "Paths and fragments must match for a sandboxed document."
    // Keep state changes, but ignore URL mutation when browser rejects it.
    try {
      var _origReplaceState = history.replaceState ? history.replaceState.bind(history) : null;
      var _origPushState = history.pushState ? history.pushState.bind(history) : null;
      if (_origReplaceState) {
        history.replaceState = function(state, title, url) {
          try { return _origReplaceState(state, title, url); }
          catch (_) { return _origReplaceState(state, title); }
        };
      }
      if (_origPushState) {
        history.pushState = function(state, title, url) {
          try { return _origPushState(state, title, url); }
          catch (_) { return _origPushState(state, title); }
        };
      }
    } catch (_) {}

    var state = {};
    var pending = Object.create(null);
    var reqSeq = 0;
    function requestAsset(url) {
      return new Promise(function(resolve, reject) {
        var id = String(++reqSeq);
        pending[id] = { resolve: resolve, reject: reject };
        try {
          window.parent && window.parent.postMessage({ __athvaAssetReq: { id: id, url: String(url || '') } }, '*');
          setTimeout(function() {
            if (!pending[id]) return;
            delete pending[id];
            reject(new Error('asset-timeout'));
          }, 10000);
        } catch (e) {
          delete pending[id];
          reject(e);
        }
      });
    }
    window.addEventListener('message', function(event) {
      var res = event && event.data && event.data.__athvaAssetRes;
      if (!res || !res.id || !pending[res.id]) return;
      var p = pending[res.id];
      delete pending[res.id];
      if (res.dataUrl) p.resolve(String(res.dataUrl));
      else p.reject(new Error(String(res.error || 'asset-error')));
    });

    window.acquireVsCodeApi = window.acquireVsCodeApi || function() {
      return {
        postMessage: function(msg) { try { window.parent && window.parent.postMessage({ __athvaWebviewMessage: { bridgeId: "${bridgeId}", message: msg } }, '*'); } catch (_) {} },
        setState: function(next) { state = next || {}; },
        getState: function() { return state; }
      };
    };
    window.addEventListener('message', function(event) {
      var payload = event && event.data && event.data.__athvaWebviewFromHost;
      if (!payload || payload.bridgeId !== "${bridgeId}") return;
      try {
        var ev = new MessageEvent('message', { data: payload.message });
        window.dispatchEvent(ev);
      } catch (_) {}
    });

    function parseCommandUri(uri) {
      if (typeof uri !== 'string' || uri.indexOf('command:') !== 0) return null;
      var raw = uri.slice('command:'.length);
      var queryIndex = raw.indexOf('?');
      var command = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
      if (!command) return null;
      var args = [];
      if (queryIndex >= 0) {
        var query = raw.slice(queryIndex + 1);
        try {
          var decoded = decodeURIComponent(query);
          if (decoded) args = JSON.parse(decoded);
          if (!Array.isArray(args)) args = [args];
        } catch (_) {}
      }
      return { command: command, args: args };
    }

    function sendCommandUri(uri) {
      var parsed = parseCommandUri(uri);
      if (!parsed) return false;
      try {
        window.acquireVsCodeApi().postMessage({ type: 'executeCommand', command: parsed.command, args: parsed.args });
      } catch (_) {}
      return true;
    }

    function isFileUrl(v) { return typeof v === 'string' && v.toLowerCase().indexOf('file://') === 0; }
    function patchAttr(el, attr) {
      try {
        var value = el.getAttribute && el.getAttribute(attr);
        if (!isFileUrl(value)) return;
        requestAsset(value).then(function(dataUrl) {
          try { el.setAttribute(attr, dataUrl); } catch (_) {}
        }).catch(function() {});
      } catch (_) {}
    }
    function patchNode(el) {
      if (!el || !el.tagName) return;
      patchAttr(el, 'src');
      patchAttr(el, 'href');
      if (el.querySelectorAll) {
        var nested = el.querySelectorAll('[src],[href]');
        for (var i = 0; i < nested.length; i++) {
          patchAttr(nested[i], 'src');
          patchAttr(nested[i], 'href');
        }
      }
    }
    document.addEventListener('click', function(event) {
      try {
        var node = event && event.target;
        while (node && node !== document) {
          if (node.tagName === 'A') {
            var href = node.getAttribute && node.getAttribute('href');
            if (sendCommandUri(href)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
          node = node.parentNode;
        }
      } catch (_) {}
    }, true);
    var _open = window.open ? window.open.bind(window) : null;
    if (_open) {
      window.open = function(url, target, features) {
        if (sendCommandUri(String(url || ''))) return null;
        return _open(url, target, features);
      };
    }
    var _setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      _setAttribute.call(this, name, value);
      if (name === 'src' || name === 'href') patchAttr(this, name);
    };
    var _appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
      var out = _appendChild.call(this, node);
      patchNode(node);
      return out;
    };
    var _insertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function(node, child) {
      var out = _insertBefore.call(this, node, child);
      patchNode(node);
      return out;
    };
    var mo = new MutationObserver(function(muts) {
      muts.forEach(function(m) {
        if (m.type === 'attributes' && m.target) patchNode(m.target);
        if (m.type === 'childList' && m.addedNodes) {
          for (var i = 0; i < m.addedNodes.length; i++) patchNode(m.addedNodes[i]);
        }
      });
    });
    try {
      mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src','href'] });
      patchNode(document.documentElement || document.body);
    } catch (_) {}

    try {
      document.documentElement.classList.add('vscode-dark');
      if (document.body) document.body.classList.add('vscode-dark');
      else document.addEventListener('DOMContentLoaded', function() {
        try { document.body && document.body.classList.add('vscode-dark'); } catch (_) {}
      }, { once: true });
    } catch (_) {}
  })();
</script>`;

  if (withoutMetaCsp.includes("</head>")) {
    return withoutMetaCsp.replace("</head>", `${bridge}</head>`);
  }
  return `<!doctype html><html><head>${bridge}</head><body>${withoutMetaCsp}</body></html>`;
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
  showToast(`Installing ${payload.displayName}: downloading package…`, 2500);
  await invoke("install_vscode_extension", {
    projectPath: currentProjectPath,
    publisher: payload.publisher,
    extensionName: payload.extensionName,
    version: payload.version,
    downloadUrl: payload.downloadUrl,
  });
  showToast(`Installing ${payload.displayName}: refreshing extension support…`, 2500);
  await reloadInstalledExtensionSupport();
  await checkExtensionUpdates(false);
  await extensionsPanel.refresh();
  openExtensionPreviewPage({ ...payload, installed: true });
  showToast(`${payload.displayName} installed.`, 2500);
}

async function uninstallExtensionFromPreview(identifier: string) {
  const payload = extensionPreviewPayloads.get(identifier);
  if (!payload || !payload.installed) return;
  showToast(`Uninstalling ${payload.displayName}…`, 2500);
  await invoke("uninstall_vscode_extension", { identifier });
  showToast(`Uninstalling ${payload.displayName}: refreshing extension support…`, 2500);
  await reloadInstalledExtensionSupport();
  await checkExtensionUpdates(false);
  await extensionsPanel.refresh();
  openExtensionPreviewPage({ ...payload, installed: false });
  showToast(`${payload.displayName} removed.`, 2500);
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

function applyZenMode(enabled: boolean) {
  document.body.classList.toggle("zen-mode", enabled);
  syncTopBarActionStates();
  setTimeout(() => editor?.resize?.(), 0);
}

async function toggleZenMode() {
  appSettings = {
    ...appSettings,
    appearance: {
      ...appSettings.appearance,
      zenMode: !appSettings.appearance.zenMode,
    },
  };
  onSettingsChange(appSettings);
  await saveSettings(appSettings);
}

function getBatteryAccentColor(level: number): string {
  const shadeScale = [
    "#d10000",
    "#de2a00",
    "#e65000",
    "#eb7300",
    "#f09400",
    "#c9a800",
    "#94b600",
    "#63bf00",
    "#32bf32",
    "#16a34a",
  ];
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  const index = Math.min(9, Math.floor(clamped / 10));
  if (clamped > 80) return shadeScale[Math.max(index, 8)];
  if (clamped < 10) return shadeScale[0];
  return shadeScale[index];
}

function applyBatteryAdaptiveAccent() {
  const root = document.documentElement;
  if (!appSettings?.appearance?.batteryAdaptiveAccent || currentBatteryLevel === null) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
    return;
  }
  const accent = getBatteryAccentColor(currentBatteryLevel);
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", accent);
}

// ── Init ──
window.addEventListener("DOMContentLoaded", async () => {
  initIdeLogsCapture();
  // Load settings
  appSettings = await loadSettings();
  await refreshExtensionHostGithubToken();
  window.addEventListener("athva:github-token-changed", () => { void refreshExtensionHostGithubToken(); });
  void syncNativeTranslucentMode(!!appSettings.appearance.translucentMode);
  refreshSecuritySession(appSettings);

  // Init editor
  editor = new Editor("monaco-editor", "editor-tabs", "editor-empty");
  editor.applySettings(appSettings.editor);
  editor.setAISettings(() => appSettings.ai);
  registerMonacoThemeSetter((theme) => editor.setMonacoTheme(theme));
  registerMonacoThemeDefiner((name, theme) => editor.defineMonacoTheme(name, theme));

  // Apply theme after registering the Ace setter so the editor theme is set correctly
  applyTheme(appSettings.appearance);
  applyBatteryAdaptiveAccent();
  applyZenMode(!!appSettings.appearance.zenMode);

  // Init snippets panel
  snippetsPanel = new SnippetsPanel("snippets-panel");
  snippetsPanel.onInsert((snippet) => editor.insertSnippet(snippet));
  apiRequestsPanel = new ApiRequestsPanel("api-requests-panel");
  voiceCallPanel = new VoiceCallPanel("voice-call-panel");
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
  fileExplorer.setExtensionContextMenuItems(buildExtensionContextMenuItems);

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
  terminal = new TerminalPanel(() => editor.resize(), async (uri) => {
    for (const support of extensionSupportByIdentifier.values()) {
      if (!support?.hasRuntime) continue;
      const runtime = getRuntime(support.identifier);
      if (!runtime) continue;
      try {
        if (await runtime.handleTerminalLink(uri)) return true;
      } catch {}
    }
    return false;
  });
  registerTerminalThemeSetter((colors, isLight) => terminal.setTheme(colors, isLight));

  // Init script runner
  scriptRunner = new ScriptRunner(terminal);

  // Init source control
  sourceControl = new SourceControl(
    () => editor.resize(),
    () => appSettings.ai,
    (projectPath) => { void openScmContributionTool(projectPath); },
    (projectPath) => { void openGitGraphTool(projectPath); },
  );

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
      getUpdateInfo: getExtensionUpdateInfo,
      updateExtension: updateInstalledExtension,
      getSettingsState: getExtensionSettingsState,
      saveSettingsState: saveExtensionSettingsState,
      afterInstallChange: async () => {
        await reloadInstalledExtensionSupport();
        await checkExtensionUpdates(false);
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
    void executeExtensionCommand(command);
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
    },
    async ({ query, caseSensitive, useRegex, maxResults }) => {
      const runtime = getActiveRuntimeForWorkspaceSearch();
      if (!runtime) return null;
      try {
        return await runtime.searchInFiles({
          query,
          caseSensitive,
          useRegex,
          maxResults,
        });
      } catch {
        return null;
      }
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
  setupPanelWindowControls();

  // ── Welcome page buttons ──
  $("btn-open-folder").addEventListener("click", handleOpenFolder);
  $("btn-create-project").addEventListener("click", showCreateDialog);
  $("btn-clone-repo").addEventListener("click", showCloneDialog);
  $("btn-new-window").addEventListener("click", () => invoke("open_app_window", { project: "" }));
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
  $("btn-toggle-api-requests").addEventListener("click", () => {
    if (!apiRequestsPanel.isVisible()) closePanelsOnSameSide("api-requests-panel");
    apiRequestsPanel.toggle();
    $("api-requests-resize").classList.toggle("hidden", !apiRequestsPanel.isVisible());
    syncTopBarActionStates();
  });
  $("btn-toggle-voice-call").addEventListener("click", () => {
    if (!voiceCallPanel.isVisible()) closePanelsOnSameSide("voice-call-panel");
    if (voiceCallPanel.isVisible()) voiceCallPanel.hide(); else voiceCallPanel.show();
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
  $("btn-toggle-zen").addEventListener("click", () => {
    void toggleZenMode();
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

    const ggTab = (event.target as HTMLElement).closest("[data-gg-tab]") as HTMLElement | null;
    if (ggTab) {
      event.preventDefault();
      const root = ggTab.closest(".git-graph-tool");
      const tab = ggTab.dataset.ggTab;
      root?.querySelectorAll<HTMLElement>("[data-gg-tab]").forEach(b => b.classList.toggle("gg-tab-active", b.dataset.ggTab === tab));
      root?.querySelectorAll<HTMLElement>("[data-gg-panel]").forEach(p => p.classList.toggle("gg-panel-active", p.dataset.ggPanel === tab));
      return;
    }

    const scmAction = (event.target as HTMLElement).closest("[data-scm-contrib-action]") as HTMLElement | null;
    if (scmAction) {
      event.preventDefault();
      const root = scmAction.closest<HTMLElement>("[data-project-path]");
      const projectPath = root?.dataset.projectPath || currentProjectPath;
      if (!projectPath) return;
      if (scmAction.dataset.scmContribAction === "apply-range") {
        const from = root?.querySelector<HTMLInputElement>("[data-scm-contrib-from]")?.value ?? "";
        const to = root?.querySelector<HTMLInputElement>("[data-scm-contrib-to]")?.value ?? "";
        void openScmContributionTool(projectPath, from, to);
      }
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

    // Ctrl/Cmd + Shift + N → New Window
    if (isMod && e.shiftKey && e.key === "N") {
      e.preventDefault();
      invoke("open_app_window", { project: currentProjectPath || "" });
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
      currentBatteryLevel = level;
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
      applyBatteryAdaptiveAccent();
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

  const urlProject = new URLSearchParams(window.location.search).get("project");
  if (urlProject) {
    await openProject(urlProject);
  } else {
    const startupPath = await invoke<string | null>("get_startup_open_path").catch(() => null);
    if (startupPath) {
      await openProject(startupPath);
    } else {
      const store = await getProjects().catch(() => null);
      const mostRecentProject = store?.projects
        ?.slice()
        ?.sort((a, b) => b.last_opened - a.last_opened)
        ?.find((project) => !!project?.path);
      if (mostRecentProject?.path) {
        await openProject(mostRecentProject.path);
      }
    }
  }
});
