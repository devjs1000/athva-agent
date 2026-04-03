import ace from "ace-builds";
import "ace-builds/src-min-noconflict/mode-javascript";
import "ace-builds/src-min-noconflict/mode-typescript";
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
import { invoke } from "@tauri-apps/api/core";

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
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
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

  constructor(editorId: string, tabsId: string, emptyId: string) {
    this.tabsContainer = document.getElementById(tabsId)!;
    this.emptyEl = document.getElementById(emptyId)!;
    this.editorEl = document.getElementById(editorId)!;

    this.ace = ace.edit(editorId);
    this.ace.setShowPrintMargin(false);
    this.ace.setReadOnly(false);
    this.applySettings(DEFAULT_EDITOR_SETTINGS);

    // Auto-save on change (debounced)
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

  private escapeHtml(str: string): string {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  private escapeAttr(str: string): string {
    return str.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  resize() {
    this.ace.resize();
  }
}
