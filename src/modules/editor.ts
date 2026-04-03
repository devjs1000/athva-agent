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
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  theme: "monokai",
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  showGutter: true,
  showMinimap: false,
};

interface OpenTab {
  path: string;
  name: string;
  content: string;
  modified: boolean;
}

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
      enableBasicAutocompletion: true,
      enableLiveAutocompletion: true,
      enableSnippets: true,
    });
    // Inline autocomplete (not in type defs but supported at runtime)
    (this.ace as any).setOption("enableInlineAutocompletion", true);

    // Ctrl+Space / Cmd+Space to trigger autocomplete
    this.ace.commands.addCommand({
      name: "triggerAutocomplete",
      bindKey: { win: "Ctrl-Space", mac: "Cmd-Space|Ctrl-Space" },
      exec: (editor: ace.Ace.Editor) => {
        editor.execCommand("startAutocomplete");
      },
    });

    // Tab to accept inline completion (when visible), otherwise normal tab
    this.ace.commands.addCommand({
      name: "acceptInlineOrTab",
      bindKey: { win: "Tab", mac: "Tab" },
      exec: (editor: ace.Ace.Editor) => {
        // If autocomplete popup is open, accept it
        if ((editor as any).completer?.popup?.isOpen) {
          editor.execCommand("insertMatch");
          return;
        }
        // If there's inline autocomplete ghost text, accept it
        if ((editor as any).completer?.inlineCompleter?.isOpen?.()) {
          (editor as any).completer.inlineCompleter.accept();
          return;
        }
        // Otherwise normal indent
        editor.execCommand("indent");
      },
    });

    // Init minimap (inside the editor-container, which is the parent of ace-editor)
    this.minimap = new Minimap(this.editorEl.parentElement!, this.ace);

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

    // Force a re-render
    this.ace.renderer.updateFull(true);
  }

  async openFile(path: string, name: string) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.switchToTab(path);
      return;
    }

    let content: string;
    try {
      content = await invoke<string>("read_file", { path });
    } catch (e) {
      console.error("Failed to read file:", e);
      return;
    }

    const tab: OpenTab = { path, name, content, modified: false };
    this.tabs.push(tab);
    this.switchToTab(path);
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

  private switchToTab(path: string) {
    this.activeTab = path;
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;

    this.emptyEl.style.display = "none";
    this.editorEl.style.display = "block";

    this.ace.setValue(tab.content, -1);
    this.ace.clearSelection();

    const ext = tab.name.split(".").pop()?.toLowerCase() || "";
    const mode = EXT_MODE_MAP[ext] || "text";
    this.ace.session.setMode(`ace/mode/${mode}`);

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

  private renderTabs() {
    this.tabsContainer.innerHTML = this.tabs
      .map(
        (tab) => `
      <div class="editor-tab ${tab.path === this.activeTab ? "active" : ""}" data-path="${this.escapeAttr(tab.path)}">
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

  resize() {
    this.ace.resize();
  }
}
