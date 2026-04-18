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

export class Editor {
  private ace: ace.Ace.Editor;
  private tabs: OpenTab[] = [];
  private activeTab: string = "";
  private tabsContainer: HTMLElement;
  private emptyEl: HTMLElement;
  private editorEl: HTMLElement;
  private currentSettings: EditorSettings = { ...DEFAULT_EDITOR_SETTINGS };
  private lintTimeout: ReturnType<typeof setTimeout> | null = null;
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
  private onNavigate: ((request: EditorNavigationRequest) => Promise<void>) | null = null;
  private onHoverInfo: ((request: EditorHoverRequest) => Promise<EditorHoverInfo | null>) | null = null;

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

    // Auto-trigger after '.' or '[' for member/property completions
    this.ace.commands.on("afterExec", (e: any) => {
      if (e.command.name === "insertstring" && (e.args === "." || e.args === "[")) {
        this.customAutocomplete.trigger();
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

    document.addEventListener("click", () => {
      this.tabContextMenu.classList.add("hidden");
      this.editorContextMenu.classList.add("hidden");
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

    // Auto-save and lint on change (debounced)
    let saveTimeout: ReturnType<typeof setTimeout>;
    this.ace.on("change", () => {
      const tab = this.tabs.find((t) => t.path === this.activeTab);
      if (tab) {
        tab.content = this.ace.getValue();
        tab.modified = true;
        this.renderTabs();
      }
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => this.saveCurrentFile(), 1000);

      // Debounced TS/TSX/JSX lint
      if (this.lintTimeout) clearTimeout(this.lintTimeout);
      this.lintTimeout = setTimeout(() => this.runTsLint(), 400);
    });

    // Initially hide editor
    this.editorEl.style.display = "none";
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
      if (this.activeTab === path) {
        const cursor = this.ace.getCursorPosition();
        this.ace.setValue(content, -1);
        this.ace.moveCursorToPosition(cursor);
        this.ace.clearSelection();
      }
      this.renderTabs();
    } catch (e) {
      console.error("Failed to reload file:", e);
    }
  }

  closeTab(path: string) {
    const idx = this.tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;

    this.tabs.splice(idx, 1);

    if (this.activeTab === path) {
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIdx].path);
      } else {
        this.activeTab = "";
        this.ace.setValue("");
        this.editorEl.style.display = "none";
        this.emptyEl.style.display = "flex";
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

  setOnNavigate(callback: (request: EditorNavigationRequest) => Promise<void>) {
    this.onNavigate = callback;
  }

  setOnHoverInfo(callback: (request: EditorHoverRequest) => Promise<EditorHoverInfo | null>) {
    this.onHoverInfo = callback;
  }

  private switchToTab(path: string) {
    this.activeTab = path;
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;

    this.emptyEl.style.display = "none";
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

    this.renderTabs();
    this.ace.focus();
    this.ace.resize();
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
    this.tabsContainer.innerHTML = this.tabs
      .map(
        (tab) => `
      <div class="editor-tab ${tab.path === this.activeTab ? "active" : ""}${tab.pinned ? " pinned" : ""}" data-path="${this.escapeAttr(tab.path)}">
        ${tab.pinned ? `<span class="editor-tab-pin">&#x2605;</span>` : ""}
        <span>${this.escapeHtml(tab.name)}${tab.modified ? " \u2022" : ""}</span>
        <button class="editor-tab-close" data-close="${this.escapeAttr(tab.path)}">\u00D7</button>
      </div>
    `
      )
      .join("");

    this.tabsContainer.querySelectorAll(".editor-tab").forEach((el) => {
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".editor-tab-close")) return;
        const path = (el as HTMLElement).dataset.path!;
        this.switchToTab(path);
      });
      el.addEventListener("mousedown", (e) => {
        if ((e as MouseEvent).button === 2) e.preventDefault();
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
  }

  private async saveCurrentFile() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab || !tab.modified) return;

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
