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
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  showGutter: boolean;
  showMinimap: boolean;
  aiInlineSuggestions: boolean;
  tailwindAutocomplete: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
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

export interface EditorHoverRequest extends EditorNavigationRequest { }

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
  //@ts-ignore
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

    // Hide cursor on click, restore on mouse move
    this.editorEl.addEventListener("mousedown", () => {
      this.editorEl.style.cursor = "none";
    });
    this.editorEl.addEventListener("mousemove", () => {
      this.editorEl.style.cursor = "";
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

  setAceTheme(theme: string) {
    this.ace.setTheme(`ace/theme/${theme}`);
  }

  applySettings(settings: EditorSettings) {
    this.currentSettings = { ...settings };

    // Font size is global on the editor instance
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
    const sections: { label: string; icon: string; items: { label: string; url: string; icon: string }[] }[] = [
      {
        label: "Design", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`,
        items: [
          { label: "Figma", url: "https://www.figma.com", icon: `<svg viewBox="0 0 38 57" fill="none"><path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE"/><path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 0 1-19 0z" fill="#0ACF83"/><path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262"/><path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E"/><path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF"/></svg>` },
          { label: "Canva", url: "https://www.canva.com", icon: `<svg viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="50" fill="#7D2AE8"/><path d="M50 20c-16.57 0-30 13.43-30 30s13.43 30 30 30c8.28 0 15.78-3.36 21.21-8.79l-7.07-7.07A19.9 19.9 0 0 1 50 70c-11.05 0-20-8.95-20-20s8.95-20 20-20c5.52 0 10.52 2.24 14.14 5.86l7.07-7.07A29.9 29.9 0 0 0 50 20z" fill="white"/></svg>` },
          { label: "Adobe XD", url: "https://xd.adobe.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#FF26BE"/><text x="8" y="34" fill="white" font-size="22" font-weight="700" font-family="sans-serif">Xd</text></svg>` },
          { label: "Sketch", url: "https://www.sketch.com", icon: `<svg viewBox="0 0 50 50" fill="none"><polygon points="25,2 48,18 39,46 11,46 2,18" fill="#FDAD00"/><polygon points="25,2 14,18 25,46 36,18" fill="#EA6C00" opacity="0.5"/></svg>` },
        ]
      },
      {
        label: "Version Control", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm12 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM6 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0-8a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6-4a4 4 0 0 1 3.87 3H18a4 4 0 0 1 0 8h-2.13A4.001 4.001 0 0 1 8 12h.13A4.002 4.002 0 0 1 12 6z"/></svg>`,
        items: [
          { label: "GitHub", url: "https://github.com", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>` },
          { label: "GitLab", url: "https://gitlab.com", icon: `<svg viewBox="0 0 586 559" fill="none"><path d="M461.52 301.03L292.99 558.5 124.46 301.03l168.53-518.55L461.52 301.03z" fill="#E24329"/><path d="M292.99 558.5L124.46 301.03H.5L292.99 558.5z" fill="#FC6D26"/><path d="M124.46 301.03H.5L124.46 301.03z" fill="#FCA326"/><path d="M292.99 558.5L461.52 301.03H585.5L292.99 558.5z" fill="#FC6D26"/><path d="M461.52 301.03H585.5L461.52 301.03z" fill="#FCA326"/></svg>` },
          { label: "Bitbucket", url: "https://bitbucket.org", icon: `<svg viewBox="0 0 32 32" fill="none"><path d="M2 5a1 1 0 0 0-1 1.15l4.36 25.4A1 1 0 0 0 6.33 32h19.74a1 1 0 0 0 1-.85L31 6.15A1 1 0 0 0 30 5H2zm17.25 16.6h-6.48L11.1 13h9.8l-1.65 8.6z" fill="#2684FF"/></svg>` },
          { label: "Azure DevOps", url: "https://dev.azure.com", icon: `<svg viewBox="0 0 32 32" fill="none"><path d="M0 17.5L5.5 8l7 5.5v-10L18 1l13 14-5.5 2.5H10L7.5 27 0 17.5z" fill="#0078D7"/></svg>` },
        ]
      },
      {
        label: "Project Management", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 14H7v-2h5v2zm5-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`,
        items: [
          { label: "Jira", url: "https://www.atlassian.com/software/jira", icon: `<svg viewBox="0 0 32 32" fill="none"><path d="M15.98 2C9.35 2 4 7.37 4 14.02c0 3.73 1.67 7.07 4.32 9.35l7.66 6.63 7.66-6.63C26.28 21.09 28 17.7 28 14.02 28 7.37 22.61 2 15.98 2zm0 17.35a5.33 5.33 0 1 1 0-10.66 5.33 5.33 0 0 1 0 10.66z" fill="#2684FF"/></svg>` },
          { label: "Trello", url: "https://trello.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#0052CC"/><rect x="8" y="8" width="14" height="30" rx="3" fill="white"/><rect x="28" y="8" width="14" height="20" rx="3" fill="white"/></svg>` },
          { label: "Asana", url: "https://app.asana.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="17" r="10" fill="#F06A6A"/><circle cx="10" cy="35" r="10" fill="#F06A6A"/><circle cx="40" cy="35" r="10" fill="#F06A6A"/></svg>` },
          { label: "Monday.com", url: "https://monday.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="12" cy="25" r="9" fill="#FF3750"/><circle cx="25" cy="25" r="9" fill="#FFCB00"/><circle cx="38" cy="25" r="9" fill="#00CA72"/></svg>` },
        ]
      },
      {
        label: "Sheets", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-8 12H7v-2h4v2zm0-4H7V9h4v2zm6 4h-4v-2h4v2zm0-4h-4V9h4v2z"/></svg>`,
        items: [
          { label: "Google Sheets", url: "https://sheets.google.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect x="8" y="2" width="34" height="46" rx="3" fill="#0F9D58"/><rect x="14" y="14" width="22" height="3" rx="1" fill="white"/><rect x="14" y="21" width="22" height="3" rx="1" fill="white"/><rect x="14" y="28" width="22" height="3" rx="1" fill="white"/><rect x="14" y="35" width="14" height="3" rx="1" fill="white"/></svg>` },
          { label: "Microsoft Excel", url: "https://www.office.com/launch/excel", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="6" fill="#217346"/><path d="M10 12h14l6 13-6 13H10l6-13-6-13z" fill="white"/><rect x="26" y="12" width="14" height="4" rx="1" fill="white"/><rect x="26" y="22" width="14" height="4" rx="1" fill="white"/><rect x="26" y="32" width="14" height="4" rx="1" fill="white"/></svg>` },
          { label: "Airtable", url: "https://airtable.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#FCB400"/><rect x="8" y="8" width="34" height="10" rx="3" fill="white"/><rect x="8" y="22" width="15" height="20" rx="3" fill="white"/><rect x="27" y="22" width="15" height="14" rx="3" fill="white"/></svg>` },
          { label: "Notion", url: "https://www.notion.so", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="white"/><rect width="50" height="50" rx="8" fill="black" opacity="0.05"/><path d="M10 10h30v4H10zm0 9h20v4H10zm0 9h25v4H10zm0 9h15v4H10z" fill="#37352F"/></svg>` },
        ]
      },
      {
        label: "AI", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>`,
        items: [
          { label: "ChatGPT", url: "https://chat.openai.com", icon: `<svg viewBox="0 0 41 41" fill="currentColor"><path d="M37.5 16.9a9.7 9.7 0 0 0-.8-7.9 10 10 0 0 0-10.8-4.8A9.7 9.7 0 0 0 18.6 1a10 10 0 0 0-9.5 6.9 9.7 9.7 0 0 0-6.5 4.7 10 10 0 0 0 1.2 11.7 9.7 9.7 0 0 0 .8 7.9 10 10 0 0 0 10.8 4.8 9.7 9.7 0 0 0 7.3 3.3 10 10 0 0 0 9.6-6.9 9.7 9.7 0 0 0 6.4-4.7 10 10 0 0 0-1.2-11.8zm-14.8 20.6a7.4 7.4 0 0 1-4.8-1.7l.2-.1 8-4.6a1.3 1.3 0 0 0 .7-1.1v-11.3l3.4 2a.1.1 0 0 1 .1.1v9.3a7.5 7.5 0 0 1-7.5 7.4zM6 30.3a7.4 7.4 0 0 1-.9-5l.2.1 8 4.6a1.3 1.3 0 0 0 1.3 0l9.8-5.7v3.9a.1.1 0 0 1 0 .1L16 33a7.5 7.5 0 0 1-10-2.7zm-1.6-17.5a7.4 7.4 0 0 1 3.9-3.3v9.4a1.3 1.3 0 0 0 .6 1.1l9.8 5.7-3.4 2a.1.1 0 0 1-.1 0L7 23.1A7.5 7.5 0 0 1 4.4 12.8zm27.8 6.4l-9.8-5.7 3.4-2a.1.1 0 0 1 .1 0l8.2 4.7a7.5 7.5 0 0 1-1.2 13.5v-9.4a1.3 1.3 0 0 0-.7-1.1zm3.4-5-.2-.1-8-4.6a1.3 1.3 0 0 0-1.3 0l-9.8 5.7V11.3a.1.1 0 0 1 0-.1L25 6.5a7.5 7.5 0 0 1 10.6 7.7zm-21.2 7l-3.4-2a.1.1 0 0 1-.1-.1v-9.3a7.5 7.5 0 0 1 12.3-5.7l-.2.1-8 4.6a1.3 1.3 0 0 0-.6 1.1zm1.8-3.9l4.4-2.5 4.4 2.5v5l-4.4 2.5-4.4-2.5z"/></svg>` },
          { label: "Gemini", url: "https://gemini.google.com", icon: `<svg viewBox="0 0 28 28" fill="none"><path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" fill="url(#gemini-grad)"/><defs><linearGradient id="gemini-grad" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#EA4335"/></linearGradient></defs></svg>` },
          { label: "Claude", url: "https://claude.ai", icon: `<svg viewBox="0 0 46 46" fill="none"><path d="M23 0C10.3 0 0 10.3 0 23s10.3 23 23 23 23-10.3 23-23S35.7 0 23 0zm0 8c2.2 0 4 1.8 4 4s-1.8 4-4 4-4-1.8-4-4 1.8-4 4-4zm-9 28v-2c0-5 4-9 9-9s9 4 9 9v2H14z" fill="#D97757"/></svg>` },
          { label: "Perplexity", url: "https://www.perplexity.ai", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#20808D"/><path d="M25 10l10 10H15L25 10zM15 20h20v20H15V20zm5 5v10h10V25H20z" fill="white"/></svg>` },
          { label: "Qwen", url: "https://chat.qwen.ai", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#615CFF"/><text x="9" y="35" fill="white" font-size="22" font-weight="700" font-family="sans-serif">Qw</text></svg>` },
          { label: "Kimi", url: "https://kimi.moonshot.cn", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="25" fill="#1A1A2E"/><circle cx="25" cy="20" r="8" fill="#7B61FF"/><path d="M12 38c0-7.18 5.82-13 13-13s13 5.82 13 13" stroke="#7B61FF" stroke-width="3" stroke-linecap="round"/></svg>` },
          { label: "Grok", url: "https://grok.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="black"/><text x="8" y="36" fill="white" font-size="26" font-weight="900" font-family="sans-serif">𝕏</text></svg>` },
          { label: "Manus", url: "https://manus.im", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#1E1E1E"/><text x="9" y="35" fill="white" font-size="20" font-weight="700" font-family="sans-serif">M</text></svg>` },
        ]
      },
      {
        label: "Search", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
        items: [
          { label: "Google", url: "https://www.google.com", icon: `<svg viewBox="0 0 48 48" fill="none"><path d="M43.6 20H24v8h11.3C33.6 33.4 29.3 36 24 36a12 12 0 1 1 0-24c3 0 5.7 1.1 7.8 2.9L37.4 9A20 20 0 1 0 24 44c11 0 20-9 20-20 0-1.3-.1-2.7-.4-4z" fill="#FFC107"/><path d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.7 1.1 7.8 2.9L37.4 9A20 20 0 0 0 6.3 14.7z" fill="#FF3D00"/><path d="M24 44c5.2 0 9.9-1.9 13.5-5L31.8 34c-2 1.5-4.5 2-7.8 2a12 12 0 0 1-11.3-8l-6.6 5A20 20 0 0 0 24 44z" fill="#4CAF50"/><path d="M43.6 20H24v8h11.3c-.8 2.3-2.4 4.2-4.5 5.5l5.7 5a20 20 0 0 0 7-15.5c0-1.3-.1-2.7-.4-4z" fill="#1976D2"/></svg>` },
          { label: "Bing", url: "https://www.bing.com", icon: `<svg viewBox="0 0 32 32" fill="none"><path d="M7 3l5 2v18l7-4 2-7-7-2-1-4 13 4v11l-13 7-6-3z" fill="#008373"/></svg>` },
          { label: "DuckDuckGo", url: "https://duckduckgo.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#DE5833"/><circle cx="25" cy="22" r="12" fill="white"/><circle cx="22" cy="20" r="3" fill="#3D3D3D"/><circle cx="23" cy="19" r="1" fill="white"/></svg>` },
          { label: "Yahoo", url: "https://www.yahoo.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#6001D2"/><text x="6" y="35" fill="white" font-size="22" font-weight="700" font-family="sans-serif">Y!</text></svg>` },
        ]
      },
      {
        label: "Email", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
        items: [
          { label: "Gmail", url: "https://mail.google.com", icon: `<svg viewBox="0 0 48 48" fill="none"><path d="M0 8v32h48V8H0z" fill="white"/><path d="M0 8l24 16L48 8" stroke="#D44638" stroke-width="4"/><path d="M0 8v32l14-16L0 8z" fill="#C33929"/><path d="M48 8v32L34 24 48 8z" fill="#C33929"/></svg>` },
          { label: "Outlook", url: "https://outlook.live.com", icon: `<svg viewBox="0 0 48 48" fill="none"><rect width="28" height="28" x="10" y="10" rx="4" fill="#0078D4"/><rect x="22" y="10" width="16" height="28" rx="2" fill="#0078D4"/><rect x="22" y="10" width="16" height="28" rx="2" fill="white" opacity="0.2"/><path d="M22 10h16l2 2v24l-2 2H22l-2-2V12l2-2z" fill="#0078D4"/><path d="M22 22l16-12" stroke="white" stroke-width="2"/><path d="M22 22l16 10" stroke="white" stroke-width="2"/></svg>` },
          { label: "Yahoo Mail", url: "https://mail.yahoo.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#6001D2"/><path d="M10 15l10 14v10h10V29l10-14H10z" fill="white"/></svg>` },
          { label: "ProtonMail", url: "https://mail.proton.me", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#6D4AFF"/><path d="M10 15h15c8 0 12 4 12 10s-4 10-12 10H20v10H10V15zm10 12h5c3 0 5-1 5-2s-2-2-5-2h-5v4z" fill="white"/></svg>` },
        ]
      },
      {
        label: "Music", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`,
        items: [
          { label: "Spotify", url: "https://open.spotify.com", icon: `<svg viewBox="0 0 168 168" fill="none"><circle cx="84" cy="84" r="84" fill="#1ED760"/><path d="M120.7 121.6c-1.6 2.6-4.9 3.4-7.5 1.8-20.6-12.6-46.5-15.4-77-8.4-2.9.7-5.9-1.1-6.6-4.1-.7-2.9 1.1-5.9 4.1-6.6 33.4-7.6 62.1-4.4 85.3 9.8 2.6 1.6 3.4 4.9 1.7 7.5zm10.2-22.5c-2 3.2-6.3 4.2-9.5 2.2-23.6-14.5-59.5-18.7-87.4-10.2-3.6 1.1-7.4-.9-8.5-4.5-1.1-3.6.9-7.4 4.5-8.5 31.8-9.7 71.2-5 98.7 11.5 3.2 2 4.2 6.3 2.2 9.5zm.9-23.4c-28.3-16.8-75-18.3-102-10.1-4.3 1.3-8.9-1.1-10.2-5.5-1.3-4.3 1.1-8.9 5.5-10.2 31-9.4 82.5-7.6 115.1 11.7 3.9 2.3 5.1 7.3 2.8 11.2-2.3 3.9-7.3 5.2-11.2 2.9z" fill="white"/></svg>` },
          { label: "Apple Music", url: "https://music.apple.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="url(#apple-music-grad)"/><path d="M35 12H21v22c-1.2-.8-2.5-1-4-1-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6V20h9v-4l3-4z" fill="white"/><defs><linearGradient id="apple-music-grad" x1="0" y1="0" x2="50" y2="50"><stop offset="0%" stop-color="#FC5C7D"/><stop offset="100%" stop-color="#6A3093"/></linearGradient></defs></svg>` },
          { label: "YouTube Music", url: "https://music.youtube.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="25" fill="#FF0000"/><polygon points="20,16 38,25 20,34" fill="white"/><circle cx="25" cy="25" r="8" fill="#FF0000"/><circle cx="25" cy="25" r="5" fill="white"/><circle cx="25" cy="25" r="2" fill="#FF0000"/></svg>` },
          { label: "SoundCloud", url: "https://soundcloud.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#FF5500"/><path d="M8 28a2 2 0 0 0 4 0 2 2 0 0 0-4 0zm6-4a4 4 0 0 0 4 4h20a6 6 0 0 0 0-12 8 8 0 0 0-15 4 4 4 0 0 0-9 4z" fill="white"/></svg>` },
        ]
      },
      {
        label: "Social Media", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
        items: [
          { label: "Instagram", url: "https://www.instagram.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="12" fill="url(#ig-grad)"/><rect x="13" y="13" width="24" height="24" rx="6" stroke="white" stroke-width="2.5" fill="none"/><circle cx="25" cy="25" r="7" stroke="white" stroke-width="2.5" fill="none"/><circle cx="33" cy="17" r="2" fill="white"/><defs><linearGradient id="ig-grad" x1="0" y1="50" x2="50" y2="0"><stop offset="0%" stop-color="#F9CE34"/><stop offset="30%" stop-color="#EE2A7B"/><stop offset="70%" stop-color="#6228D7"/><stop offset="100%" stop-color="#4F5BD5"/></linearGradient></defs></svg>` },
          { label: "Facebook", url: "https://www.facebook.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#1877F2"/><path d="M34 25h-6v18h-6V25h-4v-6h4v-4c0-5 3-8 8-8h5v6h-3c-1.3 0-2 .7-2 2v4h6l-2 6z" fill="white"/></svg>` },
          { label: "Twitter / X", url: "https://twitter.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="black"/><path d="M8 8h10l7 10 8-10h9L29 24l15 18H34L25 30l-9 12H7L21 26 8 8z" fill="white"/></svg>` },
          { label: "LinkedIn", url: "https://www.linkedin.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#0A66C2"/><rect x="10" y="18" width="8" height="24" rx="1" fill="white"/><circle cx="14" cy="12" r="5" fill="white"/><path d="M24 18h7v3c1.5-2 4-3.5 7-3.5 5.5 0 9 3.5 9 9.5V42h-8V29c0-3-1-4.5-3.5-4.5S32 26 32 29v13h-8V18z" fill="white"/></svg>` },
          { label: "TikTok", url: "https://www.tiktok.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="black"/><path d="M32 8h-6v24a6 6 0 1 1-6-6v-6a12 12 0 1 0 12 12V18c2 1.5 4.5 2 7 2v-6a8 8 0 0 1-7-6z" fill="white"/></svg>` },
          { label: "WhatsApp", url: "https://web.whatsapp.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#25D366"/><path d="M25 12C17.8 12 12 17.8 12 25c0 2.3.6 4.5 1.7 6.4L12 38l6.8-1.7c1.8 1 3.9 1.6 6.2 1.6 7.2 0 13-5.8 13-13S32.2 12 25 12zm7 17.7c-.3.8-1.7 1.5-2.3 1.6-.6.1-1.2.1-1.8-.1-.4-.1-1-.3-1.7-.6-3-1.3-5-4.3-5.1-4.5-.1-.1-.9-1.2-.9-2.3 0-1.1.6-1.7.8-1.9.2-.2.4-.2.6-.2h.4c.2 0 .4 0 .6.5l.8 2c.1.2 0 .4-.1.5l-.5.6c-.1.1-.2.3-.1.5.5.8 1.1 1.5 1.8 2.1.8.7 1.6 1.1 2.5 1.4.2.1.4 0 .5-.1l.6-.7c.2-.2.3-.2.5-.1l2 .9c.2.1.4.2.4.4 0 .3-.2 1-.3 1.4z" fill="white"/></svg>` },
          { label: "Telegram", url: "https://web.telegram.org", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#29B6F6"/><path d="M10 24l30-12-5 28-10-8-5 5V30l15-14-17 10z" fill="white"/></svg>` },
          { label: "Discord", url: "https://discord.com/app", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#5865F2"/><path d="M34 16c-2.5-1.2-5.2-2-8-2.3l-.5.9c2.4.6 4.6 1.6 6.5 3-3-1.5-6.4-2.2-10-2.2s-7 .7-10 2.2c1.9-1.4 4.1-2.4 6.5-3l-.5-.9c-2.8.3-5.5 1.1-8 2.3-3.2 8.5-3.5 16 0 21.3 2.3 2.9 5.4 4.2 8.5 4.2l1.5-1.8c-1.8-.5-3.5-1.4-5-2.7 3 2 6.5 3 10 3s7-.9 10-3c-1.5 1.3-3.2 2.2-5 2.7l1.5 1.8c3.1 0 6.2-1.3 8.5-4.2 3.5-5.3 3.2-12.8 0-21.3zM19 33c-1.7 0-3-1.5-3-3.5S17.3 26 19 26s3 1.5 3 3.5-1.3 3.5-3 3.5zm12 0c-1.7 0-3-1.5-3-3.5S29.3 26 31 26s3 1.5 3 3.5-1.3 3.5-3 3.5z" fill="white"/></svg>` },
          { label: "Reddit", url: "https://www.reddit.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#FF4500"/><circle cx="37" cy="14" r="4" fill="#FF6534"/><circle cx="37" cy="14" r="2" fill="white"/><path d="M25 15c-6 0-11 5-11 11s5 11 11 11 11-5 11-11-5-11-11-11z" fill="white"/><circle cx="21" cy="24" r="2" fill="#FF4500"/><circle cx="29" cy="24" r="2" fill="#FF4500"/><path d="M21 30c1 1.5 2.5 2 4 2s3-.5 4-2" stroke="#FF4500" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>` },
          { label: "YouTube", url: "https://www.youtube.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#FF0000"/><path d="M40 18s-.3-2.4-1.5-3.4C37 13.1 35.4 13 34.7 13c-4.7-.3-11.7-.3-11.7-.3s-7 0-11.7.3c-.7 0-2.3.1-3.8 1.6C6.3 15.6 6 18 6 18S5.7 20.7 5.7 23.5v2.5c0 2.7.3 5.5.3 5.5s.3 2.4 1.5 3.4c1.5 1.5 3.4 1.4 4.3 1.5C14.5 36.2 24 36.3 24 36.3s7 0 11.7-.4c.7-.1 2.3-.1 3.8-1.6 1.2-1 1.5-3.4 1.5-3.4s.3-2.7.3-5.5v-2.5C40.3 20.7 40 18 40 18zM21 29.5v-10l10 5-10 5z" fill="white"/></svg>` },
          { label: "Pinterest", url: "https://www.pinterest.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#E60023"/><path d="M25 8C15.6 8 8 15.6 8 25c0 7.3 4.5 13.6 10.9 16.2-.1-1.3-.3-3.3.1-4.7l2-8.6s-.5-1-.5-2.5c0-2.3 1.3-4 3.3-4 1.6 0 2.3 1.2 2.3 2.6 0 1.6-1 4-1.5 6.2-.4 1.8 1 3.3 2.7 3.3 3.3 0 5.5-4.2 5.5-9.2 0-3.8-2.5-6.5-6.9-6.5-5 0-8.1 3.7-8.1 7.8 0 1.4.4 2.4 1.1 3.2.3.3.3.5.2.9l-.4 1.7c-.1.5-.5.7-.9.5-2.5-1-3.7-3.8-3.7-6.9 0-5.1 4.3-11.2 12.8-11.2 6.8 0 11.3 4.9 11.3 10.2 0 6.9-3.8 12-9.5 12-1.9 0-3.7-1-4.3-2.2l-1.2 4.7c-.4 1.6-1.5 3.5-2.4 4.7.9.3 1.8.4 2.7.4 9.4 0 17-7.6 17-17S34.4 8 25 8z" fill="white"/></svg>` },
          { label: "Behance", url: "https://www.behance.net", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#1769FF"/><path d="M10 14h12c4 0 7 2 7 6 0 2.5-1 4-3 5 3 1 4.5 3 4.5 6 0 4.5-3.5 7-8.5 7H10V14zm6 9h5c2 0 3-1 3-2.5S23 18 21 18h-5v5zm0 9h6c2.5 0 4-1 4-3s-1.5-3-4-3h-6v6zm20-8h-8v-4h8v4zm3-7c-1-2.5-3.5-4-6.5-4-4 0-7 3.5-7 8s3 8 7 8c3.5 0 6-2 7-5h-5c-.5 1-1 1.5-2 1.5-1.5 0-2.5-1-2.5-2.5H40c0-.3 0-.7-.1-1 0-2.5-1.5-4.5-2.9-5z" fill="white"/></svg>` },
          { label: "Dribbble", url: "https://dribbble.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#EA4C89"/><path d="M25 8a17 17 0 1 0 0 34A17 17 0 0 0 25 8zm11.4 7.8c2 2.5 3.2 5.6 3.5 9-5-.9-9.5-.6-13.3.7-1-2.2-2-4.3-3.2-6.3 4.4-2 9-2.7 13-3.4zM25 11.5c3 0 5.8 1 8 2.7-3.6.5-7.5 1.5-11.2 3.3-.8-1.5-1.7-2.9-2.7-4.3 1.8-.9 3.8-1.7 5.9-1.7zm-10.2 5c1 1.4 2 2.9 2.9 4.5-5 1.4-9.6 1.8-12.4 1.8.5-3.5 2.3-6.5 5.1-8.5 1.4.6 2.9 1.4 4.4 2.2zm-5.3 9.5c0-.5 0-1 .1-1.5 3-.1 8-.5 13.5-2.2.3.7.6 1.4.8 2.1-8 2.2-11.5 7.5-12 8.2a15.4 15.4 0 0 1-2.4-6.6zm15.5 14a15.4 15.4 0 0 1-9.7-5.2c.5-.6 3.7-5.5 11.8-7.8 1.8 4.8 2.6 9 3 12.2a15.2 15.2 0 0 1-5 .8zm7.7-1.8c-.3-2.9-1.1-7-2.8-11.5 3.4-.6 7-.5 11.5.5-.9 4.3-4 7.8-8.7 11z" fill="white"/></svg>` },
        ]
      },
    ];

    const sectionsHTML = sections.map((section) => `
      <div class="tab-picker-section">
        <div class="tab-picker-section-header">
          <span class="tab-picker-section-icon">${section.icon}</span>
          <span class="tab-picker-section-label">${section.label}</span>
        </div>
        <div class="tab-picker-section-items">
          ${section.items.map((p) => `
            <button class="tab-picker-preset" data-url="${p.url}" data-label="${p.label}" type="button" title="${p.label}">
              <span class="tab-picker-preset-icon">${p.icon}</span>
              <span>${p.label}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `).join("");

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
        <div class="tab-picker-sections">
          ${sectionsHTML}
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
          .catch(() => { });
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
      ...(selection ? [
        {
          label: "Cut", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 3.5c-.2.2-.3.4-.3.7 0 .5.4 1 1 1 .2 0 .5-.1.7-.3L7 2.8 5.1 1a.5.5 0 0 0-.7.7L5.8 3l-.7.7-.2-.2-.9.9L3 3.4 1 5.4 2.4 6.8l2.2-2.2c.1.2.3.4.5.5L3.5 6.6l2 1.4 2-2L8 7l-1 1 1 1 1.1-1.1.5.5-1.1 1.1 1 1 2-2-1.5-1.5.7-.7c.2.2.5.3.7.3.6 0 1-.4 1-1 0-.3-.1-.5-.3-.7L8 3.5 7.3 2.8 5.8 1.3 4.5 2.6l-.5-.5-.5.5.5.5-.5.5v-.1zm1 1c-.3 0-.5-.2-.5-.5s.2-.5.5-.5.5.2.5.5-.2.5-.5.5z"/></svg>`,
          shortcut: "⌘X",
          action: () => {
            const text = this.ace.getSelectedText();
            if (text) {
              navigator.clipboard.writeText(text).catch(() => { });
              this.ace.execCommand("del");
            }
          },
        } as MenuItem,
        {
          label: "Copy", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`,
          shortcut: "⌘C",
          action: () => {
            const text = this.ace.getSelectedText();
            if (text) navigator.clipboard.writeText(text).catch(() => { });
          },
        } as MenuItem,
        { separator: true } as MenuItem,
      ] : []),
      {
        label: "Paste", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1.5A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v1A1.5 1.5 0 0 1 9.5 4h-3A1.5 1.5 0 0 1 5 2.5v-1zm1.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-3z"/><path d="M3 2.5a.5.5 0 0 1 .5-.5H5v1H3.5a.5.5 0 0 1-.5-.5V2.5zm8 0v.5H9.5V2h1a.5.5 0 0 1 .5.5zM3 4v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4H3zm2 2h6v1H5V6zm0 2h6v1H5V8zm0 2h4v1H5v-1z"/></svg>`,
        shortcut: "⌘V",
        action: () => {
          navigator.clipboard.readText().then((text) => {
            this.ace.focus();
            this.ace.insert(text);
          }).catch(() => { });
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
      ...(selection ? [
        { separator: true } as MenuItem,
        {
          label: "Ask AI",
          icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 0 0 1.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 0 0-1.828 1.829l-.645 1.936a.361.361 0 0 1-.686 0l-.645-1.937a2.89 2.89 0 0 0-1.828-1.828l-1.937-.645a.361.361 0 0 1 0-.686l1.937-.645a2.89 2.89 0 0 0 1.828-1.829l.645-1.936z"/></svg>`,
          action: () => { },
          // submenu handled separately
        } as MenuItem,
      ] : []),
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
          sub.style.left = "0";
          sub.style.top = "0";
          sub.classList.remove("hidden");
          const subRect = sub.getBoundingClientRect();
          // Horizontal: prefer right, flip left if overflow
          const rightSpace = window.innerWidth - rect.right;
          sub.style.left = rightSpace >= subRect.width
            ? `${rect.width}px`
            : `-${subRect.width}px`;
          // Vertical: align top with row, flip up if overflow bottom
          const topAligned = rect.top - menuRect.top;
          const wouldOverflowBottom = rect.top + subRect.height > window.innerHeight - 8;
          sub.style.top = wouldOverflowBottom
            ? `${rect.bottom - menuRect.top - subRect.height}px`
            : `${topAligned}px`;
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
