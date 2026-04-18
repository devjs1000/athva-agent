import ace from "ace-builds";
import "ace-builds/src-min-noconflict/mode-javascript";
import "ace-builds/src-min-noconflict/mode-jsx";
import "ace-builds/src-min-noconflict/mode-typescript";
import "ace-builds/src-min-noconflict/mode-tsx";
import "ace-builds/src-min-noconflict/mode-json";
import "ace-builds/src-min-noconflict/mode-html";
import "ace-builds/src-min-noconflict/mode-css";
import "ace-builds/src-min-noconflict/mode-markdown";
import "ace-builds/src-min-noconflict/mode-python";
import "ace-builds/src-min-noconflict/mode-rust";
import "ace-builds/src-min-noconflict/mode-yaml";
import "ace-builds/src-min-noconflict/mode-toml";
import "ace-builds/src-min-noconflict/mode-sh";
import "ace-builds/src-min-noconflict/mode-text";
import "ace-builds/src-min-noconflict/theme-monokai";
import "ace-builds/src-min-noconflict/theme-github_dark";
import "ace-builds/src-min-noconflict/theme-tomorrow_night";
import "ace-builds/src-min-noconflict/theme-dracula";
import "ace-builds/src-min-noconflict/theme-one_dark";
import "ace-builds/src-min-noconflict/theme-solarized_dark";
import "ace-builds/src-min-noconflict/theme-twilight";
import "ace-builds/src-min-noconflict/theme-cobalt";
import "ace-builds/src-min-noconflict/theme-github";
import "ace-builds/src-min-noconflict/theme-chrome";
import "ace-builds/src-min-noconflict/ext-searchbox";
import "ace-builds/src-min-noconflict/ext-language_tools";
import "ace-builds/src-min-noconflict/ext-inline_autocomplete";
import "ace-builds/src-min-noconflict/snippets/javascript";
import "ace-builds/src-min-noconflict/snippets/jsx";
import "ace-builds/src-min-noconflict/snippets/typescript";
import "ace-builds/src-min-noconflict/snippets/tsx";
import "ace-builds/src-min-noconflict/snippets/html";
import "ace-builds/src-min-noconflict/snippets/css";
import "ace-builds/src-min-noconflict/snippets/json";
import "ace-builds/src-min-noconflict/snippets/python";
import "ace-builds/src-min-noconflict/snippets/rust";
import "ace-builds/src-min-noconflict/snippets/sh";
import "ace-builds/src-min-noconflict/snippets/yaml";
import "ace-builds/src-min-noconflict/snippets/markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { lintTypeScript, shouldUseTsLint, getTsFileName } from "./ts-lint";
import { Minimap } from "./minimap";
import { attachAICompleter, setAICompleterEnabled, setAICompleterConfig } from "./ai-completer";
import { CustomAutocomplete } from "./custom-autocomplete";
import type { AISettings } from "./settings";
import * as prettier from "prettier/standalone";
import * as prettierBabel from "prettier/plugins/babel";
import * as prettierEstree from "prettier/plugins/estree";
import * as prettierTs from "prettier/plugins/typescript";
import * as prettierPostcss from "prettier/plugins/postcss";
import * as prettierHtml from "prettier/plugins/html";
import * as prettierMd from "prettier/plugins/markdown";
import * as prettierYaml from "prettier/plugins/yaml";

const PRETTIER_PLUGINS = [prettierBabel, prettierEstree, prettierTs, prettierPostcss, prettierHtml, prettierMd, prettierYaml];

const PRETTIER_PARSER_MAP: Record<string, string> = {
  js: "babel",
  jsx: "babel",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
};

export interface EditorSettings {
  theme: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  showGutter: boolean;
  showMinimap: boolean;
  aiInlineSuggestions: boolean;
  tailwindAutocomplete: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  theme: "monokai",
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  showGutter: true,
  showMinimap: false,
  aiInlineSuggestions: false,
  tailwindAutocomplete: false,
};

interface OpenTab {
  path: string;
  name: string;
  content: string;
  modified: boolean;
  pinned: boolean;
  kind?: "file" | "web";
  url?: string;
  lockedView?: boolean;
}

interface WebMediaStatePayload {
  label: string;
  isPlaying: boolean;
}

export interface EditorNavigationRequest {
  path: string;
  content: string;
  row: number;
  column: number;
}

export interface EditorHoverInfo {
  signature: string;
  documentation?: string;
  definition?: {
    path: string;
    line: number;
    column: number;
  };
}

export interface EditorHoverRequest extends EditorNavigationRequest {}

const EXT_MODE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  md: "markdown",
  py: "python",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
};

const EMMET_EXTS = new Set(["html", "htm", "jsx", "tsx"]);
const HTML_TAGS = new Set([
  "a", "article", "aside", "button", "canvas", "div", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "img", "input", "label", "li", "link", "main", "meta", "nav", "ol", "option", "p", "section",
  "select", "small", "span", "strong", "style", "svg", "table", "tbody", "td", "textarea", "th", "thead", "tr",
  "ul", "video",
]);
const VOID_HTML_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface EmmetNode {
  tag: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
  text?: string;
  repeat: number;
}

export class Editor {
  private ace: ace.Ace.Editor;
  private tabs: OpenTab[] = [];
  private activeTab: string = "";
  private draggingTabPath: string | null = null;
  private tabsContainer: HTMLElement;
  private emptyEl: HTMLElement;
  private editorEl: HTMLElement;
  private protectedBannerEl: HTMLElement;
  private currentSettings: EditorSettings = { ...DEFAULT_EDITOR_SETTINGS };
  private lintTimeout: ReturnType<typeof setTimeout> | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private minimap: Minimap | null = null;
  private customAutocomplete: CustomAutocomplete;
  private tabContextMenu: HTMLElement;
  private editorContextMenu: HTMLElement;
  private hoverTooltipEl: HTMLDivElement;
  private hoverTimeout: ReturnType<typeof setTimeout> | null = null;
  private hoverRequestId = 0;
  private hoverAnchorKey = "";
  private hoverMouseX = 0;
  private hoverMouseY = 0;
  private onAskAI: ((prompt: string, code: string) => void) | null = null;
  private onSaveCallback: ((path: string, content: string) => void) | null = null;
  private onCreateEditorTab: (() => void) | null = null;
  private onUnlockProtected: ((path: string) => void) | null = null;
  private onNavigate: ((request: EditorNavigationRequest) => Promise<void>) | null = null;
  private onHoverInfo: ((request: EditorHoverRequest) => Promise<EditorHoverInfo | null>) | null = null;
  private webFrameEl: HTMLIFrameElement;
  private tabPickerDropdown: HTMLElement;
  private webTabLabels: Map<string, string> = new Map(); // path -> webview label
  private webTabPathsByLabel: Map<string, string> = new Map();
  private webTabMediaState: Map<string, boolean> = new Map();
  private activeWebLabel: string | null = null;
  private webResizeObserver: ResizeObserver | null = null;

  constructor(editorId: string, tabsId: string, emptyId: string) {
    this.tabsContainer = document.getElementById(tabsId)!;
    this.emptyEl = document.getElementById(emptyId)!;
    this.editorEl = document.getElementById(editorId)!;

    // Set worker path so Ace can load lint workers (JS, CSS, HTML, JSON, YAML, etc.)
    ace.config.set(
      "basePath",
      "https://cdn.jsdelivr.net/npm/ace-builds@" + ace.version + "/src-min-noconflict"
    );

    this.ace = ace.edit(editorId);
    this.ace.setShowPrintMargin(false);
    this.ace.setReadOnly(false);

    // Enable linting (workers provide real-time error/warning annotations)
    this.ace.session.setUseWorker(true);

    // Enable autocompletion
    this.ace.setOptions({
      enableBasicAutocompletion: false,
      enableLiveAutocompletion: false,
      enableSnippets: true,
    });

    this.customAutocomplete = new CustomAutocomplete(this.ace);

    // Ctrl+Space / Cmd+Space to trigger autocomplete
    this.ace.commands.addCommand({
      name: "triggerAutocomplete",
      bindKey: { win: "Ctrl-Space", mac: "Cmd-Space|Ctrl-Space" },
      exec: () => {
        this.customAutocomplete.trigger();
      },
    });

    // Auto-trigger after '.', '[' or quotes for member/property completions
    this.ace.commands.on("afterExec", (e: any) => {
      if (e.command.name !== "insertstring") return;
      if (e.args === "." || e.args === "[") {
        this.customAutocomplete.trigger();
        return;
      }
      if (e.args === "\"" || e.args === "'") {
        const pos = this.ace.getCursorPosition();
        const lineUpToCursor = this.ace.session.getLine(pos.row).slice(0, pos.column);
        if (/(?:[A-Za-z_$][\w$]*|\])\[['"]$/.test(lineUpToCursor)) {
          this.customAutocomplete.trigger();
        }
      }
    });

    // Tab to accept inline completion (when visible), otherwise normal tab
    this.ace.commands.addCommand({
      name: "acceptInlineOrTab",
      bindKey: { win: "Tab", mac: "Tab" },
      exec: (editor: ace.Ace.Editor) => {
        if (this.customAutocomplete.acceptSelected()) {
          return;
        }
        if (this.expandEmmetAtCursor()) {
          return;
        }
        if ((editor as any).expandSnippet?.()) {
          return;
        }
        // Otherwise normal indent
        editor.execCommand("indent");
      },
    });

    // Init minimap (inside the editor-container, which is the parent of ace-editor)
    this.minimap = new Minimap(this.editorEl.parentElement!, this.ace);

    // Tab context menu
    this.tabContextMenu = document.createElement("div");
    this.tabContextMenu.className = "context-menu hidden";
    document.body.appendChild(this.tabContextMenu);

    // Editor right-click context menu
    this.editorContextMenu = document.createElement("div");
    this.editorContextMenu.className = "context-menu editor-context-menu hidden";
    document.body.appendChild(this.editorContextMenu);

    this.hoverTooltipEl = document.createElement("div");
    this.hoverTooltipEl.className = "editor-hover-tooltip hidden";
    document.body.appendChild(this.hoverTooltipEl);

    // Web tab iframe — lives inside editor-container, hidden by default
    // Unused iframe placeholder (kept to avoid null refs from previous setup code)
    this.webFrameEl = document.createElement("iframe");
    this.webFrameEl.className = "web-tab-frame hidden";

    // ResizeObserver keeps active child webview in sync with the editor container
    const editorContainer = this.editorEl.parentElement!;
    this.webResizeObserver = new ResizeObserver(() => this.syncActiveWebTabBounds());
    this.webResizeObserver.observe(editorContainer);
    // Also sync on window resize
    window.addEventListener("resize", () => this.syncActiveWebTabBounds());

    // Protected file banner (e.g. masked .env until unlocked)
    this.protectedBannerEl = document.createElement("div");
    this.protectedBannerEl.className = "editor-protected-banner hidden";
    this.protectedBannerEl.innerHTML = `
      <div class="editor-protected-banner-left">
        <span class="editor-protected-banner-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 7V5.75A3.5 3.5 0 0 1 8 2.25a3.5 3.5 0 0 1 3.5 3.5V7h.75A1.75 1.75 0 0 1 14 8.75v4.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-4.5A1.75 1.75 0 0 1 3.75 7h.75zm1.5 0h4V5.75A2 2 0 1 0 6 5.75V7z"/></svg>
        </span>
        <span class="editor-protected-banner-text">Protected secrets are hidden.</span>
      </div>
      <button class="editor-protected-banner-btn" type="button">Unlock to reveal</button>
    `;
    const bannerBtn = this.protectedBannerEl.querySelector(".editor-protected-banner-btn") as HTMLButtonElement;
    bannerBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.activeTab) this.onUnlockProtected?.(this.activeTab);
    });
    editorContainer.appendChild(this.protectedBannerEl);

    // New tab picker dropdown
    this.tabPickerDropdown = document.createElement("div");
    this.tabPickerDropdown.className = "tab-picker hidden";
    this.tabPickerDropdown.innerHTML = this.buildTabPickerHTML();
    document.body.appendChild(this.tabPickerDropdown);
    this.setupTabPickerListeners();

    document.addEventListener("click", () => {
      this.tabContextMenu.classList.add("hidden");
      this.editorContextMenu.classList.add("hidden");
      this.setTabPickerVisible(false);
    });
    document.addEventListener("contextmenu", (e) => {
      if (!this.tabContextMenu.contains(e.target as Node)) {
        this.tabContextMenu.classList.add("hidden");
      }
    });

    // Editor right-click
    this.editorEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showEditorContextMenu(e as MouseEvent);
    });

    // Cmd/Ctrl + click to open URLs or navigate to definitions in the editor
    this.editorEl.addEventListener("click", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      void this.handleModifierClick(e as MouseEvent);
    });
    this.editorEl.addEventListener("mousemove", this.onEditorMouseMove);
    this.editorEl.addEventListener("mouseleave", this.hideHoverTooltip);
    this.editorEl.addEventListener("mousedown", this.hideHoverTooltip);
    this.ace.on("changeSelection", this.hideHoverTooltip);
    this.ace.session.on("changeScrollTop", this.hideHoverTooltip);
    this.ace.session.on("changeScrollLeft", this.hideHoverTooltip);

    // Attach AI ghost text completer
    attachAICompleter(this.ace);

    this.applySettings(DEFAULT_EDITOR_SETTINGS);

    void listen<WebMediaStatePayload>("web-media-state", ({ payload }) => {
      this.handleWebMediaState(payload);
    });

    // Auto-save and lint on change (debounced)
    this.ace.on("change", () => {
      const tab = this.tabs.find((t) => t.path === this.activeTab);
      if (tab && !tab.lockedView) {
        tab.content = this.ace.getValue();
        tab.modified = true;
        this.renderTabs();
      }
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      if (tab?.lockedView) return;
      this.saveTimeout = setTimeout(() => this.saveCurrentFile(), 1000);

      // Debounced TS/TSX/JSX lint
      if (this.lintTimeout) clearTimeout(this.lintTimeout);
      this.lintTimeout = setTimeout(() => this.runTsLint(), 400);
    });

    // Initially hide editor
    this.editorEl.style.display = "none";

    // Render initial tab bar (shows + button even with no tabs)
    this.renderTabs();
  }

  applySettings(settings: EditorSettings) {
    this.currentSettings = { ...settings };

    // Theme and font size are global on the editor instance
    this.ace.setTheme(`ace/theme/${settings.theme}`);
    this.ace.setFontSize(settings.fontSize);
    this.ace.renderer.setShowGutter(settings.showGutter);

    // Session-level settings need to be applied to current session
    this.ace.session.setTabSize(settings.tabSize);
    this.ace.session.setUseWrapMode(settings.wordWrap);

    // Minimap
    if (this.minimap) {
      this.minimap.setVisible(settings.showMinimap);
    }

    // AI inline suggestions
    setAICompleterEnabled(settings.aiInlineSuggestions);

    // Force a re-render
    this.ace.renderer.updateFull(true);
  }

  async openFile(path: string, name: string, line?: number, column?: number) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.switchToTab(path);
      if (line !== undefined) this.gotoPosition(line, column);
      return;
    }

    let content: string;
    try {
      content = await invoke<string>("read_file", { path });
    } catch (e) {
      console.error("Failed to read file:", e);
      return;
    }

    const tab: OpenTab = { path, name, content, modified: false, pinned: false };
    this.tabs.push(tab);
    this.switchToTab(path);
    if (line !== undefined) this.gotoPosition(line, column);
  }

  openFileWithContent(path: string, name: string, content: string, lockedView: boolean) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      existing.content = content;
      existing.modified = false;
      existing.lockedView = lockedView;
      this.switchToTab(path);
      return;
    }
    const tab: OpenTab = { path, name, content, modified: false, pinned: false, lockedView };
    this.tabs.push(tab);
    this.switchToTab(path);
  }

  gotoLine(line: number) {
    this.gotoPosition(line, 1);
  }

  gotoPosition(line: number, column = 1) {
    // Ace gotoLine uses 1-based line numbers and 0-based columns.
    this.ace.gotoLine(line, Math.max(0, column - 1), true);
    this.ace.focus();
  }

  async reloadFile(path: string) {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;
    try {
      const content = await invoke<string>("read_file", { path });
      tab.content = content;
      tab.modified = false;
      tab.lockedView = false;
      if (this.activeTab === path) {
        const cursor = this.ace.getCursorPosition();
        this.ace.setValue(content, -1);
        this.ace.moveCursorToPosition(cursor);
        this.ace.clearSelection();
        this.ace.setReadOnly(false);
      }
      this.renderTabs();
      this.updateProtectedBanner(tab);
    } catch (e) {
      console.error("Failed to reload file:", e);
    }
  }

  closeTab(path: string) {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;

    const tab = this.tabs[idx];
    if (tab.kind === "web") {
      const label = this.webTabLabels.get(path);
      if (label) {
        void invoke("close_web_window", { label });
        this.webTabLabels.delete(path);
        this.webTabPathsByLabel.delete(label);
        if (this.activeWebLabel === label) this.activeWebLabel = null;
      }
      this.webTabMediaState.delete(path);
    }

    this.tabs.splice(idx, 1);

    if (this.activeTab === path) {
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIdx].path);
      } else {
        this.activeTab = "";
        this.ace.setValue("");
        this.ace.setReadOnly(false);
        this.editorEl.style.display = "none";
        this.emptyEl.style.display = "flex";
        this.protectedBannerEl.classList.add("hidden");
      }
    }

    this.renderTabs();
    return this.activeTab;
  }

  getActiveFilePath(): string {
    return this.activeTab;
  }

  getActiveFileContent(): string {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab) return "";
    if (tab.path === this.activeTab) {
      return this.ace.getValue();
    }
    return tab.content;
  }

  /** Insert text at current cursor position */
  insertText(text: string) {
    this.ace.insert(text);
    this.ace.focus();
  }

  /** Insert an Ace snippet so tabstops and placeholders remain interactive */
  insertSnippet(snippet: string) {
    (this.ace as any).insertSnippet(snippet);
    this.ace.focus();
  }

  /** Add a custom completer to the Ace editor */
  addCompleter(completer: ace.Ace.Completer) {
    this.customAutocomplete.addCompleter(completer);
  }

  setOnCreateEditorTab(callback: () => void) {
    this.onCreateEditorTab = callback;
  }

  setOnUnlockProtected(callback: (path: string) => void) {
    this.onUnlockProtected = callback;
  }

  setOnNavigate(callback: (request: EditorNavigationRequest) => Promise<void>) {
    this.onNavigate = callback;
  }

  setOnHoverInfo(callback: (request: EditorHoverRequest) => Promise<EditorHoverInfo | null>) {
    this.onHoverInfo = callback;
  }

  private switchToTab(path: string) {
    const prevWebLabel = this.activeWebLabel;
    this.activeTab = path;
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;

    // Cancel any pending save when switching tabs — especially important for locked (.env) tabs
    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }

    this.emptyEl.style.display = "none";

    if (tab.kind === "web") {
      // Hide the ace editor, show the child webview instead
      this.editorEl.style.display = "none";
      this.protectedBannerEl.classList.add("hidden");
      this.activeWebLabel = this.webTabLabels.get(path) ?? null;
      if (prevWebLabel && prevWebLabel !== this.activeWebLabel) {
        void invoke("hide_web_window", { label: prevWebLabel });
      }
      if (this.activeWebLabel) {
        const bounds = this.getEditorContainerBounds();
        void invoke("open_web_window", {
          url: tab.url!,
          label: this.activeWebLabel,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      }
      this.renderTabs();
      return;
    }

    // Hide any active web tab when switching to a file tab
    if (prevWebLabel) {
      void invoke("hide_web_window", { label: prevWebLabel });
      this.activeWebLabel = null;
    }

    this.editorEl.style.display = "block";

    // Expose current file path for completers (e.g. exports-tracker)
    (this.ace as any).__athvaFilePath = path;

    this.ace.setValue(tab.content, -1);
    this.ace.clearSelection();

    const ext = tab.name.split(".").pop()?.toLowerCase() || "";
    const mode = EXT_MODE_MAP[ext] || "text";
    this.ace.session.setMode(`ace/mode/${mode}`);

    // Set filename for AI completer context
    (this.ace as any)._athvaFileName = tab.name;

    // Reapply session-level settings after mode change
    this.ace.session.setTabSize(this.currentSettings.tabSize);
    this.ace.session.setUseWrapMode(this.currentSettings.wordWrap);
    // For TS/TSX/JSX: disable Ace's built-in worker (useless) and use our TS linter
    // For JS/CSS/HTML/JSON/YAML: keep Ace's worker
    if (shouldUseTsLint(tab.name)) {
      this.ace.session.setUseWorker(false);
      this.runTsLint();
    } else {
      this.ace.session.setUseWorker(true);
    }

    this.ace.setReadOnly(!!tab.lockedView);
    this.updateProtectedBanner(tab);

    this.renderTabs();
    this.ace.focus();
    this.ace.resize();
  }

  private updateProtectedBanner(tab: OpenTab) {
    const shouldShow = tab.kind !== "web" && !!tab.lockedView && tab.path === this.activeTab;
    this.protectedBannerEl.classList.toggle("hidden", !shouldShow);
  }

  private getEditorContainerBounds(): { x: number; y: number; width: number; height: number } {
    const container = document.getElementById("editor-container") ?? this.editorEl.parentElement!;
    const rect = container.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private syncActiveWebTabBounds() {
    if (!this.activeWebLabel) return;
    const bounds = this.getEditorContainerBounds();
    void invoke("resize_web_window", {
      label: this.activeWebLabel,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  }

  private expandEmmetAtCursor(): boolean {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    const ext = tab?.name.split(".").pop()?.toLowerCase() || "";
    if (!EMMET_EXTS.has(ext)) return false;

    const cursor = this.ace.getCursorPosition();
    const line = this.ace.session.getLine(cursor.row);
    const beforeCursor = line.slice(0, cursor.column);
    const match = beforeCursor.match(/([A-Za-z][A-Za-z0-9:_-]*(?:[A-Za-z0-9:_\-#.>\[\]="'\{\}*+$@])*|[.#][A-Za-z0-9_-][A-Za-z0-9:_\-#.>\[\]="'\{\}*+$@]*)$/);
    const abbreviation = match?.[1];
    if (!abbreviation || abbreviation.length < 1) return false;
    if (!/[.#>\[*{]/.test(abbreviation) && !HTML_TAGS.has(abbreviation) && !abbreviation.includes("-")) {
      return false;
    }

    const snippet = this.expandEmmetAbbreviation(abbreviation, ext === "jsx" || ext === "tsx");
    if (!snippet) return false;

    const startColumn = cursor.column - abbreviation.length;
    this.ace.session.replace(
      { start: { row: cursor.row, column: startColumn }, end: cursor } as any,
      ""
    );
    (this.ace as any).insertSnippet(snippet);
    return true;
  }

  private expandEmmetAbbreviation(abbreviation: string, jsx: boolean): string | null {
    const parts = abbreviation.split(">").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;

    const nodes = parts.map((part) => this.parseEmmetNode(part));
    if (nodes.some((node) => !node)) return null;

    let inner = "$0";
    for (let index = nodes.length - 1; index >= 0; index--) {
      inner = this.renderEmmetNode(nodes[index]!, inner, jsx);
    }
    return inner;
  }

  private parseEmmetNode(part: string): EmmetNode | null {
    const repeatMatch = part.match(/\*(\d+)$/);
    const repeat = repeatMatch ? Math.max(1, Math.min(50, Number(repeatMatch[1]))) : 1;
    let source = repeatMatch ? part.slice(0, -repeatMatch[0].length) : part;

    let text: string | undefined;
    source = source.replace(/\{([^}]*)\}/, (_match, value: string) => {
      text = value;
      return "";
    });

    const attrs: EmmetNode["attrs"] = [];
    source = source.replace(/\[([^\]]+)\]/g, (_match, rawAttrs: string) => {
      rawAttrs.trim().split(/\s+/).filter(Boolean).forEach((rawAttr) => {
        const [name, rawValue] = rawAttr.split("=");
        if (!name) return;
        attrs.push({ name, value: rawValue?.replace(/^['"]|['"]$/g, "") });
      });
      return "";
    });

    const tagMatch = source.match(/^[A-Za-z][A-Za-z0-9:_-]*/);
    let tag = tagMatch?.[0] || "div";
    if (source.startsWith(".")) tag = "div";
    if (source.startsWith("#")) tag = "div";

    const id = source.match(/#([A-Za-z0-9_-]+)/)?.[1];
    const classes = [...source.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);

    if (!tag || (!tagMatch && !source.startsWith(".") && !source.startsWith("#"))) return null;
    return { tag, id, classes, attrs, text, repeat };
  }

  private renderEmmetNode(node: EmmetNode, inner: string, jsx: boolean): string {
    const rendered = Array.from({ length: node.repeat }, (_, index) => {
      const attrs = this.renderEmmetAttrs(node, jsx, index);
      const content = node.text ?? inner;
      const multiline = content.includes("\n") || content === "$0" || node.repeat > 1;
      if (this.isVoidHtmlTag(node.tag)) {
        return `<${node.tag}${attrs} />`;
      }
      if (!multiline) {
        return `<${node.tag}${attrs}>${content}</${node.tag}>`;
      }
      const indented = content.split("\n").map((line) => `  ${line}`).join("\n");
      return `<${node.tag}${attrs}>\n${indented}\n</${node.tag}>`;
    });

    return rendered.join("\n");
  }

  private renderEmmetAttrs(node: EmmetNode, jsx: boolean, index: number): string {
    const attrs: string[] = [];
    if (node.id) attrs.push(`id="${this.applyEmmetIndex(node.id, index)}"`);
    if (node.classes.length) {
      const attrName = jsx ? "className" : "class";
      attrs.push(`${attrName}="${node.classes.map((name) => this.applyEmmetIndex(name, index)).join(" ")}"`);
    }
    for (const attr of node.attrs) {
      const name = jsx && attr.name === "class" ? "className" : attr.name;
      if (attr.value === undefined) {
        attrs.push(jsx ? `${name}={true}` : name);
      } else {
        attrs.push(`${name}="${this.applyEmmetIndex(attr.value, index)}"`);
      }
    }
    return attrs.length ? ` ${attrs.join(" ")}` : "";
  }

  private applyEmmetIndex(value: string, index: number): string {
    return value.replace(/\$/g, String(index + 1));
  }

  private isVoidHtmlTag(tag: string): boolean {
    return VOID_HTML_TAGS.has(tag);
  }

  pinTab(path: string) {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    // Keep pinned tabs grouped at the front
    if (tab.pinned) {
      this.tabs.splice(this.tabs.indexOf(tab), 1);
      const firstUnpinned = this.tabs.findIndex((t) => !t.pinned);
      this.tabs.splice(firstUnpinned === -1 ? this.tabs.length : firstUnpinned, 0, tab);
    }
    this.renderTabs();
  }

  closeOtherTabs(path: string) {
    const toClose = this.tabs.filter((t) => t.path !== path && !t.pinned);
    toClose.forEach((t) => this.closeTab(t.path));
  }

  closeAllTabs() {
    const toClose = [...this.tabs];
    toClose.forEach((t) => this.closeTab(t.path));
  }

  openWebTab(url: string, title: string) {
    const id = `web:${url}`;
    const label = `web-${title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    const existing = this.tabs.find((t) => t.path === id);
    if (existing) {
      this.switchToTab(id);
      return;
    }
    const tab: OpenTab = { path: id, name: title, content: "", modified: false, pinned: false, kind: "web", url };
    this.webTabLabels.set(id, label);
    this.webTabPathsByLabel.set(label, id);
    this.webTabMediaState.set(id, false);
    this.tabs.push(tab);
    this.switchToTab(id);
  }

  openNewTabPicker(anchor?: HTMLElement | null) {
    const target = anchor ?? this.tabsContainer.querySelector("#btn-add-tab") ?? this.tabsContainer;
    const rect = target.getBoundingClientRect();
    this.positionTabPicker(rect);
    this.setTabPickerKind("editor");
    this.setTabPickerVisible(true);
  }

  private toggleTabPicker(anchor: HTMLElement) {
    const isHidden = this.tabPickerDropdown.classList.contains("hidden");
    if (!isHidden) {
      this.setTabPickerVisible(false);
      return;
    }
    this.openNewTabPicker(anchor);
  }

  private positionTabPicker(rect: DOMRect) {
    this.tabPickerDropdown.style.top = `${rect.bottom + 4}px`;
    const left = Math.min(rect.left, window.innerWidth - 300);
    this.tabPickerDropdown.style.left = `${Math.max(4, left)}px`;
  }

  private setTabPickerVisible(visible: boolean, restoreActiveWebView = true) {
    const wasVisible = !this.tabPickerDropdown.classList.contains("hidden");
    if (wasVisible === visible) return;
    this.tabPickerDropdown.classList.toggle("hidden", !visible);
    if (visible) {
      if (this.activeWebLabel) {
        void invoke("hide_web_window", { label: this.activeWebLabel });
      }
      this.focusActiveTabPickerControl();
      return;
    }
    if (restoreActiveWebView && this.activeWebLabel) {
      const bounds = this.getEditorContainerBounds();
      void invoke("open_web_window", {
        url: "",
        label: this.activeWebLabel,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    }
  }

  private focusActiveTabPickerControl() {
    requestAnimationFrame(() => {
      const activeType = this.tabPickerDropdown.querySelector(".tab-picker-type.active") as HTMLElement | null;
      const targetSelector = activeType?.dataset.kind === "web" ? ".tab-picker-input" : ".tab-picker-action";
      (this.tabPickerDropdown.querySelector(targetSelector) as HTMLElement | null)?.focus();
    });
  }

  private setTabPickerKind(kind: "editor" | "web") {
    this.tabPickerDropdown.querySelectorAll<HTMLElement>(".tab-picker-type").forEach((button) => {
      button.classList.toggle("active", button.dataset.kind === kind);
    });
    this.tabPickerDropdown.querySelectorAll<HTMLElement>(".tab-picker-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.panel !== kind);
    });
    this.focusActiveTabPickerControl();
  }

  private buildTabPickerHTML(): string {
    const presets = [
      { label: "YouTube", url: "https://www.youtube.com", icon: "▶" },
      { label: "YouTube Music", url: "https://music.youtube.com", icon: "♪" },
      { label: "Spotify", url: "https://open.spotify.com", icon: "●" },
      { label: "Apple Music", url: "https://music.apple.com", icon: "♫" },
    ];

    return `
      <div class="tab-picker-head">Open new tab</div>
      <div class="tab-picker-types">
        <button class="tab-picker-type active" data-kind="editor" type="button">Editor</button>
        <button class="tab-picker-type" data-kind="web" type="button">Web</button>
      </div>
      <div class="tab-picker-panel" data-panel="editor">
        <button class="tab-picker-action" type="button">
          <span class="tab-picker-action-icon">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zm0 1h11a.5.5 0 0 1 .5.5V5H2V3.5a.5.5 0 0 1 .5-.5zm-.5 3h12v6.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V6z"/></svg>
          </span>
          <span>
            <strong>Open file in editor</strong>
            <small>Use Quick Open to choose a workspace file</small>
          </span>
        </button>
      </div>
      <div class="tab-picker-panel hidden" data-panel="web">
        <div class="tab-picker-presets">
        ${presets.map((p) => `
          <button class="tab-picker-preset" data-url="${p.url}" data-label="${p.label}" type="button">
            <span class="tab-picker-preset-icon">${p.icon}</span>
            <span>${p.label}</span>
          </button>
        `).join("")}
        </div>
        <div class="tab-picker-divider"></div>
        <div class="tab-picker-custom">
          <input class="tab-picker-input" type="url" placeholder="https://..." spellcheck="false" />
          <button class="tab-picker-go" type="button">Open</button>
        </div>
      </div>
    `;
  }

  private setupTabPickerListeners() {
    this.tabPickerDropdown.addEventListener("click", (e) => {
      e.stopPropagation();
      const typeButton = (e.target as HTMLElement).closest(".tab-picker-type") as HTMLElement | null;
      if (typeButton?.dataset.kind === "editor" || typeButton?.dataset.kind === "web") {
        this.setTabPickerKind(typeButton.dataset.kind as "editor" | "web");
        return;
      }
      const openEditorAction = (e.target as HTMLElement).closest(".tab-picker-action");
      if (openEditorAction) {
        this.setTabPickerVisible(false, false);
        this.onCreateEditorTab?.();
        return;
      }
      const preset = (e.target as HTMLElement).closest(".tab-picker-preset") as HTMLElement | null;
      if (preset) {
        const url = preset.dataset.url!;
        const label = preset.dataset.label!;
        this.setTabPickerVisible(false, false);
        this.openWebTab(url, label);
        return;
      }
      const goBtn = (e.target as HTMLElement).closest(".tab-picker-go");
      if (goBtn) {
        const input = this.tabPickerDropdown.querySelector(".tab-picker-input") as HTMLInputElement;
        let url = input.value.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        const label = new URL(url).hostname.replace(/^www\./, "");
        this.setTabPickerVisible(false, false);
        input.value = "";
        this.openWebTab(url, label);
      }
    });

    this.tabPickerDropdown.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const input = this.tabPickerDropdown.querySelector(".tab-picker-input") as HTMLInputElement;
        if (document.activeElement === input) {
          let url = input.value.trim();
          if (!url) return;
          if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
          const label = new URL(url).hostname.replace(/^www\./, "");
          this.setTabPickerVisible(false, false);
          input.value = "";
          this.openWebTab(url, label);
        }
      }
      if (e.key === "Escape") {
        this.setTabPickerVisible(false);
      }
    });
  }

  private handleWebMediaState(payload: WebMediaStatePayload) {
    const path = this.webTabPathsByLabel.get(payload.label);
    if (!path) return;
    if (this.webTabMediaState.get(path) === payload.isPlaying) return;
    this.webTabMediaState.set(path, payload.isPlaying);
    this.renderTabs();
  }

  private showTabContextMenu(e: MouseEvent, path: string) {
    const tab = this.tabs.find((t) => t.path === path)!;
    this.tabContextMenu.innerHTML = "";

    const items: { label?: string; action?: () => void; separator?: boolean }[] = [
      { label: tab.pinned ? "Unpin Tab" : "Pin Tab", action: () => this.pinTab(path) },
      { separator: true },
      { label: "Close Other Tabs", action: () => this.closeOtherTabs(path) },
      { label: "Close All Tabs", action: () => this.closeAllTabs() },
    ];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        this.tabContextMenu.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.textContent = item.label!;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.tabContextMenu.classList.add("hidden");
        item.action?.();
      });
      this.tabContextMenu.appendChild(row);
    }

    this.tabContextMenu.classList.remove("hidden");
    this.tabContextMenu.style.left = `${e.clientX}px`;
    this.tabContextMenu.style.top = `${e.clientY}px`;

    requestAnimationFrame(() => {
      const rect = this.tabContextMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.tabContextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        this.tabContextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  }

  private renderTabs() {
    const tabsHTML = this.tabs
      .map(
        (tab) => {
          const isWeb = tab.kind === "web";
          const isPlaying = isWeb && this.webTabMediaState.get(tab.path) === true;
          return `
      <div class="editor-tab ${tab.path === this.activeTab ? "active" : ""}${tab.pinned ? " pinned" : ""}${tab.kind === "web" ? " web-tab" : ""}" data-path="${this.escapeAttr(tab.path)}">
        ${tab.pinned ? `<span class="editor-tab-pin">&#x2605;</span>` : ""}
        ${isWeb ? `<span class="editor-tab-web-icon"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13A6.5 6.5 0 0 1 8 1.5zM6.3 3.1C5.5 4.3 5 5.9 4.9 7.3H2.6a5.4 5.4 0 0 1 3.7-4.2zm3.4 0a5.4 5.4 0 0 1 3.7 4.2h-2.3c-.1-1.4-.6-3-1.4-4.2zM4.9 8.7c.1 1.4.6 3 1.4 4.2A5.4 5.4 0 0 1 2.6 8.7H4.9zm5.2 0h2.3a5.4 5.4 0 0 1-3.7 4.2c.8-1.2 1.3-2.8 1.4-4.2zM6.4 8.7h3.2c-.1 1.2-.5 2.6-1.1 3.6-.3.5-.5.7-.5.7s-.2-.2-.5-.7c-.6-1-.9-2.4-1.1-3.6zm0-1.4c.2-1.2.5-2.6 1.1-3.6.3-.5.5-.7.5-.7s.2.2.5.7c.6 1 .9 2.4 1.1 3.6H6.4z"/></svg></span>` : ""}
        <span class="editor-tab-label">
          <span class="editor-tab-title">${this.escapeHtml(tab.name)}${tab.modified ? " \u2022" : ""}</span>
          ${isPlaying ? `<span class="editor-tab-media-indicator" title="Media playing" aria-label="Media playing"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 6.25a.75.75 0 0 1 1.28-.53L7.06 8l-2.28 2.28A.75.75 0 1 1 3.72 9.22L4.94 8 3.72 6.78a.75.75 0 0 1-.22-.53zm4-.78a.75.75 0 0 1 .75.75v3.56a.75.75 0 1 1-1.5 0V6.22a.75.75 0 0 1 .75-.75zm2.7 1.07a.75.75 0 0 1 1.06 0 2.75 2.75 0 0 1 0 3.89.75.75 0 1 1-1.06-1.06 1.25 1.25 0 0 0 0-1.77.75.75 0 0 1 0-1.06zm2.06-1.9a.75.75 0 0 1 1.06 0 5.43 5.43 0 0 1 0 7.68.75.75 0 0 1-1.06-1.06 3.93 3.93 0 0 0 0-5.56.75.75 0 0 1 0-1.06z"/></svg></span>` : ""}
        </span>
        <button class="editor-tab-close" data-close="${this.escapeAttr(tab.path)}">\u00D7</button>
      </div>
    `
        }
      )
      .join("");

    const addTabBtn = `<button class="editor-tab-add" id="btn-add-tab" title="Open new tab">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14H8v-1H2.5a.5.5 0 0 1-.5-.5V6h12v2.5h1V3.5A1.5 1.5 0 0 0 13.5 2h-11zm0 1h11a.5.5 0 0 1 .5.5V5H2V3.5a.5.5 0 0 1 .5-.5zm9.75 6a.5.5 0 0 1 .5.5V12h2.5a.5.5 0 0 1 0 1h-2.5v2.5a.5.5 0 0 1-1 0V13h-2.5a.5.5 0 0 1 0-1h2.5V9.5a.5.5 0 0 1 .5-.5z"/></svg>
    </button>`;

    this.tabsContainer.innerHTML = tabsHTML + addTabBtn;

    this.tabsContainer.querySelectorAll(".editor-tab").forEach((el) => {
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".editor-tab-close")) return;
        const path = (el as HTMLElement).dataset.path!;
        this.switchToTab(path);
      });
      el.addEventListener("mousedown", (e) => {
        const me = e as MouseEvent;
        if (me.button === 2) { me.preventDefault(); return; }
        if (me.button !== 0) return;
        if ((me.target as HTMLElement).closest(".editor-tab-close")) return;

        const fromPath = (el as HTMLElement).dataset.path!;
        let dragging = false;
        const startX = me.clientX;
        const startY = me.clientY;

        const onMouseMove = (moveEvent: MouseEvent) => {
          if (!dragging) {
            if (Math.abs(moveEvent.clientX - startX) < 5 && Math.abs(moveEvent.clientY - startY) < 5) return;
            dragging = true;
            this.draggingTabPath = fromPath;
            el.classList.add("dragging");
          }
          // Update drop indicator on hovered tab
          this.tabsContainer.querySelectorAll(".editor-tab").forEach((t) => {
            t.classList.remove("drag-over-before", "drag-over-after");
          });
          const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(".editor-tab") as HTMLElement | null;
          if (target && target !== el) {
            const rect = target.getBoundingClientRect();
            const before = moveEvent.clientX < rect.left + rect.width / 2;
            target.classList.toggle("drag-over-before", before);
            target.classList.toggle("drag-over-after", !before);
          }
        };

        const onMouseUp = (upEvent: MouseEvent) => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          if (!dragging) { this.draggingTabPath = null; return; }

          el.classList.remove("dragging");
          this.tabsContainer.querySelectorAll(".editor-tab").forEach((t) => {
            t.classList.remove("drag-over-before", "drag-over-after");
          });

          const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest(".editor-tab") as HTMLElement | null;
          const toPath = target?.dataset.path;
          this.draggingTabPath = null;

          if (toPath && toPath !== fromPath) {
            const rect = target!.getBoundingClientRect();
            const before = upEvent.clientX < rect.left + rect.width / 2;
            this.moveTab(fromPath, toPath, before);
          }
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const path = (el as HTMLElement).dataset.path!;
        this.showTabContextMenu(e as MouseEvent, path);
      });
    });

    this.tabsContainer.querySelectorAll(".editor-tab-close").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const path = (btn as HTMLElement).dataset.close!;
        this.closeTab(path);
      });
    });

    const addTabBtnEl = this.tabsContainer.querySelector("#btn-add-tab");
    addTabBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleTabPicker((e.currentTarget ?? e.target) as HTMLElement);
    });
  }

  private moveTab(fromPath: string, targetPath: string, insertBefore: boolean) {
    const fromIdx = this.tabs.findIndex((t) => t.path === fromPath);
    const targetIdx = this.tabs.findIndex((t) => t.path === targetPath);
    if (fromIdx === -1 || targetIdx === -1) return;

    const fromTab = this.tabs[fromIdx];
    const targetTab = this.tabs[targetIdx];

    // Keep pinned tabs grouped at the front.
    const firstUnpinnedIdx = this.tabs.findIndex((t) => !t.pinned);
    const pinnedCount = firstUnpinnedIdx === -1 ? this.tabs.length : firstUnpinnedIdx;

    let effectiveTargetIdx = targetIdx;
    if (!!fromTab.pinned !== !!targetTab.pinned) {
      effectiveTargetIdx = fromTab.pinned ? pinnedCount - 1 : pinnedCount;
      insertBefore = fromTab.pinned;
    }

    // Remove then insert at the computed position.
    this.tabs.splice(fromIdx, 1);
    if (fromIdx < effectiveTargetIdx) effectiveTargetIdx--;

    const insertAt = insertBefore ? effectiveTargetIdx : effectiveTargetIdx + 1;
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, insertAt)), 0, fromTab);
    this.renderTabs();
  }

  private async saveCurrentFile() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab || !tab.modified || tab.lockedView) return;

    try {
      await invoke("write_file", { path: tab.path, content: tab.content });
      tab.modified = false;
      this.renderTabs();
      this.onSaveCallback?.(tab.path, tab.content);
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  private async runTsLint() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab || !shouldUseTsLint(tab.name)) return;

    const code = this.ace.getValue();
    const fileName = getTsFileName(tab.name);

    try {
      const annotations = await lintTypeScript(fileName, code);
      // Only apply if we're still on the same tab
      if (this.activeTab === tab.path) {
        this.ace.session.setAnnotations(annotations);
      }
    } catch {
      // Silently ignore lint errors
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  private escapeAttr(str: string): string {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  private clearHoverTimeout() {
    if (!this.hoverTimeout) return;
    clearTimeout(this.hoverTimeout);
    this.hoverTimeout = null;
  }

  private hideHoverTooltip = () => {
    this.clearHoverTimeout();
    this.hoverRequestId++;
    this.hoverAnchorKey = "";
    this.hoverTooltipEl.classList.add("hidden");
    this.hoverTooltipEl.innerHTML = "";
  };

  private onEditorMouseMove = (event: MouseEvent) => {
    if (!this.activeTab || !this.onHoverInfo || this.customAutocomplete.hasOpenPopup()) {
      this.hideHoverTooltip();
      return;
    }

    const target = this.getHoverTarget(event);
    if (!target) {
      this.hideHoverTooltip();
      return;
    }

    this.hoverMouseX = event.clientX;
    this.hoverMouseY = event.clientY;

    if (target.key === this.hoverAnchorKey) {
      if (!this.hoverTooltipEl.classList.contains("hidden")) {
        this.positionHoverTooltip(this.hoverMouseX, this.hoverMouseY);
      }
      return;
    }

    this.clearHoverTimeout();
    this.hoverTooltipEl.classList.add("hidden");
    this.hoverAnchorKey = target.key;
    this.hoverTimeout = setTimeout(() => {
      void this.showHoverTooltip(target);
    }, 2500);
  };

  private getHoverTarget(event: MouseEvent): { key: string; row: number; column: number } | null {
    const pos = this.ace.renderer.screenToTextCoordinates(event.clientX, event.clientY);
    if (pos.row < 0 || pos.row >= this.ace.session.getLength()) return null;

    const line = this.ace.session.getLine(pos.row);
    const rawColumn = Math.max(0, Math.min(pos.column, line.length));
    const charAt = line[rawColumn] ?? "";
    const charBefore = line[rawColumn - 1] ?? "";
    if (!/[\w$]/.test(charAt) && !/[\w$]/.test(charBefore)) return null;

    const symbolColumn = /[\w$]/.test(charAt) ? rawColumn : rawColumn - 1;
    let start = symbolColumn;
    let end = symbolColumn + 1;
    while (start > 0 && /[\w$]/.test(line[start - 1])) start--;
    while (end < line.length && /[\w$]/.test(line[end])) end++;

    const symbol = line.slice(start, end);
    if (!symbol) return null;

    return {
      key: `${this.activeTab}:${pos.row}:${start}:${end}:${symbol}`,
      row: pos.row,
      column: Math.max(start, Math.min(symbolColumn, end - 1)),
    };
  }

  private async showHoverTooltip(target: { key: string; row: number; column: number }) {
    this.clearHoverTimeout();
    if (!this.activeTab || !this.onHoverInfo) return;

    const requestId = ++this.hoverRequestId;
    const info = await this.onHoverInfo({
      path: this.activeTab,
      content: this.ace.getValue(),
      row: target.row,
      column: target.column,
    }).catch(() => null);

    if (requestId !== this.hoverRequestId || target.key !== this.hoverAnchorKey || !info) return;

    const documentation = info.documentation
      ? `<div class="editor-hover-doc">${this.escapeHtml(info.documentation)}</div>`
      : "";
    const definition = info.definition
      ? `<div class="editor-hover-definition">Defined in ${this.escapeHtml(info.definition.path)}:${info.definition.line}:${info.definition.column}</div>`
      : "";

    this.hoverTooltipEl.innerHTML = `
      <pre class="editor-hover-signature">${this.escapeHtml(info.signature)}</pre>
      ${documentation}
      ${definition}
    `;
    this.hoverTooltipEl.classList.remove("hidden");
    this.positionHoverTooltip(this.hoverMouseX, this.hoverMouseY);
  }

  private positionHoverTooltip(clientX: number, clientY: number) {
    const margin = 12;
    const offset = 16;
    this.hoverTooltipEl.style.left = `${clientX + offset}px`;
    this.hoverTooltipEl.style.top = `${clientY + offset}px`;

    requestAnimationFrame(() => {
      const rect = this.hoverTooltipEl.getBoundingClientRect();
      const left = rect.right > window.innerWidth - margin
        ? Math.max(margin, window.innerWidth - rect.width - margin)
        : clientX + offset;
      const top = rect.bottom > window.innerHeight - margin
        ? Math.max(margin, clientY - rect.height - offset)
        : clientY + offset;
      this.hoverTooltipEl.style.left = `${left}px`;
      this.hoverTooltipEl.style.top = `${top}px`;
    });
  }

  private async handleModifierClick(e: MouseEvent) {
    const pos = this.ace.renderer.screenToTextCoordinates(e.clientX, e.clientY);
    const line = this.ace.session.getLine(pos.row);
    const urlRegex = /https?:\/\/[^\s"')\]>]+/g;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(line)) !== null) {
      if (pos.column >= match.index && pos.column <= match.index + match[0].length) {
        e.preventDefault();
        await import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(match![0]))
          .catch(() => {});
        return;
      }
    }

    if (!this.activeTab || !this.onNavigate) return;
    e.preventDefault();
    await this.onNavigate({
      path: this.activeTab,
      content: this.ace.getValue(),
      row: pos.row,
      column: pos.column,
    });
  }

  setAISettings(getter: () => AISettings) {
    setAICompleterConfig(getter);
  }

  openSearch() {
    this.ace.execCommand("find");
  }

  openReplace() {
    this.ace.execCommand("replace");
  }

  hasOpenFile(): boolean {
    return this.tabs.length > 0;
  }

  async formatDocument() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab) return;

    const ext = tab.name.split(".").pop()?.toLowerCase() || "";
    const parser = PRETTIER_PARSER_MAP[ext];
    if (!parser) return; // No formatter for this file type

    const code = this.ace.getValue();
    const cursor = this.ace.getCursorPosition();

    try {
      const formatted = await prettier.format(code, {
        parser,
        plugins: PRETTIER_PLUGINS as any,
        tabWidth: this.currentSettings.tabSize,
        useTabs: false,
        singleQuote: true,
        semi: true,
        trailingComma: "all",
      });

      if (formatted !== code) {
        this.ace.setValue(formatted, -1);
        this.ace.clearSelection();
        // Restore cursor as close as possible
        this.ace.moveCursorToPosition(cursor);
        this.ace.renderer.scrollCursorIntoView(cursor, 0.5);
      }
    } catch (e) {
      console.error("Format failed:", e);
    }
  }

  /** Replace the entire content of the active file in the editor. */
  setContent(content: string) {
    if (!this.activeTab) return;
    const cursor = this.ace.getCursorPosition();
    this.ace.setValue(content, -1);
    this.ace.clearSelection();
    this.ace.moveCursorToPosition(cursor);
    this.ace.renderer.scrollCursorIntoView(cursor, 0.5);
  }

  resize() {
    this.ace.resize();
  }

  setOnAskAI(handler: (prompt: string, code: string) => void) {
    this.onAskAI = handler;
  }

  setOnSave(handler: (path: string, content: string) => void) {
    this.onSaveCallback = handler;
  }


  private showEditorContextMenu(e: MouseEvent) {
    const selection = this.ace.getSelectedText();
    const menu = this.editorContextMenu;
    menu.innerHTML = "";

    type MenuItem =
      | { label: string; icon: string; shortcut?: string; action: () => void; separator?: false }
      | { separator: true };

    const items: MenuItem[] = [
      {
        label: "Cut", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 3.5c-.2.2-.3.4-.3.7 0 .5.4 1 1 1 .2 0 .5-.1.7-.3L7 2.8 5.1 1a.5.5 0 0 0-.7.7L5.8 3l-.7.7-.2-.2-.9.9L3 3.4 1 5.4 2.4 6.8l2.2-2.2c.1.2.3.4.5.5L3.5 6.6l2 1.4 2-2L8 7l-1 1 1 1 1.1-1.1.5.5-1.1 1.1 1 1 2-2-1.5-1.5.7-.7c.2.2.5.3.7.3.6 0 1-.4 1-1 0-.3-.1-.5-.3-.7L8 3.5 7.3 2.8 5.8 1.3 4.5 2.6l-.5-.5-.5.5.5.5-.5.5v-.1zm1 1c-.3 0-.5-.2-.5-.5s.2-.5.5-.5.5.2.5.5-.2.5-.5.5z"/></svg>`,
        shortcut: "⌘X",
        action: () => {
          const text = this.ace.getSelectedText();
          if (text) {
            navigator.clipboard.writeText(text).catch(() => {});
            this.ace.execCommand("del");
          }
        },
      },
      {
        label: "Copy", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`,
        shortcut: "⌘C",
        action: () => {
          const text = this.ace.getSelectedText();
          if (text) navigator.clipboard.writeText(text).catch(() => {});
        },
      },
      {
        label: "Paste", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1.5A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v1A1.5 1.5 0 0 1 9.5 4h-3A1.5 1.5 0 0 1 5 2.5v-1zm1.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-3z"/><path d="M3 2.5a.5.5 0 0 1 .5-.5H5v1H3.5a.5.5 0 0 1-.5-.5V2.5zm8 0v.5H9.5V2h1a.5.5 0 0 1 .5.5zM3 4v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4H3zm2 2h6v1H5V6zm0 2h6v1H5V8zm0 2h4v1H5v-1z"/></svg>`,
        shortcut: "⌘V",
        action: () => {
          navigator.clipboard.readText().then((text) => {
            this.ace.focus();
            this.ace.insert(text);
          }).catch(() => {});
        },
      },
      { separator: true },
      {
        label: "Select All", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1h13a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5zm-1.5.5v13A1.5 1.5 0 0 0 1.5 16h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 14.5 0h-13A1.5 1.5 0 0 0 0 1.5z"/></svg>`,
        shortcut: "⌘A",
        action: () => this.ace.selectAll(),
      },
      { separator: true },
      {
        label: "Format Document", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm2 3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm-2 3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm2 3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5z"/></svg>`,
        shortcut: "⇧⌥F",
        action: () => this.formatDocument(),
      },
      { separator: true },
      {
        label: "Ask AI",
        icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936z"/></svg>`,
        action: () => {},
        // submenu handled separately
      },
    ];

    for (const item of items) {
      if ("separator" in item && item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menu.appendChild(sep);
        continue;
      }

      const row = document.createElement("div");
      row.className = "context-menu-item ecm-item";

      const left = document.createElement("span");
      left.className = "ecm-left";
      left.innerHTML = item.icon + `<span class="ecm-label">${item.label}</span>`;
      row.appendChild(left);

      if ("shortcut" in item && item.shortcut) {
        const sc = document.createElement("span");
        sc.className = "ecm-shortcut";
        sc.textContent = item.shortcut;
        row.appendChild(sc);
      }

      if (item.label === "Ask AI") {
        // Submenu for AI actions
        const arrow = document.createElement("span");
        arrow.className = "context-menu-arrow";
        arrow.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 3.5L10.5 8 6 12.5V3.5Z"/></svg>`;
        row.appendChild(arrow);

        const sub = document.createElement("div");
        sub.className = "context-submenu ecm-submenu hidden";

        const aiActions = [
          { label: "Fix", prompt: "Fix the issues in this code:\n" },
          { label: "Explain", prompt: "Explain what this code does:\n" },
          { label: "Refactor", prompt: "Refactor this code to be cleaner and more efficient:\n" },
          { label: "Add comments", prompt: "Add clear comments to this code:\n" },
          { label: "Optimize", prompt: "Optimize this code for performance:\n" },
          { label: "Write tests", prompt: "Write unit tests for this code:\n" },
        ];

        for (const ai of aiActions) {
          const subRow = document.createElement("div");
          subRow.className = "context-menu-item ecm-item";
          subRow.innerHTML = `<span class="ecm-left"><span class="ecm-label">${ai.label}</span></span>`;
          subRow.addEventListener("click", (ev) => {
            ev.stopPropagation();
            menu.classList.add("hidden");
            const code = selection || this.ace.getValue();
            this.onAskAI?.(ai.prompt + "```\n" + code + "\n```", code);
          });
          sub.appendChild(subRow);
        }

        row.addEventListener("mouseenter", () => {
          const rect = row.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          // Check if submenu would overflow right side
          const subWidth = 180;
          const rightSpace = window.innerWidth - rect.right;
          if (rightSpace < subWidth) {
            sub.style.left = `-${subWidth}px`;
          } else {
            sub.style.left = `${rect.width}px`;
          }
          sub.style.top = `${rect.top - menuRect.top}px`;
          sub.classList.remove("hidden");
        });
        row.addEventListener("mouseleave", (ev) => {
          if (!sub.contains(ev.relatedTarget as Node)) sub.classList.add("hidden");
        });
        sub.addEventListener("mouseleave", () => sub.classList.add("hidden"));

        menu.appendChild(row);
        menu.appendChild(sub);
        continue;
      }

      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        menu.classList.add("hidden");
        item.action();
      });
      menu.appendChild(row);
    }

    menu.classList.remove("hidden");
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 6}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 6}px`;
      }
    });
  }
}
