import "../monaco-env";
import * as monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { readFile, readDir } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { attachAICompleter, setAICompleterEnabled, setAICompleterConfig } from "./ai-completer";
import { renderMarkdown } from "./markdown-renderer";
import { TodoPanel } from "./todo-panel";
import { DocumentEditor } from "./doc-editor";
import { renderCSVPreview, renderFlowPreview, renderTextPreview, renderXlsxPreview } from "./preview-renderers";
import { ColorHighlighter } from "./color-highlighter";
import { ErrorLens } from "./error-lens";
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

const EXT_LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "cpp",
  swift: "swift",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "ini",
  svg: "xml",
  xml: "xml",
  proto: "protobuf",
  dockerfile: "dockerfile",
  tf: "hcl",
  hcl: "hcl",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
};

const EMMET_EXTS = new Set(["html", "htm", "jsx", "tsx"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv", "ogv"]);
const MIME_MAP: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  bmp: "image/bmp", tiff: "image/tiff", avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  avi: "video/x-msvideo", mkv: "video/x-matroska", ogv: "video/ogg",
};
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

interface ProjectCompilerConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  typeRoots?: string[];
}

export class Editor {
  private monacoEditor: monaco.editor.IStandaloneCodeEditor;
  private models: Map<string, monaco.editor.ITextModel> = new Map();
  private tabs: OpenTab[] = [];
  private activeTab: string = "";
  //@ts-ignore
  private draggingTabPath: string | null = null;
  private tabsContainer: HTMLElement;
  private emptyEl: HTMLElement;
  private editorEl: HTMLElement;
  private protectedBannerEl: HTMLElement;
  private currentSettings: EditorSettings = { ...DEFAULT_EDITOR_SETTINGS };
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private tabContextMenu: HTMLElement;
  private editorContextMenu: HTMLElement;
  private onAskAI: ((prompt: string, code: string) => void) | null = null;
  private onSaveCallback: ((path: string, content: string) => void) | null = null;
  private onCreateEditorTab: (() => void) | null = null;
  private onUnlockProtected: ((path: string) => void) | null = null;
  private onNavigate: ((request: EditorNavigationRequest) => Promise<void>) | null = null;
  private onHoverInfo: ((request: EditorHoverRequest) => Promise<EditorHoverInfo | null>) | null = null;
  private webFrameEl: HTMLIFrameElement;
  private tabPickerDropdown: HTMLElement;
  private webTabLabels: Map<string, string> = new Map();
  private webTabPathsByLabel: Map<string, string> = new Map();
  private webTabMediaState: Map<string, boolean> = new Map();
  private activeWebLabel: string | null = null;
  private webResizeObserver: ResizeObserver | null = null;
  private mediaPreviewEl: HTMLElement = document.createElement("div");
  private svgPreviewEl: HTMLElement = document.createElement("div");
  private svgToggleBtn: HTMLElement = document.createElement("button");
  private svgPreviewActive = false;
  /** What the current preview toggle renders: 'svg' | 'markdown' | 'csv' | 'flow' | 'txt' | 'xlsx' | null */
  private currentPreviewType: "svg" | "markdown" | "csv" | "flow" | "txt" | "xlsx" | null = null;
  /** True if this file type should default to preview mode on open */
  private previewDefaultsToOn = false;
  private todoPanelEl: HTMLElement = document.createElement("div");
  private activeTodoPanel: TodoPanel | null = null;
  private activeDocEditor: DocumentEditor | null = null;
  private docEditorActive = false;
  /** Project roots for which we have already loaded node_modules types into Monaco */
  private projectTypesLoaded: Set<string> = new Set();
  /** Virtual paths already registered via addExtraLib — prevents duplicate registration */
  private readonly extraLibPaths: Set<string> = new Set();
  /** Maps import specifier → resolved .d.ts or source file path for named-import completions */
  private readonly packageDtsMap: Map<string, string> = new Map();
  /** Cache of already-extracted export names keyed by file path */
  private readonly exportNamesCache: Map<string, string[]> = new Map();
  private readonly importableSourceExts = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
  private readonly importableSourceSuffixRe = /\.(?:[cm]?[jt]sx?)$/;
  private readonly projectDependencyCache: Map<string, string[]> = new Map();
  private readonly projectSourceFileCache: Map<string, string[]> = new Map();
  private readonly projectCompilerConfigCache: Map<string, ProjectCompilerConfig> = new Map();
  //@ts-ignore — holds reference to prevent GC; lifecycle managed internally
  private colorHighlighter: ColorHighlighter | null = null;

  constructor(editorId: string, tabsId: string, emptyId: string) {
    this.tabsContainer = document.getElementById(tabsId)!;
    this.emptyEl = document.getElementById(emptyId)!;
    this.editorEl = document.getElementById(editorId)!;

    this.setupMonacoDefaults();
    this.registerImportPathCompletionProvider();
    this.registerNamedImportCompletionProvider();

    this.monacoEditor = monaco.editor.create(this.editorEl, {
      value: "",
      language: "plaintext",
      theme: "athva-dark",
      fontSize: DEFAULT_EDITOR_SETTINGS.fontSize,
      tabSize: DEFAULT_EDITOR_SETTINGS.tabSize,
      wordWrap: "off",
      lineNumbers: "on",
      minimap: { enabled: DEFAULT_EDITOR_SETTINGS.showMinimap },
      contextmenu: false,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      renderWhitespace: "none",
      readOnly: false,
      suggestOnTriggerCharacters: true,
      quickSuggestions: {
        other: "on",
        comments: "off",
        strings: "on",
      },
      parameterHints: { enabled: true },
      hover: { enabled: true, delay: 600 },
      links: false,
    });

    // Register hover provider for all relevant languages
    this.registerHoverProviders();

    // Cmd+Space to trigger suggestions
    this.monacoEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space,
      () => this.monacoEditor.trigger("keyboard", "editor.action.triggerSuggest", null)
    );

    // Explicit undo/redo — Tauri's WKWebView on macOS intercepts Cmd+Z at the system level
    // before Monaco can handle it, so we bind it explicitly inside Monaco's command registry.
    this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => this.undo());
    this.monacoEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
      () => this.redo()
    );
    this.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => this.redo());

    // Tab key: try Emmet first, then let Monaco handle indent
    this.monacoEditor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Tab && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.expandEmmetAtCursor()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    });

    // Tab context menu
    this.tabContextMenu = document.createElement("div");
    this.tabContextMenu.className = "context-menu hidden";
    document.body.appendChild(this.tabContextMenu);

    // Editor right-click context menu
    this.editorContextMenu = document.createElement("div");
    this.editorContextMenu.className = "context-menu editor-context-menu hidden";
    document.body.appendChild(this.editorContextMenu);

    // Web tab iframe placeholder
    this.webFrameEl = document.createElement("iframe");
    this.webFrameEl.className = "web-tab-frame hidden";

    // ResizeObserver keeps active child webview in sync with the editor container
    const editorContainer = this.editorEl.parentElement!;
    this.webResizeObserver = new ResizeObserver(() => this.syncActiveWebTabBounds());
    this.webResizeObserver.observe(editorContainer);
    window.addEventListener("resize", () => this.syncActiveWebTabBounds());

    // Protected file banner
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

    // Media preview container (images, videos)
    this.mediaPreviewEl.className = "media-preview-container hidden";
    editorContainer.appendChild(this.mediaPreviewEl);

    // SVG inline preview (shown when toggling SVG code ↔ preview)
    this.svgPreviewEl.className = "svg-preview-container hidden";
    editorContainer.appendChild(this.svgPreviewEl);

    // SVG / Markdown toggle button (code ↔ preview)
    this.svgToggleBtn.className = "svg-toggle-btn hidden";
    this.svgToggleBtn.setAttribute("type", "button");
    this.svgToggleBtn.textContent = "Preview";
    this.svgToggleBtn.addEventListener("click", () => this.toggleRichPreview());
    editorContainer.appendChild(this.svgToggleBtn);

    // TODO panel container
    this.todoPanelEl.className = "todo-panel-container hidden";
    editorContainer.appendChild(this.todoPanelEl);

    // Undo / Redo toolbar — injected into the tab bar's parent (editor-top)
    const editorTop = this.tabsContainer.parentElement;
    if (editorTop) {
      const undoRedoBar = document.createElement("div");
      undoRedoBar.className = "editor-undo-redo";
      undoRedoBar.innerHTML = `
        <button class="editor-undo-redo-btn" id="editor-undo-btn" title="Undo (⌘Z)" aria-label="Undo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
          </svg>
        </button>
        <button class="editor-undo-redo-btn" id="editor-redo-btn" title="Redo (⌘⇧Z)" aria-label="Redo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
          </svg>
        </button>`;
      editorTop.appendChild(undoRedoBar);
      undoRedoBar.querySelector("#editor-undo-btn")!.addEventListener("click", () => this.undo());
      undoRedoBar.querySelector("#editor-redo-btn")!.addEventListener("click", () => this.redo());
    }

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

    // Editor right-click (override Monaco's context menu which is disabled)
    this.editorEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showEditorContextMenu(e as MouseEvent);
    });

    // Cmd/Ctrl + click to open URLs or navigate to definitions
    this.editorEl.addEventListener("click", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      void this.handleModifierClick(e as MouseEvent);
    });

    // Attach AI ghost text completer
    attachAICompleter(this.monacoEditor, this.editorEl);

    // Inline color swatches + picker
    this.colorHighlighter = new ColorHighlighter(this.monacoEditor);

    // Inline error/warning diagnostics — instance self-manages via Monaco's event bus
    new ErrorLens(this.monacoEditor);

    // Auto-save on change (debounced)
    this.monacoEditor.onDidChangeModelContent(() => {
      const tab = this.tabs.find((t) => t.path === this.activeTab);
      if (tab && !tab.lockedView) {
        tab.content = this.monacoEditor.getModel()?.getValue() ?? "";
        tab.modified = true;
        this.renderTabs();
      }
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      if (tab?.lockedView) return;
      this.saveTimeout = setTimeout(() => this.saveCurrentFile(), 1000);
    });

    // Initially hide editor
    this.editorEl.style.display = "none";

    this.renderTabs();

    void listen<WebMediaStatePayload>("web-media-state", ({ payload }) => {
      this.handleWebMediaState(payload);
    });

    this.applySettings(DEFAULT_EDITOR_SETTINGS);
  }

  private setupMonacoDefaults() {
    // monaco.languages.typescript is available after importing the contribution in monaco-env.ts
    // Cast via any — Monaco types mark .typescript as deprecated but it works at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tsLang = (monaco.languages as any).typescript as any;
    if (tsLang) {
      const moduleResolution = tsLang.ModuleResolutionKind?.Bundler ?? tsLang.ModuleResolutionKind?.Node ?? 2;
      // Use hardcoded 4 = ReactJSX as safety fallback — never let jsx be undefined/0 (None)
      const jsxEmit = tsLang.JsxEmit?.ReactJSX ?? 4;

      const tsCompilerOpts = {
        target: tsLang.ScriptTarget?.ESNext ?? 99,
        module: tsLang.ModuleKind?.ESNext ?? 99,
        moduleResolution,
        allowNonTsExtensions: true,
        jsx: jsxEmit,
        allowJs: true,
        checkJs: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
      };
      tsLang.typescriptDefaults.setCompilerOptions(tsCompilerOpts);
      tsLang.javascriptDefaults.setCompilerOptions({
        target: tsLang.ScriptTarget?.ESNext ?? 99,
        moduleResolution,
        allowNonTsExtensions: true,
        jsx: jsxEmit,
        allowJs: true,
        esModuleInterop: true,
      });
      tsLang.typescriptDefaults.setEagerModelSync(true);
      tsLang.javascriptDefaults.setEagerModelSync(true);

      // Suppress errors that are always false positives in Monaco's sandboxed environment.
      // Monaco has no access to node_modules on disk until we explicitly load them.
      //   2307 — Cannot find module 'X'
      //   2834 — Relative imports need explicit extensions (NodeNext/Node16 strict ESM — wrong for bundler projects)
      //   2875 — JSX tag requires 'react/jsx-runtime' path
      //   7016 — Could not find declaration file for module
      //   2580 — Cannot find name 'require' (Node.js global)
      //   2591 — Cannot find name 'module'
      //   2593 — Cannot find name 'exports'
      //   2669 — Augmentations for global scope nesting
      const diagnosticCodesToIgnore = [2307, 2834, 2875, 7016, 2580, 2591, 2593, 2669];
      tsLang.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore,
      });
      tsLang.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
        diagnosticCodesToIgnore,
      });

      // Inject minimal Node.js ambient globals so `process`, `Buffer`, `__dirname` etc. resolve
      tsLang.typescriptDefaults.addExtraLib(
        `declare var process: { env: Record<string, string | undefined>; argv: string[]; cwd(): string; exit(code?: number): never; platform: string; version: string; versions: Record<string, string>; };
         declare var __dirname: string;
         declare var __filename: string;
         declare function require(id: string): any;
         declare var Buffer: any;
         declare var global: typeof globalThis;`,
        "ts:injected/node-globals.d.ts"
      );
    }

    monaco.editor.defineTheme("athva-dark", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#1e1e1e" },
    });
    monaco.editor.defineTheme("athva-light", {
      base: "vs", inherit: true, rules: [],
      colors: { "editor.background": "#ffffff" },
    });
    monaco.editor.defineTheme("athva-dracula", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#1e1f29", "editor.foreground": "#f8f8f2" },
    });
    monaco.editor.defineTheme("athva-solarized", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#002b36", "editor.foreground": "#839496" },
    });
    monaco.editor.defineTheme("athva-nord", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#2e3440", "editor.foreground": "#d8dee9" },
    });
    monaco.editor.defineTheme("athva-catppuccin", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4" },
    });
    monaco.editor.defineTheme("athva-github-dark", {
      base: "vs-dark", inherit: true, rules: [],
      colors: { "editor.background": "#0d1117", "editor.foreground": "#c9d1d9" },
    });
  }

  private registerHoverProviders() {
    const self = this;
    const hoverProvider: monaco.languages.HoverProvider = {
      async provideHover(model, position) {
        if (!self.activeTab || !self.onHoverInfo) return null;
        const info = await self.onHoverInfo({
          path: self.activeTab,
          content: model.getValue(),
          row: position.lineNumber - 1,
          column: position.column - 1,
        }).catch(() => null);
        if (!info) return null;
        const contents: monaco.IMarkdownString[] = [
          { value: "```\n" + info.signature + "\n```" },
        ];
        if (info.documentation) contents.push({ value: info.documentation });
        if (info.definition) {
          contents.push({ value: `Defined in \`${info.definition.path}:${info.definition.line}:${info.definition.column}\`` });
        }
        return { contents };
      },
    };
    const langs = ["typescript", "javascript", "html", "css", "python", "rust", "json"];
    for (const lang of langs) {
      monaco.languages.registerHoverProvider(lang, hoverProvider);
    }
  }

  /** Register additional file-extension → Monaco language mappings from installed extensions. */
  registerExtensionLanguages(entries: Array<{ extensions: string[]; monacoLanguageId: string }>) {
    for (const entry of entries) {
      for (const rawExt of entry.extensions) {
        const ext = rawExt.replace(/^\./, "").toLowerCase();
        if (!ext || EXT_LANGUAGE_MAP[ext]) continue;
        const known = monaco.languages.getLanguages().some((l) => l.id === entry.monacoLanguageId);
        if (known) EXT_LANGUAGE_MAP[ext] = entry.monacoLanguageId;
      }
    }
  }

  setMonacoTheme(theme: string) {
    monaco.editor.setTheme(theme);
  }

  defineMonacoTheme(
    name: string,
    theme: {
      base: "vs" | "vs-dark";
      inherit: boolean;
      rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
      colors: Record<string, string>;
    }
  ) {
    monaco.editor.defineTheme(name, theme);
  }

  /** Register a Monaco completion provider for one or more languages */
  addCompletionProvider(languages: string[], provider: monaco.languages.CompletionItemProvider) {
    for (const lang of languages) {
      monaco.languages.registerCompletionItemProvider(lang, provider);
    }
  }

  private registerImportPathCompletionProvider() {
    this.addCompletionProvider(["typescript", "javascript"], {
      triggerCharacters: ['"', "'", "/", "@", "."],
      provideCompletionItems: async (model, position) => {
        const context = this.getImportStringContext(model, position);
        if (!context) return { suggestions: [] };

        const filePath = decodeURIComponent(model.uri.path);
        const projectRoot = await this.findProjectRoot(filePath);
        if (!projectRoot) return { suggestions: [] };

        const suggestions = await this.buildImportPathSuggestions(
          projectRoot,
          filePath,
          context.value,
          context.range
        );
        return { suggestions };
      },
    });
  }

  private registerNamedImportCompletionProvider() {
    this.addCompletionProvider(["typescript", "javascript"], {
      triggerCharacters: ["{", ",", " "],
      provideCompletionItems: async (model, position) => {
        const lineText = model.getLineContent(position.lineNumber);
        const col = position.column - 1;

        // Must be inside { } of a named import
        const braceOpen = lineText.lastIndexOf("{", col);
        const braceClose = lineText.indexOf("}", col);
        if (braceOpen === -1 || braceClose === -1) return { suggestions: [] };

        // Extract the from specifier on this line or the next
        const fullText = model.getValue();
        const lineOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: 1 });
        const window = fullText.slice(lineOffset, lineOffset + 300);
        const fromMatch = window.match(/from\s+['"]([^'"]+)['"]/);
        if (!fromMatch) return { suggestions: [] };

        const specifier = fromMatch[1];
        const dtsPath = this.packageDtsMap.get(specifier);
        if (!dtsPath) return { suggestions: [] };

        const names = await this.getExportedNames(dtsPath);
        if (!names.length) return { suggestions: [] };

        // Already-imported names on this line (avoid duplication)
        const alreadyImported = new Set(
          (lineText.slice(braceOpen + 1, braceClose).match(/\w+/g) ?? [])
        );

        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column,
          endColumn: position.column,
        };

        return {
          suggestions: names
            .filter((n) => !alreadyImported.has(n))
            .map((name) => ({
              label: name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: name,
              range,
              sortText: `0:${name}`,
            })),
        };
      },
    });
  }

  private async getExportedNames(filePath: string): Promise<string[]> {
    const cached = this.exportNamesCache.get(filePath);
    if (cached) return cached;
    try {
      const content = await invoke<string>("read_file", { path: filePath });
      const names = this.extractExportedNames(content);
      this.exportNamesCache.set(filePath, names);
      return names;
    } catch {
      return [];
    }
  }

  private extractExportedNames(content: string): string[] {
    const names = new Set<string>();
    // export (declare) function/class/const/let/var/type/interface/enum Name
    for (const m of content.matchAll(
      /export\s+(?:declare\s+)?(?:function|class|const|let|var|type|interface|enum|abstract\s+class)\s+(\w+)/g
    )) names.add(m[1]);
    // export { Name, Name as Alias }
    for (const m of content.matchAll(/export\s+\{([^}]+)\}/g))
      for (const part of m[1].split(",")) {
        const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (alias && alias !== "default") names.add(alias);
      }
    return [...names].filter((n) => n && n !== "default");
  }

  applySettings(settings: EditorSettings) {
    this.currentSettings = { ...settings };
    this.monacoEditor.updateOptions({
      fontSize: settings.fontSize,
      tabSize: settings.tabSize,
      wordWrap: settings.wordWrap ? "on" : "off",
      lineNumbers: settings.showGutter ? "on" : "off",
      minimap: { enabled: settings.showMinimap },
    });
    setAICompleterEnabled(settings.aiInlineSuggestions);
  }

  async openFile(path: string, name: string, line?: number, column?: number) {
    const existing = this.tabs.find((t) => t.path === path);
    if (existing) {
      this.switchToTab(path);
      if (line !== undefined) this.gotoPosition(line, column);
      return;
    }

    const ext = name.split(".").pop()?.toLowerCase() || "";
    const isBinary = IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);

    let content = "";
    if (!isBinary) {
      try {
        content = await invoke<string>("read_file", { path });
      } catch (e) {
        console.error(`Failed to read file [${path}]:`, e);
        return;
      }
    }

    const tab: OpenTab = { path, name, content, modified: false, pinned: false };
    this.tabs.push(tab);
    this.switchToTab(path);
    if (line !== undefined && !isBinary) this.gotoPosition(line, column);
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
    this.monacoEditor.setPosition({ lineNumber: line, column: Math.max(1, column) });
    this.monacoEditor.revealLineInCenter(line);
    this.monacoEditor.focus();
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
        if (this.activeTodoPanel) {
          // Reload the TODO panel in-place
          this.activeTodoPanel.reload(content);
        } else if (this.activeDocEditor) {
          // Reload the document editor in-place
          this.activeDocEditor.reload(content);
        } else {
          const cursor = this.monacoEditor.getPosition();
          const model = this.models.get(path);
          if (model) {
            model.setValue(content);
            if (cursor) {
              this.monacoEditor.setPosition(cursor);
              this.monacoEditor.revealPositionInCenter(cursor);
            }
          }
          this.monacoEditor.updateOptions({ readOnly: false });
        }
      }
      this.renderTabs();
      this.updateProtectedBanner(tab);
    } catch (e) {
      console.error(`Failed to reload file [${path}]:`, e);
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
    } else {
      // Dispose Monaco model for this file
      const model = this.models.get(path);
      if (model) { model.dispose(); this.models.delete(path); }
    }

    this.tabs.splice(idx, 1);

    if (this.activeTab === path) {
      if (this.tabs.length > 0) {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIdx].path);
      } else {
        this.activeTab = "";
        this.monacoEditor.setModel(null);
        this.monacoEditor.updateOptions({ readOnly: false });
        this.editorEl.style.display = "none";
        this.mediaPreviewEl.classList.add("hidden");
        this.mediaPreviewEl.innerHTML = "";
        this.svgPreviewEl.classList.add("hidden");
        this.svgPreviewEl.innerHTML = "";
        this.svgToggleBtn.classList.add("hidden");
        this.svgPreviewActive = false;
        this.currentPreviewType = null;
        this.todoPanelEl.classList.add("hidden");
        this.activeTodoPanel = null;
        this.activeDocEditor = null;
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
    const model = this.monacoEditor.getModel();
    if (model) return model.getValue();
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    return tab?.content ?? "";
  }

  insertText(text: string) {
    const sel = this.monacoEditor.getSelection();
    if (sel) this.monacoEditor.executeEdits("insert", [{ range: sel, text }]);
    this.monacoEditor.focus();
  }

  insertSnippet(snippet: string) {
    this.monacoEditor.trigger("keyboard", "editor.action.insertSnippet", { snippet });
    this.monacoEditor.focus();
  }

  undo() {
    this.monacoEditor.focus();
    this.monacoEditor.trigger("keyboard", "undo", null);
  }

  redo() {
    this.monacoEditor.focus();
    this.monacoEditor.trigger("keyboard", "redo", null);
  }

  private openDocumentEditor(path: string, content: string) {
    this.docEditorActive = true;
    this.activeDocEditor = new DocumentEditor(
      this.todoPanelEl,
      content,
      (text) => {
        // Direct save, no debounce for document editor
        const tab = this.tabs.find((t) => t.path === path);
        if (tab) {
          tab.content = text;
          void invoke("write_file", { path, content: text })
            .then(() => {
              tab.modified = false;
              this.renderTabs();
              this.onSaveCallback?.(path, text);
            })
            .catch((e) => console.error("Failed to save document:", e));
        }
      },
      () => {
        // Toggle to Monaco editor
        this.toggleDocEditorMode(path);
      }
    );
  }

  private toggleDocEditorMode(path: string) {
    const tab = this.tabs.find((t) => t.path === path);
    if (!tab) return;

    if (this.docEditorActive) {
      // Switch from doc editor to Monaco
      this.docEditorActive = false;
      this.todoPanelEl.classList.add("hidden");
      this.activeDocEditor = null;
      this.editorEl.style.display = "block";

      // Set up Monaco with current content
      const ext = tab.name.split(".").pop()?.toLowerCase() || "";
      const language = EXT_LANGUAGE_MAP[ext] || "plaintext";
      const uri = monaco.Uri.file(path);

      let model = this.models.get(path);
      if (!model) {
        model = monaco.editor.createModel(tab.content, language, uri);
        this.models.set(path, model);
      }

      this.monacoEditor.setModel(model);
      (this.monacoEditor as any)._athvaFilePath = path;
      (this.monacoEditor as any)._athvaFileName = tab.name;
      this.monacoEditor.focus();
    } else {
      // Switch from Monaco back to doc editor
      this.docEditorActive = true;
      this.editorEl.style.display = "none";
      this.todoPanelEl.classList.remove("hidden");
      const content = this.monacoEditor.getModel()?.getValue() ?? tab.content;
      this.openDocumentEditor(path, content);
    }
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

    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }

    this.emptyEl.style.display = "none";

    if (tab.kind === "web") {
      this.editorEl.style.display = "none";
      this.mediaPreviewEl.classList.add("hidden");
      this.svgPreviewEl.classList.add("hidden");
      this.svgToggleBtn.classList.add("hidden");
      this.svgPreviewActive = false;
      this.currentPreviewType = null;
      this.todoPanelEl.classList.add("hidden");
      this.activeTodoPanel = null;
      this.activeDocEditor = null;
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

    if (prevWebLabel) {
      void invoke("hide_web_window", { label: prevWebLabel });
      this.activeWebLabel = null;
    }

    const ext = tab.name.split(".").pop()?.toLowerCase() || "";

    // Reset all view states
    this.mediaPreviewEl.classList.add("hidden");
    this.mediaPreviewEl.innerHTML = "";
    this.svgPreviewEl.classList.add("hidden");
    this.svgPreviewEl.innerHTML = "";
    this.svgToggleBtn.classList.add("hidden");
    this.svgPreviewActive = false;
    this.currentPreviewType = null;
    this.todoPanelEl.classList.add("hidden");
    this.activeTodoPanel = null;
    this.activeDocEditor = null;

    // Image preview — read binary → base64 data URL (asset:// protocol not configured)
    if (IMAGE_EXTS.has(ext)) {
      this.editorEl.style.display = "none";
      this.mediaPreviewEl.classList.remove("hidden");
      this.mediaPreviewEl.innerHTML = `<span class="media-preview-loading">Loading…</span>`;
      this.updateProtectedBanner(tab);
      this.renderTabs();
      void this.loadMediaPreview(path, ext, "img");
      return;
    }

    // Video preview
    if (VIDEO_EXTS.has(ext)) {
      this.editorEl.style.display = "none";
      this.mediaPreviewEl.classList.remove("hidden");
      this.mediaPreviewEl.innerHTML = `<span class="media-preview-loading">Loading…</span>`;
      this.updateProtectedBanner(tab);
      this.renderTabs();
      void this.loadMediaPreview(path, ext, "video");
      return;
    }

    // TODO file — special task-manager UI
    const baseName = tab.name.toLowerCase().replace(/\.(md|txt|json)$/, "");
    if (baseName === "todo" || baseName === "todos") {
      this.editorEl.style.display = "none";
      this.todoPanelEl.classList.remove("hidden");
      this.activeTodoPanel = new TodoPanel(
        this.todoPanelEl,
        tab.content,
        (serialized) => {
          // Write directly to disk — same flow as saveCurrentFile().
          // We cannot use onSaveCallback() alone (that only updates the exports tracker, not the file)
          // and we cannot use saveCurrentFile() (it checks tab.modified and uses activeTab).
          tab.content = serialized;
          void invoke("write_file", { path, content: serialized })
            .then(() => {
              tab.modified = false;
              this.renderTabs();
              this.onSaveCallback?.(path, serialized);
            })
            .catch((e) => console.error("Failed to save TODO:", e));
        }
      );
      this.updateProtectedBanner(tab);
      this.renderTabs();
      return;
    }

    this.editorEl.style.display = "block";
    this.previewDefaultsToOn = false;

    // Show preview toggle for files with preview renderers.
    // CSV, XLSX, and Flowchart default to preview ON.
    if (ext === "svg") {
      this.currentPreviewType = "svg";
      this.svgToggleBtn.classList.remove("hidden");
      this.svgToggleBtn.textContent = "Preview";
    } else if (ext === "md" || ext === "mdx" || ext === "markdown") {
      this.currentPreviewType = "markdown";
      this.svgToggleBtn.classList.remove("hidden");
      this.svgToggleBtn.textContent = "Preview";
    } else if (ext === "csv") {
      this.currentPreviewType = "csv";
      this.svgToggleBtn.classList.remove("hidden");
      this.svgToggleBtn.textContent = "Code";
      this.previewDefaultsToOn = true;
    } else if (ext === "flow") {
      this.currentPreviewType = "flow";
      this.svgToggleBtn.classList.remove("hidden");
      this.svgToggleBtn.textContent = "Code";
      this.previewDefaultsToOn = true;
    } else if (ext === "xlsx" || ext === "xls") {
      this.currentPreviewType = "xlsx";
      this.svgToggleBtn.classList.remove("hidden");
      this.svgToggleBtn.textContent = "Code";
      this.previewDefaultsToOn = true;
    } else if (ext === "txt") {
      // TXT files open in document editor view (not Monaco), not as a toggleable preview
      this.editorEl.style.display = "none";
      this.todoPanelEl.classList.remove("hidden");
      // Reuse todoPanelEl container for document editor
      this.openDocumentEditor(path, tab.content);
      this.updateProtectedBanner(tab);
      this.renderTabs();
      return;
    }

    const language = EXT_LANGUAGE_MAP[ext] || "plaintext";
    const uri = monaco.Uri.file(path);

    let model = this.models.get(path) ?? monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(tab.content, language, uri);
      this.models.set(path, model);
    } else if (!this.models.has(path)) {
      this.models.set(path, model);
    }

    this.monacoEditor.setModel(model);
    (this.monacoEditor as any)._athvaFilePath = path;
    (this.monacoEditor as any)._athvaFileName = tab.name;

    this.monacoEditor.updateOptions({
      tabSize: this.currentSettings.tabSize,
      readOnly: !!tab.lockedView,
    });

    // Load node_modules types for TS/JS files (async, does nothing if already loaded for this project)
    if (language === "typescript" || language === "javascript") {
      void this.loadProjectTypesForFile(path);
    }

    // Auto-enable preview for CSV/XLSX/Flowchart files
    if (this.previewDefaultsToOn && this.currentPreviewType) {
      this.svgPreviewActive = true;
      this.editorEl.style.display = "none";
      this.svgPreviewEl.classList.remove("hidden");
      this.svgPreviewEl.innerHTML = '<span class="preview-loading">Rendering…</span>';
      void this.renderPreview(tab);
    }

    this.updateProtectedBanner(tab);
    this.renderTabs();
    if (!this.svgPreviewActive) this.monacoEditor.focus();
  }

  private updateProtectedBanner(tab: OpenTab) {
    const shouldShow = tab.kind !== "web" && !!tab.lockedView && tab.path === this.activeTab;
    this.protectedBannerEl.classList.toggle("hidden", !shouldShow);
  }

  private toggleRichPreview() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab) return;

    this.svgPreviewActive = !this.svgPreviewActive;

    if (this.svgPreviewActive) {
      this.editorEl.style.display = "none";
      this.svgPreviewEl.classList.remove("hidden");
      this.svgPreviewEl.innerHTML = '<span class="preview-loading">Rendering…</span>';

      void this.renderPreview(tab);
      this.svgToggleBtn.textContent = "Code";
    } else {
      this.svgPreviewEl.classList.add("hidden");
      this.svgPreviewEl.innerHTML = "";
      this.editorEl.style.display = "block";
      this.svgToggleBtn.textContent = "Preview";
      this.monacoEditor.focus();
    }
  }

  private async renderPreview(tab: OpenTab) {
    const content = this.monacoEditor.getModel()?.getValue() ?? tab.content;

    switch (this.currentPreviewType) {
      case "markdown": {
        this.svgPreviewEl.classList.add("md-mode");
        this.svgPreviewEl.innerHTML = `<div class="md-preview-body">${renderMarkdown(content)}</div>`;
        break;
      }
      case "csv": {
        this.svgPreviewEl.classList.remove("md-mode");
        if (content.length > 500_000) {
          this.svgPreviewEl.innerHTML = `<div class="preview-error">File too large to preview (&gt;500KB).</div>`;
          break;
        }
        const html = renderCSVPreview(content);
        this.svgPreviewEl.innerHTML = html;
        break;
      }
      case "txt": {
        this.svgPreviewEl.classList.remove("md-mode");
        const html = renderTextPreview(content);
        this.svgPreviewEl.innerHTML = html;
        break;
      }
      case "flow": {
        this.svgPreviewEl.classList.remove("md-mode");
        const html = await renderFlowPreview(content);
        this.svgPreviewEl.innerHTML = html;
        // Mermaid needs to be re-rendered after DOM insertion
        setTimeout(() => {
          const mermaid = (globalThis as any).mermaid;
          if (mermaid && mermaid.run) {
            // Clear any existing diagrams and re-render
            mermaid.run().catch((err: any) => {
              console.warn("Mermaid rendering warning:", err);
              // Mermaid renders best-effort, some diagrams may not support all layouts
            });
          } else {
            console.warn("Mermaid not loaded");
          }
        }, 0);
        break;
      }
      case "xlsx": {
        this.svgPreviewEl.classList.remove("md-mode");
        if (content.length > 2_000_000) {
          this.svgPreviewEl.innerHTML = `<div class="preview-error">File too large to preview (&gt;2MB).</div>`;
          break;
        }
        try {
          const uint8 = new TextEncoder().encode(content);
          const html = await renderXlsxPreview(uint8.buffer);
          this.svgPreviewEl.innerHTML = html;
        } catch (e) {
          this.svgPreviewEl.innerHTML = `<div class="preview-error">Failed to render XLSX: ${e}</div>`;
        }
        break;
      }
      case "svg":
      default: {
        this.svgPreviewEl.classList.remove("md-mode");
        const sanitizedSvg = content
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "")
          .replace(/\s+on\w+\s*=\s*'[^']*'/gi, "")
          .replace(/javascript\s*:/gi, "");
        this.svgPreviewEl.innerHTML = `<div class="svg-preview-inner">${sanitizedSvg}</div>`;
        break;
      }
    }
  }

  private async loadMediaPreview(path: string, ext: string, kind: "img" | "video") {
    // Only render if this path is still the active tab
    if (this.activeTab !== path) return;
    try {
      const bytes = await readFile(path);
      if (this.activeTab !== path) return; // guard against tab switch during load
      const mime = MIME_MAP[ext] ?? (kind === "video" ? "video/mp4" : "image/png");
      const b64 = btoa(
        Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join("")
      );
      const src = `data:${mime};base64,${b64}`;
      if (kind === "img") {
        this.mediaPreviewEl.innerHTML = `<img src="${src}" alt="${path.split("/").pop()}" class="media-preview-img" />`;
      } else {
        this.mediaPreviewEl.innerHTML = `<video src="${src}" controls class="media-preview-video"></video>`;
      }
    } catch (e) {
      if (this.activeTab !== path) return;
      this.mediaPreviewEl.innerHTML = `<span class="media-preview-error">Failed to load preview: ${e}</span>`;
    }
  }

  // ─── Project type loader ────────────────────────────────────────────────────
  // Reads .d.ts files from the project's node_modules and registers them with
  // Monaco's TypeScript language service so completions and hover info work.

  private async loadProjectTypesForFile(filePath: string): Promise<void> {
    const projectRoot = await this.findProjectRoot(filePath);
    if (!projectRoot || this.projectTypesLoaded.has(projectRoot)) return;
    this.projectTypesLoaded.add(projectRoot); // mark before async work to prevent double-load

    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      const raw = await invoke<string>("read_file", { path: `${projectRoot}/package.json` });
      pkg = JSON.parse(raw);
    } catch {
      return; // No package.json — not a node project
    }

    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    this.projectDependencyCache.set(projectRoot, deps.sort((a, b) => a.localeCompare(b)));
    const projectCompilerConfig = await this.loadProjectCompilerConfig(projectRoot);

    // Load library types concurrently, collecting exact entry-point paths
    const pathsEntries = (await Promise.all(deps.map((d) => this.loadPackageTypes(projectRoot, d))))
      .filter((e): e is { name: string; dtsPath: string; pkgDir: string } => e !== null);
    const sourceFiles = await this.loadProjectSourceModels(projectRoot, filePath);

    // Build exact (non-wildcard) paths map so TypeScript resolves via fileExists() only —
    // Monaco's TS worker does not implement directoryExists(), so wildcard paths entries
    // silently fail. We expand them into per-file exact mappings here.
    const exactPaths: Record<string, string[]> = {};

    // Library entries: "mermaid" → ["/abs/path/mermaid/dist/mermaid.d.ts"]
    for (const entry of pathsEntries) {
      exactPaths[entry.name] = [entry.dtsPath];
      // Register for named-import completions: import { } from 'mermaid'
      this.packageDtsMap.set(entry.name, entry.dtsPath);
    }

    // Tsconfig alias entries: expand "@/*" → ["./src/*"] into per-file exact mappings
    if (projectCompilerConfig.paths) {
      const configBaseUrl = projectCompilerConfig.baseUrl ?? projectRoot;
      for (const [aliasPattern, targets] of Object.entries(projectCompilerConfig.paths)) {
        if (!aliasPattern.endsWith("/*")) {
          exactPaths[aliasPattern] = targets;
          continue;
        }
        const aliasPrefix = aliasPattern.slice(0, -2); // "@/*" → "@/"
        for (const target of targets) {
          if (!target.endsWith("/*")) continue;
          // Strip leading ./ and /* to get the base dir, then resolve against configBaseUrl
          const stripped = target.slice(0, -2).replace(/^\.\//, "");
          const targetBase = stripped.startsWith("/") ? stripped : `${configBaseUrl}/${stripped}`;
          for (const sf of sourceFiles) {
            if (!sf.startsWith(targetBase + "/")) continue;
            const suffix = sf.slice(targetBase.length + 1).replace(/\.[^.]+$/, "");
            const alias = `${aliasPrefix}${suffix}`;
            if (!exactPaths[alias]) exactPaths[alias] = [sf];
            // Register for named-import completions: import { } from '@/utils'
            if (!this.packageDtsMap.has(alias)) this.packageDtsMap.set(alias, sf);
          }
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tsLang = (monaco.languages as any).typescript as any;
    if (tsLang) {
      const patchOpts = (defaults: any) => {
        defaults.setCompilerOptions({
          ...defaults.getCompilerOptions(),
          baseUrl: projectRoot,
          paths: exactPaths,
        });
      };
      patchOpts(tsLang.typescriptDefaults);
      patchOpts(tsLang.javascriptDefaults);
    }
  }

  private async loadProjectSourceModels(projectRoot: string, activeFilePath: string): Promise<string[]> {
    const sourceFiles = await this.getProjectSourceFiles(projectRoot);
    const tasks = sourceFiles
      .filter((filePath) => filePath !== activeFilePath && !this.models.has(filePath))
      .map(async (filePath) => {
        try {
          const content = await invoke<string>("read_file", { path: filePath });
          const ext = filePath.split(".").pop()?.toLowerCase() || "";
          const language = EXT_LANGUAGE_MAP[ext] || "plaintext";
          const uri = monaco.Uri.file(filePath);
          const existingModel = monaco.editor.getModel(uri);
          if (existingModel) {
            this.models.set(filePath, existingModel);
            return;
          }
          const model = monaco.editor.createModel(content, language, uri);
          this.models.set(filePath, model);
        } catch {
          // Skip unreadable files without breaking the rest of the project index.
        }
      });

    await Promise.allSettled(tasks);
    return sourceFiles;
  }

  private async getProjectSourceFiles(projectRoot: string): Promise<string[]> {
    const cached = this.projectSourceFileCache.get(projectRoot);
    if (cached) return cached;

    const files = await this.collectProjectSourceFiles(projectRoot, 0, []);
    files.sort((a, b) => a.localeCompare(b));
    this.projectSourceFileCache.set(projectRoot, files);
    return files;
  }

  private async collectProjectSourceFiles(
    dir: string,
    depth: number,
    files: string[]
  ): Promise<string[]> {
    if (depth > 6 || files.length >= 250) return files;

    let entries: { name: string; isFile: boolean; isDirectory: boolean }[];
    try {
      entries = await readDir(dir);
    } catch {
      return files;
    }

    const tasks: Promise<void>[] = [];
    for (const entry of entries) {
      if (files.length >= 250) break;

      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === "coverage" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        tasks.push(
          this.collectProjectSourceFiles(path, depth + 1, files).then(() => undefined)
        );
        continue;
      }

      if (!entry.isFile) continue;

      const ext = entry.name.split(".").pop()?.toLowerCase() || "";
      if (this.importableSourceExts.has(ext)) files.push(path);
    }

    await Promise.allSettled(tasks);
    return files;
  }

  private getImportStringContext(
    model: monaco.editor.ITextModel,
    position: monaco.Position
  ): { value: string; range: monaco.IRange } | null {
    const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const patterns = [
      /(?:^|\s)import\s+['"]([^'"]*)$/,
      /(?:from\s*|import\s*\(\s*)['"]([^'"]*)$/,
      /(?:export\s+\*\s+from\s*|export\s+\{[^}]*\}\s+from\s*)['"]([^'"]*)$/,
    ];

    for (const pattern of patterns) {
      const match = linePrefix.match(pattern);
      if (!match) continue;
      const value = match[1] ?? "";
      return {
        value,
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column - value.length,
          endColumn: position.column,
        },
      };
    }

    return null;
  }

  private async buildImportPathSuggestions(
    projectRoot: string,
    filePath: string,
    typedValue: string,
    range: monaco.IRange
  ): Promise<monaco.languages.CompletionItem[]> {
    const [dependencyNames, sourceFiles, projectCompilerConfig] = await Promise.all([
      this.getProjectDependencyNames(projectRoot),
      this.getProjectSourceFiles(projectRoot),
      this.loadProjectCompilerConfig(projectRoot),
    ]);

    const suggestions: monaco.languages.CompletionItem[] = [];
    const seen = new Set<string>();
    const normalizedTyped = typedValue.trim();
    const currentDir = filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")));
    const includeDependencies =
      !normalizedTyped ||
      (!normalizedTyped.startsWith(".") &&
        !normalizedTyped.startsWith("/"));

    const pushSuggestion = (
      label: string,
      detail: string,
      kind: monaco.languages.CompletionItemKind,
      rank: string
    ) => {
      if (!label || seen.has(label)) return;
      if (normalizedTyped && !label.toLowerCase().startsWith(normalizedTyped.toLowerCase())) return;
      seen.add(label);
      suggestions.push({
        label,
        kind,
        detail,
        insertText: label,
        range,
        sortText: `${rank}:${label}`,
      });
    };

    if (includeDependencies) {
      dependencyNames.forEach((name) => {
        pushSuggestion(name, "dependency", monaco.languages.CompletionItemKind.Module, "0");
      });
    }

    sourceFiles.forEach((sourceFile) => {
      if (sourceFile === filePath) return;

      const aliasSpecifiers = this.buildAliasImportSpecifiers(sourceFile, projectRoot, projectCompilerConfig.paths);
      aliasSpecifiers.forEach((aliasSpecifier) => {
        if (!normalizedTyped || !aliasSpecifier.startsWith(".") && aliasSpecifier.toLowerCase().startsWith(normalizedTyped.toLowerCase())) {
          pushSuggestion(aliasSpecifier, "path alias", monaco.languages.CompletionItemKind.Module, "1");
        }
      });

      if (normalizedTyped.startsWith(".")) {
        const relativeSpecifier = this.toRelativeImportSpecifier(currentDir, sourceFile);
        pushSuggestion(relativeSpecifier, "relative module", monaco.languages.CompletionItemKind.File, "2");
      }
    });

    return suggestions.slice(0, 200);
  }

  private async getProjectDependencyNames(projectRoot: string): Promise<string[]> {
    const cached = this.projectDependencyCache.get(projectRoot);
    if (cached) return cached;

    try {
      const raw = await invoke<string>("read_file", { path: `${projectRoot}/package.json` });
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ].sort((a, b) => a.localeCompare(b));
      this.projectDependencyCache.set(projectRoot, deps);
      return deps;
    } catch {
      return [];
    }
  }

  private async loadProjectCompilerConfig(projectRoot: string): Promise<ProjectCompilerConfig> {
    const cached = this.projectCompilerConfigCache.get(projectRoot);
    if (cached) return cached;

    const candidates = [`${projectRoot}/tsconfig.json`, `${projectRoot}/jsconfig.json`];
    for (const filePath of candidates) {
      try {
        const raw = await invoke<string>("read_file", { path: filePath });
        const parsed = this.parseConfigJson(raw) as { compilerOptions?: Record<string, unknown> };
        const compilerOptions = parsed.compilerOptions ?? {};
        const config: ProjectCompilerConfig = {
          baseUrl: this.resolveConfigBaseUrl(projectRoot, compilerOptions.baseUrl),
          paths: this.normalizeConfigPaths(compilerOptions.paths, projectRoot),
          typeRoots: this.normalizeConfigTypeRoots(projectRoot, compilerOptions.typeRoots),
        };
        this.projectCompilerConfigCache.set(projectRoot, config);
        return config;
      } catch {
        // Keep trying fallbacks.
      }
    }

    const fallback: ProjectCompilerConfig = {
      baseUrl: projectRoot,
      paths: undefined,
      typeRoots: [`${projectRoot}/node_modules/@types`],
    };
    this.projectCompilerConfigCache.set(projectRoot, fallback);
    return fallback;
  }

  private parseConfigJson(raw: string): unknown {
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(withoutTrailingCommas);
  }

  private resolveConfigBaseUrl(projectRoot: string, baseUrlValue: unknown): string | undefined {
    if (typeof baseUrlValue !== "string" || !baseUrlValue.trim()) {
      return projectRoot;
    }
    return this.resolveProjectPath(projectRoot, baseUrlValue);
  }

  private normalizeConfigPaths(value: unknown, projectRoot?: string): Record<string, string[]> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, rawValue]) => {
        if (!Array.isArray(rawValue)) return null;
        const next = rawValue
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => {
            // Resolve relative paths against projectRoot so Monaco's TS worker finds them
            if (projectRoot && (item.startsWith("./") || item.startsWith("../"))) {
              return this.resolveProjectPath(projectRoot, item);
            }
            return item;
          });
        return next.length ? [key, next] as const : null;
      })
      .filter((entry): entry is readonly [string, string[]] => Boolean(entry));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  private normalizeConfigTypeRoots(projectRoot: string, value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return ["node_modules/@types"];
    const next = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.startsWith(".") ? this.resolveProjectPath(projectRoot, item) : item);
    return next.length ? next : ["node_modules/@types"];
  }

  private resolveProjectPath(projectRoot: string, relativePath: string): string {
    const base = projectRoot.replace(/\/+$/, "");
    const segments = [...base.split("/").filter(Boolean)];
    for (const part of relativePath.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private buildAliasImportSpecifiers(
    sourceFile: string,
    projectRoot: string,
    paths?: Record<string, string[]>
  ): string[] {
    if (!paths) return [];
    const matches: string[] = [];

    for (const [aliasPattern, targets] of Object.entries(paths)) {
      if (!aliasPattern.includes("*")) continue;
      const [aliasPrefix, aliasSuffix] = aliasPattern.split("*");

      for (const targetPattern of targets) {
        if (!targetPattern.includes("*")) continue;
        const [targetPrefix, targetSuffix] = targetPattern.split("*");
        const absolutePrefix = this.resolveProjectPath(projectRoot, targetPrefix);
        const absoluteSuffix = targetSuffix ?? "";
        if (!sourceFile.startsWith(absolutePrefix) || !sourceFile.endsWith(absoluteSuffix)) continue;

        const inner = sourceFile
          .slice(absolutePrefix.length, sourceFile.length - absoluteSuffix.length)
          .replace(/^\/+/, "");
        const specifier = `${aliasPrefix}${this.toImportSpecifier(inner)}${aliasSuffix ?? ""}`;
        matches.push(specifier);
      }
    }

    return [...new Set(matches)];
  }

  private toImportSpecifier(rawPath: string): string {
    return rawPath.replace(this.importableSourceSuffixRe, "").replace(/\/index$/, "");
  }

  private toRelativeImportSpecifier(fromDir: string, toFile: string): string {
    const fromParts = fromDir.split("/").filter(Boolean);
    const toParts = toFile.split("/").filter(Boolean);
    while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
      fromParts.shift();
      toParts.shift();
    }
    const up = fromParts.map(() => "..");
    const joined = [...up, ...toParts].join("/");
    const relative = joined.startsWith(".") ? joined : `./${joined}`;
    return this.toImportSpecifier(relative);
  }

  private async findProjectRoot(filePath: string): Promise<string | null> {
    const segments = filePath.split("/");
    for (let i = segments.length - 1; i > 0; i--) {
      const dir = segments.slice(0, i).join("/");
      try {
        await invoke<string>("read_file", { path: `${dir}/package.json` });
        return dir;
      } catch { /* keep walking up */ }
    }
    return null;
  }

  private async loadPackageTypes(
    projectRoot: string,
    pkgName: string
  ): Promise<{ name: string; dtsPath: string; pkgDir: string } | null> {
    const typesKey = pkgName.startsWith("@")
      ? pkgName.slice(1).replace("/", "__")
      : pkgName;

    const candidates = [
      `${projectRoot}/node_modules/@types/${typesKey}`,
      `${projectRoot}/node_modules/${pkgName}`,
    ];

    for (const dir of candidates) {
      const dtsPath = await this.resolvePackageDtsEntry(dir);
      if (!dtsPath) continue;
      await this.loadDtsFromDir(dir, 0);
      return { name: pkgName, dtsPath, pkgDir: dir };
    }
    return null;
  }

  private async resolvePackageDtsEntry(pkgDir: string): Promise<string | null> {
    try {
      const raw = await invoke<string>("read_file", { path: `${pkgDir}/package.json` });
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const typesField = (pkg["types"] ?? pkg["typings"]) as string | undefined;
      const relative = typesField ? typesField.replace(/^\.\//, "") : "index.d.ts";
      const resolved = `${pkgDir}/${relative}`;
      await invoke<string>("read_file", { path: resolved });
      return resolved;
    } catch {
      try {
        const fallback = `${pkgDir}/index.d.ts`;
        await invoke<string>("read_file", { path: fallback });
        return fallback;
      } catch {
        return null;
      }
    }
  }

  private async loadDtsFromDir(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries: { name: string; isFile: boolean; isDirectory: boolean }[];
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }

    const tasks: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.isFile && entry.name.endsWith(".d.ts")) {
        tasks.push(this.registerExtraLib(`${dir}/${entry.name}`));
      } else if (
        entry.isDirectory &&
        depth < 3 &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith(".")
      ) {
        tasks.push(this.loadDtsFromDir(`${dir}/${entry.name}`, depth + 1));
      }
    }
    await Promise.allSettled(tasks);
  }

  private async registerExtraLib(filePath: string): Promise<void> {
    if (this.extraLibPaths.has(filePath)) return;
    this.extraLibPaths.add(filePath);
    try {
      const content = await invoke<string>("read_file", { path: filePath });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tsLang = (monaco.languages as any).typescript as any;
      if (tsLang) {
        // Key must be the plain absolute path — TypeScript's fileExists() receives
        // plain paths (not file:// URIs) when resolving via the paths[] compiler option.
        tsLang.typescriptDefaults.addExtraLib(content, filePath);
        tsLang.javascriptDefaults.addExtraLib(content, filePath);
      }
    } catch { /* unreadable — skip */ }
  }
  // ────────────────────────────────────────────────────────────────────────────

  private getEditorContainerBounds(): { x: number; y: number; width: number; height: number } {
    const container = document.getElementById("editor-container") ?? this.editorEl.parentElement!;
    const rect = container.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
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

    const pos = this.monacoEditor.getPosition();
    if (!pos) return false;
    const model = this.monacoEditor.getModel();
    if (!model) return false;

    const line = model.getLineContent(pos.lineNumber);
    const beforeCursor = line.slice(0, pos.column - 1);
    const match = beforeCursor.match(/([A-Za-z][A-Za-z0-9:_-]*(?:[A-Za-z0-9:_\-#.>\[\]="'\{\}*+$@])*|[.#][A-Za-z0-9_-][A-Za-z0-9:_\-#.>\[\]="'\{\}*+$@]*)$/);
    const abbreviation = match?.[1];
    if (!abbreviation || abbreviation.length < 1) return false;
    if (!/[.#>\[*{]/.test(abbreviation) && !HTML_TAGS.has(abbreviation) && !abbreviation.includes("-")) {
      return false;
    }

    const snippet = this.expandEmmetAbbreviation(abbreviation, ext === "jsx" || ext === "tsx");
    if (!snippet) return false;

    const startColumn = pos.column - abbreviation.length;
    this.monacoEditor.executeEdits("emmet", [{
      range: { startLineNumber: pos.lineNumber, startColumn, endLineNumber: pos.lineNumber, endColumn: pos.column },
      text: "",
    }]);
    this.monacoEditor.trigger("keyboard", "editor.action.insertSnippet", { snippet });
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
      const searchInput = this.tabPickerDropdown.querySelector<HTMLInputElement>(".tab-picker-search");
      if (searchInput) {
        searchInput.value = "";
        this.tabPickerDropdown.querySelectorAll<HTMLElement>(".tab-picker-section, .tab-picker-preset").forEach((el) => { el.style.display = ""; });
        const noResults = this.tabPickerDropdown.querySelector<HTMLElement>(".tab-picker-no-results");
        if (noResults) noResults.classList.add("hidden");
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
          { label: "GitLab", url: "https://gitlab.com", icon: `<svg viewBox="0 0 586 559" fill="none"><path d="M461.52 301.03L292.99 558.5 124.46 301.03l168.53-518.55L461.52 301.03z" fill="#E24329"/><path d="M292.99 558.5L124.46 301.03H.5L292.99 558.5z" fill="#FC6D26"/><path d="M292.99 558.5L461.52 301.03H585.5L292.99 558.5z" fill="#FC6D26"/></svg>` },
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
        label: "AI", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>`,
        items: [
          { label: "ChatGPT", url: "https://chat.openai.com", icon: `<svg viewBox="0 0 41 41" fill="currentColor"><path d="M37.5 16.9a9.7 9.7 0 0 0-.8-7.9 10 10 0 0 0-10.8-4.8A9.7 9.7 0 0 0 18.6 1a10 10 0 0 0-9.5 6.9 9.7 9.7 0 0 0-6.5 4.7 10 10 0 0 0 1.2 11.7 9.7 9.7 0 0 0 .8 7.9 10 10 0 0 0 10.8 4.8 9.7 9.7 0 0 0 7.3 3.3 10 10 0 0 0 9.6-6.9 9.7 9.7 0 0 0 6.4-4.7 10 10 0 0 0-1.2-11.8z"/></svg>` },
          { label: "Gemini", url: "https://gemini.google.com", icon: `<svg viewBox="0 0 28 28" fill="none"><path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" fill="url(#gg)"/><defs><linearGradient id="gg" x1="0" y1="0" x2="28" y2="28"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#EA4335"/></linearGradient></defs></svg>` },
          { label: "Claude", url: "https://claude.ai", icon: `<svg viewBox="0 0 46 46" fill="none"><path d="M23 0C10.3 0 0 10.3 0 23s10.3 23 23 23 23-10.3 23-23S35.7 0 23 0zm0 8c2.2 0 4 1.8 4 4s-1.8 4-4 4-4-1.8-4-4 1.8-4 4-4zm-9 28v-2c0-5 4-9 9-9s9 4 9 9v2H14z" fill="#D97757"/></svg>` },
          { label: "Perplexity", url: "https://www.perplexity.ai", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#20808D"/><path d="M25 10l10 10H15L25 10zM15 20h20v20H15V20zm5 5v10h10V25H20z" fill="white"/></svg>` },
        ]
      },
      {
        label: "Search", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`,
        items: [
          { label: "Google", url: "https://www.google.com", icon: `<svg viewBox="0 0 48 48" fill="none"><path d="M43.6 20H24v8h11.3C33.6 33.4 29.3 36 24 36a12 12 0 1 1 0-24c3 0 5.7 1.1 7.8 2.9L37.4 9A20 20 0 1 0 24 44c11 0 20-9 20-20 0-1.3-.1-2.7-.4-4z" fill="#FFC107"/></svg>` },
          { label: "Bing", url: "https://www.bing.com", icon: `<svg viewBox="0 0 32 32" fill="none"><path d="M7 3l5 2v18l7-4 2-7-7-2-1-4 13 4v11l-13 7-6-3z" fill="#008373"/></svg>` },
          { label: "DuckDuckGo", url: "https://duckduckgo.com", icon: `<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="25" r="25" fill="#DE5833"/><circle cx="25" cy="22" r="12" fill="white"/></svg>` },
        ]
      },
      {
        label: "Social Media", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
        items: [
          { label: "GitHub", url: "https://github.com", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>` },
          { label: "Twitter / X", url: "https://twitter.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="black"/><path d="M8 8h10l7 10 8-10h9L29 24l15 18H34L25 30l-9 12H7L21 26 8 8z" fill="white"/></svg>` },
          { label: "LinkedIn", url: "https://www.linkedin.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="8" fill="#0A66C2"/><rect x="10" y="18" width="8" height="24" rx="1" fill="white"/><circle cx="14" cy="12" r="5" fill="white"/><path d="M24 18h7v3c1.5-2 4-3.5 7-3.5 5.5 0 9 3.5 9 9.5V42h-8V29c0-3-1-4.5-3.5-4.5S32 26 32 29v13h-8V18z" fill="white"/></svg>` },
          { label: "YouTube", url: "https://www.youtube.com", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#FF0000"/><path d="M40 18s-.3-2.4-1.5-3.4C37 13.1 35.4 13 34.7 13c-4.7-.3-11.7-.3-11.7-.3s-7 0-11.7.3c-.7 0-2.3.1-3.8 1.6C6.3 15.6 6 18 6 18S5.7 20.7 5.7 23.5v2.5c0 2.7.3 5.5.3 5.5s.3 2.4 1.5 3.4c1.5 1.5 3.4 1.4 4.3 1.5C14.5 36.2 24 36.3 24 36.3s7 0 11.7-.4c.7-.1 2.3-.1 3.8-1.6 1.2-1 1.5-3.4 1.5-3.4s.3-2.7.3-5.5v-2.5C40.3 20.7 40 18 40 18zM21 29.5v-10l10 5-10 5z" fill="white"/></svg>` },
          { label: "Discord", url: "https://discord.com/app", icon: `<svg viewBox="0 0 50 50" fill="none"><rect width="50" height="50" rx="10" fill="#5865F2"/><path d="M34 16c-2.5-1.2-5.2-2-8-2.3l-.5.9c2.4.6 4.6 1.6 6.5 3-3-1.5-6.4-2.2-10-2.2s-7 .7-10 2.2c1.9-1.4 4.1-2.4 6.5-3l-.5-.9c-2.8.3-5.5 1.1-8 2.3-3.2 8.5-3.5 16 0 21.3 2.3 2.9 5.4 4.2 8.5 4.2l1.5-1.8c-1.8-.5-3.5-1.4-5-2.7 3 2 6.5 3 10 3s7-.9 10-3c-1.5 1.3-3.2 2.2-5 2.7l1.5 1.8c3.1 0 6.2-1.3 8.5-4.2 3.5-5.3 3.2-12.8 0-21.3zM19 33c-1.7 0-3-1.5-3-3.5S17.3 26 19 26s3 1.5 3 3.5-1.3 3.5-3 3.5zm12 0c-1.7 0-3-1.5-3-3.5S29.3 26 31 26s3 1.5 3 3.5-1.3 3.5-3 3.5z" fill="white"/></svg>` },
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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14H8v-1H2.5a.5.5 0 0 1-.5-.5V6h12v2.5h1V3.5A1.5 1.5 0 0 0 13.5 2h-11zm0 1h11a.5.5 0 0 1 .5.5V5H2V3.5a.5.5 0 0 1 .5-.5zm9.75 6a.5.5 0 0 1 .5.5V12h2.5a.5.5 0 0 1 0 1h-2.5v2.5a.5.5 0 0 1-1 0V13h-2.5a.5.5 0 0 1 0-1h2.5V9.5a.5.5 0 0 1 .5-.5z"/></svg>
          </span>
          <span>
            <strong>Open file in editor</strong>
            <small>Use Quick Open to choose a workspace file</small>
          </span>
        </button>
      </div>
      <div class="tab-picker-panel hidden" data-panel="web">
        <div class="tab-picker-search-wrap">
          <svg class="tab-picker-search-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input class="tab-picker-search" type="text" placeholder="Search…" spellcheck="false" autocomplete="off" />
        </div>
        <div class="tab-picker-sections">
          ${sectionsHTML}
        </div>
        <div class="tab-picker-no-results hidden">No results</div>
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

    this.tabPickerDropdown.addEventListener("input", (e) => {
      const search = e.target as HTMLElement;
      if (!search.classList.contains("tab-picker-search")) return;
      const query = (search as HTMLInputElement).value.trim().toLowerCase();
      const sections = this.tabPickerDropdown.querySelectorAll<HTMLElement>(".tab-picker-section");
      let anyVisible = false;
      sections.forEach((section) => {
        const presets = section.querySelectorAll<HTMLElement>(".tab-picker-preset");
        let sectionVisible = false;
        presets.forEach((preset) => {
          const label = (preset.dataset.label ?? "").toLowerCase();
          const show = !query || label.includes(query);
          preset.style.display = show ? "" : "none";
          if (show) sectionVisible = true;
        });
        section.style.display = sectionVisible ? "" : "none";
        if (sectionVisible) anyVisible = true;
      });
      const noResults = this.tabPickerDropdown.querySelector<HTMLElement>(".tab-picker-no-results");
      if (noResults) noResults.classList.toggle("hidden", anyVisible);
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
    const tabsHTML = this.tabs.map((tab) => {
      const isWeb = tab.kind === "web";
      const isPlaying = isWeb && this.webTabMediaState.get(tab.path) === true;
      return `
        <div class="editor-tab ${tab.path === this.activeTab ? "active" : ""}${tab.pinned ? " pinned" : ""}${isWeb ? " web-tab" : ""}" data-path="${this.escapeAttr(tab.path)}">
          ${tab.pinned ? `<span class="editor-tab-pin">&#x2605;</span>` : ""}
          ${isWeb ? `<span class="editor-tab-web-icon"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13A6.5 6.5 0 0 1 8 1.5zM6.3 3.1C5.5 4.3 5 5.9 4.9 7.3H2.6a5.4 5.4 0 0 1 3.7-4.2zm3.4 0a5.4 5.4 0 0 1 3.7 4.2h-2.3c-.1-1.4-.6-3-1.4-4.2zM4.9 8.7c.1 1.4.6 3 1.4 4.2A5.4 5.4 0 0 1 2.6 8.7H4.9zm5.2 0h2.3a5.4 5.4 0 0 1-3.7 4.2c.8-1.2 1.3-2.8 1.4-4.2zM6.4 8.7h3.2c-.1 1.2-.5 2.6-1.1 3.6-.3.5-.5.7-.5.7s-.2-.2-.5-.7c-.6-1-.9-2.4-1.1-3.6zm0-1.4c.2-1.2.5-2.6 1.1-3.6.3-.5.5-.7.5-.7s.2.2.5.7c.6 1 .9 2.4 1.1 3.6H6.4z"/></svg></span>` : ""}
          <span class="editor-tab-label">
            <span class="editor-tab-title">${this.escapeHtml(tab.name)}${tab.modified ? " \u2022" : ""}</span>
            ${isPlaying ? `<span class="editor-tab-media-indicator" title="Media playing"><svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 6.25a.75.75 0 0 1 1.28-.53L7.06 8l-2.28 2.28A.75.75 0 1 1 3.72 9.22L4.94 8 3.72 6.78a.75.75 0 0 1-.22-.53zm4-.78a.75.75 0 0 1 .75.75v3.56a.75.75 0 1 1-1.5 0V6.22a.75.75 0 0 1 .75-.75z"/></svg></span>` : ""}
          </span>
          <button class="editor-tab-close" data-close="${this.escapeAttr(tab.path)}">\u00D7</button>
        </div>
      `;
    }).join("");

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
        if (me.button === 2) {
          me.preventDefault();
          window.getSelection()?.removeAllRanges();
          return;
        }
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
        window.getSelection()?.removeAllRanges();
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

    const firstUnpinnedIdx = this.tabs.findIndex((t) => !t.pinned);
    const pinnedCount = firstUnpinnedIdx === -1 ? this.tabs.length : firstUnpinnedIdx;

    let effectiveTargetIdx = targetIdx;
    if (!!fromTab.pinned !== !!targetTab.pinned) {
      effectiveTargetIdx = fromTab.pinned ? pinnedCount - 1 : pinnedCount;
      insertBefore = fromTab.pinned;
    }

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
      console.error(`Failed to save file [${tab.path}]:`, e);
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

  private async handleModifierClick(e: MouseEvent) {
    const target = this.monacoEditor.getTargetAtClientPoint(e.clientX, e.clientY);
    if (!target?.position) return;

    const { lineNumber, column } = target.position;
    const model = this.monacoEditor.getModel();
    if (!model) return;

    const line = model.getLineContent(lineNumber);
    const urlRegex = /https?:\/\/[^\s"')\]>]+/g;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(line)) !== null) {
      if (column - 1 >= match.index && column - 1 <= match.index + match[0].length) {
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
      content: model.getValue(),
      row: lineNumber - 1,
      column: column - 1,
    });
  }

  setAISettings(getter: () => AISettings) {
    setAICompleterConfig(getter);
  }

  openSearch() {
    this.monacoEditor.getAction("actions.find")?.run();
  }

  openReplace() {
    this.monacoEditor.getAction("editor.action.startFindReplaceAction")?.run();
  }

  hasOpenFile(): boolean {
    return this.tabs.length > 0;
  }

  async formatDocument() {
    const tab = this.tabs.find((t) => t.path === this.activeTab);
    if (!tab) return;

    const ext = tab.name.split(".").pop()?.toLowerCase() || "";
    const parser = PRETTIER_PARSER_MAP[ext];
    if (!parser) return;

    const model = this.monacoEditor.getModel();
    if (!model) return;
    const code = model.getValue();
    const cursor = this.monacoEditor.getPosition();

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
        model.pushEditOperations(
          [],
          [{ range: model.getFullModelRange(), text: formatted }],
          () => null
        );
        if (cursor) {
          this.monacoEditor.setPosition(cursor);
          this.monacoEditor.revealPositionInCenter(cursor);
        }
      }
    } catch (e) {
      console.error("Format failed:", e);
    }
  }

  setContent(content: string) {
    if (!this.activeTab) return;
    const model = this.monacoEditor.getModel();
    if (!model) return;
    const cursor = this.monacoEditor.getPosition();
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: content }],
      () => null
    );
    if (cursor) {
      this.monacoEditor.setPosition(cursor);
      this.monacoEditor.revealPositionInCenter(cursor);
    }
  }

  resize() {
    this.monacoEditor.layout();
  }

  setOnAskAI(handler: (prompt: string, code: string) => void) {
    this.onAskAI = handler;
  }

  setOnSave(handler: (path: string, content: string) => void) {
    this.onSaveCallback = handler;
  }

  private getSelectedText(): string {
    const sel = this.monacoEditor.getSelection();
    if (!sel) return "";
    return this.monacoEditor.getModel()?.getValueInRange(sel) ?? "";
  }

  private showEditorContextMenu(e: MouseEvent) {
    const selection = this.getSelectedText();
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
            const text = this.getSelectedText();
            if (text) {
              navigator.clipboard.writeText(text).catch(() => { });
              const sel = this.monacoEditor.getSelection();
              if (sel) this.monacoEditor.executeEdits("cut", [{ range: sel, text: "" }]);
            }
          },
        } as MenuItem,
        {
          label: "Copy", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`,
          shortcut: "⌘C",
          action: () => {
            const text = this.getSelectedText();
            if (text) navigator.clipboard.writeText(text).catch(() => { });
          },
        } as MenuItem,
        { separator: true } as MenuItem,
      ] : []),
      {
        label: "Paste", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1.5A1.5 1.5 0 0 1 6.5 0h3A1.5 1.5 0 0 1 11 1.5v1A1.5 1.5 0 0 1 9.5 4h-3A1.5 1.5 0 0 1 5 2.5v-1zm1.5-.5a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-3z"/><path d="M3 2.5a.5.5 0 0 1 .5-.5H5v1H3.5a.5.5 0 0 1-.5-.5V2.5zm8 0v.5H9.5V2h1a.5.5 0 0 1 .5.5zM3 4v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4H3z"/></svg>`,
        shortcut: "⌘V",
        action: () => {
          navigator.clipboard.readText().then((text) => {
            this.monacoEditor.focus();
            const sel = this.monacoEditor.getSelection();
            if (sel) this.monacoEditor.executeEdits("paste", [{ range: sel, text }]);
          }).catch(() => { });
        },
      },
      { separator: true },
      {
        label: "Select All", icon: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1h13a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5zm-1.5.5v13A1.5 1.5 0 0 0 1.5 16h13a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 14.5 0h-13A1.5 1.5 0 0 0 0 1.5z"/></svg>`,
        shortcut: "⌘A",
        action: () => this.monacoEditor.getAction("editor.action.selectAll")?.run(),
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
            const code = selection || (this.monacoEditor.getModel()?.getValue() ?? "");
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
          const rightSpace = window.innerWidth - rect.right;
          sub.style.left = rightSpace >= subRect.width ? `${rect.width}px` : `-${subRect.width}px`;
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
