"use strict";

// Minimal vscode API shim for running extensions in Athva's Node.js extension host.
// Only implements the surface needed by tree-view extensions (Todo Tree, etc.).
// All calls that require VS Code's UI are bridged back to the renderer via IPC (send/recv on stdout/stdin).

const { send } = require("./ipc");

// ── Core value types ──────────────────────────────────────────────────────────

class Uri {
  constructor(scheme, authority, path, query, fragment) {
    this.scheme = scheme || "file";
    this.authority = authority || "";
    this.path = path || "";
    this.query = query || "";
    this.fragment = fragment || "";
    this.fsPath = this.path;
  }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  static file(path) { const u = new Uri("file", "", path); u.fsPath = path; return u; }
  static parse(str) {
    try {
      const url = new URL(str);
      const u = new Uri(url.protocol.replace(":",""), url.hostname, url.pathname);
      u.fsPath = url.pathname;
      return u;
    } catch { return Uri.file(str); }
  }
  static joinPath(base, ...segments) {
    const path = require("path");
    return Uri.file(path.join(base.fsPath || base.path, ...segments));
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}

class Selection extends Range {
  constructor(anchorLineOrPosition, anchorCharacterOrPosition, activeLine, activeCharacter) {
    const anchor = anchorLineOrPosition instanceof Position
      ? anchorLineOrPosition
      : new Position(anchorLineOrPosition, anchorCharacterOrPosition);
    const active = anchorCharacterOrPosition instanceof Position
      ? anchorCharacterOrPosition
      : new Position(activeLine, activeCharacter);
    super(anchor.line, anchor.character, active.line, active.character);
    this.anchor = anchor;
    this.active = active;
  }
}

class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
  static File = new ThemeIcon("file");
  static Folder = new ThemeIcon("folder");
}

class ThemeColor {
  constructor(id) { this.id = id; }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = typeof label === "string" ? label : label?.label ?? "";
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { One: 1, Two: 2, Three: 3, Active: -1, Beside: -2 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Info: 2, Hint: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const InlineCompletionEndOfLifeReasonKind = { Accepted: 1, Rejected: 2, Ignored: 3 };
const InlineCompletionsDisposeReasonKind = { Unknown: 0, Automatic: 1, ExplicitCancel: 2 };
const InlineCompletionDisplayLocationKind = { Label: 1, Code: 2 };

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
  }
  fire(data) { this._listeners.forEach(l => { try { l(data); } catch {} }); }
  dispose() { this._listeners = []; }
}
const Event = { None: () => new Disposable(() => {}) };

class Disposable {
  constructor(callOnDispose) { this._fn = callOnDispose; }
  dispose() { if (this._fn) { this._fn(); this._fn = null; } }
  static from(...disposables) {
    return new Disposable(() => disposables.forEach(d => { try { d.dispose(); } catch {} }));
  }
}

class MarkdownString {
  constructor(value, isTrusted) { this.value = value || ""; this.isTrusted = isTrusted || false; }
  appendMarkdown(v) { this.value += v; return this; }
  appendText(v) { this.value += v.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"); return this; }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7,
  Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15,
  File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22,
  Operator: 23, TypeParameter: 24,
};

class TextEdit {
  static replace(range, newText) { return { range, newText }; }
  static insert(position, newText) { return { range: new Range(position.line, position.character, position.line, position.character), newText }; }
  static delete(range) { return { range, newText: "" }; }
}

class WorkspaceEdit {
  constructor() { this._edits = []; }
  set(uri, edits) { this._edits.push({ uri, edits }); }
  insert(uri, position, newText) { this._edits.push({ uri, edits: [TextEdit.insert(position, newText)] }); }
  replace(uri, range, newText) { this._edits.push({ uri, edits: [TextEdit.replace(range, newText)] }); }
  delete(uri, range) { this._edits.push({ uri, edits: [TextEdit.delete(range)] }); }
}

class CodeAction {
  constructor(title, kind) {
    this.title = String(title ?? "");
    this.kind = kind;
    this.edit = undefined;
    this.command = undefined;
    this.diagnostics = undefined;
    this.isPreferred = undefined;
  }
}

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = String(message ?? "");
    this.severity = severity;
    this.source = undefined;
    this.code = undefined;
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event };
  }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}
const CancellationToken = { None: { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event } };

class TextDocument {
  constructor(uri, content = "", languageId = "plaintext", version = 1) {
    this.uri = uri;
    this.fileName = uri?.fsPath || uri?.path || "";
    this.languageId = languageId;
    this.version = version;
    this.isDirty = false;
    this.isClosed = false;
    this.eol = 1;
    this.lineCount = String(content).split("\n").length;
    this._content = String(content);
  }
  getText() { return this._content; }
}

class TextEditor {
  constructor(document) {
    this.document = document;
    this.selection = new Selection(0, 0, 0, 0);
    this.selections = [];
    this.options = {};
    this.viewColumn = ViewColumn.One;
  }
  revealRange() {}
  setDecorations() {}
  edit(callback) {
    const edits = [];
    const builder = {
      replace(range, value) { edits.push(TextEdit.replace(range, value)); },
      insert(position, value) { edits.push(TextEdit.insert(position, value)); },
      delete(range) { edits.push(TextEdit.delete(range)); },
    };
    try { if (typeof callback === "function") callback(builder); } catch {}
    return Promise.resolve(edits.length > 0);
  }
  insertSnippet() { return Promise.resolve(false); }
}

// ── Notebook value shims ─────────────────────────────────────────────────────

// Minimal subset used by notebook-oriented extensions to construct error outputs.
// VS Code uses this MIME for notebook error outputs.
const NOTEBOOK_ERROR_MIME = "application/vnd.code.notebook.error";

class NotebookCellOutputItem {
  static text(value, mime = "text/plain") {
    return { mime, data: String(value ?? "") };
  }
  static json(value, mime = "application/json") {
    return { mime, data: JSON.stringify(value ?? null) };
  }
  static stdout(value) {
    return { mime: "application/vnd.code.notebook.stdout", data: String(value ?? "") };
  }
  static stderr(value) {
    return { mime: "application/vnd.code.notebook.stderr", data: String(value ?? "") };
  }
  static error(_err) {
    return { mime: NOTEBOOK_ERROR_MIME, data: "" };
  }
}

class NotebookCellOutput {
  constructor(items = [], metadata = {}) {
    this.items = items;
    this.metadata = metadata;
  }
}

class NotebookCellData {
  constructor(kind, value, languageId) {
    this.kind = kind;
    this.value = value ?? "";
    this.languageId = languageId ?? "plaintext";
    this.outputs = [];
    this.metadata = {};
  }
}

class NotebookData {
  constructor(cells = []) {
    this.cells = cells;
    this.metadata = {};
  }
}

class NotebookRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const NotebookCellKind = { Markup: 1, Code: 2 };

// ── Registered tree data providers ───────────────────────────────────────────
// viewId → { provider, onDidChangeTreeDataSub }
const treeProviders = new Map();
const notebookDocuments = [];
const notebookSerializers = new Map();
const notebookOpenEmitter = new EventEmitter();
const notebookCloseEmitter = new EventEmitter();
const notebookChangeEmitter = new EventEmitter();

// ── workspace ────────────────────────────────────────────────────────────────

let _workspaceFolders = [];
let _configuration = {};
const _fsProviders = new Map();
const textDocuments = [];

const workspaceFoldersEmitter = new EventEmitter();

const workspace = {
  get workspaceFolders() { return _workspaceFolders; },
  get textDocuments() { return textDocuments; },
  get notebookDocuments() { return notebookDocuments; },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,

  getConfiguration(section) {
    // Ensure section objects exist so direct property access doesn't crash on undefined.
    if (section && !_configuration[section]) _configuration[section] = {};
    const sectionData = section ? _configuration[section] : _configuration;

    const config = {
      get(key, defaultValue) {
        const val = sectionData[key];
        return val !== undefined ? val : defaultValue;
      },
      has(key) { return key in sectionData; },
      inspect(key) { return { key, defaultValue: undefined, globalValue: sectionData[key] }; },
      update(key, value) { sectionData[key] = value; return Promise.resolve(); },
    };

    // VS Code extensions sometimes (incorrectly) read config values via property access
    // (e.g. getConfiguration('x').someKey). Provide a Proxy to match that behavior.
    return new Proxy(config, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "string") {
          const val = sectionData[prop];
          if (val !== undefined) return val;
          // Common pattern: Object.keys(config.someObject). Default to empty object.
          return {};
        }
        return undefined;
      },
      has(_target, prop) {
        if (prop in config) return true;
        return typeof prop === "string" ? prop in sectionData : false;
      },
    });
  },

  onDidChangeConfiguration(listener) {
    // fire once so extensions initialize; real config-change events not yet supported
    return { dispose: () => {} };
  },
  asRelativePath(pathOrUri, includeWorkspaceFolder) {
    const inputPath = typeof pathOrUri === "string"
      ? pathOrUri
      : (pathOrUri?.fsPath || pathOrUri?.path || String(pathOrUri || ""));
    if (!inputPath) return "";
    for (const folder of _workspaceFolders) {
      const root = folder?.uri?.fsPath;
      if (!root) continue;
      const rel = path.relative(root, inputPath).replace(/\\/g, "/");
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return includeWorkspaceFolder ? `${folder.name}/${rel || path.basename(inputPath)}` : (rel || path.basename(inputPath));
      }
    }
    return (path.basename(inputPath) || inputPath).replace(/\\/g, "/");
  },

  findFiles(include, exclude, maxResults) {
    // Bridge to renderer for actual file search
    return Promise.resolve([]);
  },

  openTextDocument(pathOrUri) {
    const fspath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri?.fsPath ?? "";
    try {
      const content = require("fs").readFileSync(fspath, "utf8");
      const doc = new TextDocument(Uri.file(fspath), content);
      textDocuments.push(doc);
      return Promise.resolve(doc);
    } catch {
      return Promise.reject(new Error(`Cannot open ${fspath}`));
    }
  },
  openNotebookDocument(viewTypeOrUri, maybeUri) {
    const viewType = typeof viewTypeOrUri === "string" && maybeUri ? viewTypeOrUri : "jupyter-notebook";
    const uriInput = maybeUri || viewTypeOrUri;
    const uri = typeof uriInput === "string" ? Uri.parse(uriInput) : (uriInput || Uri.file(""));
    const doc = {
      uri,
      notebookType: viewType,
      version: 1,
      isDirty: false,
      isClosed: false,
      metadata: {},
      cellCount: 0,
      getCells: () => [],
      save: () => Promise.resolve(true),
    };
    notebookDocuments.push(doc);
    notebookOpenEmitter.fire(doc);
    return Promise.resolve(doc);
  },
  registerNotebookSerializer(viewType, serializer) {
    notebookSerializers.set(String(viewType), serializer);
    return new Disposable(() => notebookSerializers.delete(String(viewType)));
  },
  applyEdit(edit) {
    const fs = require("fs");
    const all = Array.isArray(edit?._edits) ? edit._edits : [];
    for (const batch of all) {
      const uri = batch?.uri;
      if (!uri?.fsPath) continue;
      let content = "";
      try { content = fs.readFileSync(uri.fsPath, "utf8"); } catch { continue; }
      const updates = (batch.edits || [])
        .map((e) => {
          const start = _offsetAt(content, e.range?.start || new Position(0, 0));
          const end = _offsetAt(content, e.range?.end || new Position(0, 0));
          return { start, end, newText: String(e.newText ?? "") };
        })
        .sort((a, b) => b.start - a.start);
      for (const u of updates) {
        content = content.slice(0, u.start) + u.newText + content.slice(u.end);
      }
      try { fs.writeFileSync(uri.fsPath, content); } catch {}
    }
    return Promise.resolve(true);
  },

  createFileSystemWatcher(pattern) {
    const e = new EventEmitter();
    return { onDidCreate: e.event, onDidChange: e.event, onDidDelete: e.event, dispose: () => {} };
  },

  registerTextDocumentContentProvider(scheme, provider) {
    return new Disposable(() => {});
  },

  registerFileSystemProvider(scheme, provider, _options) {
    if (typeof scheme !== "string" || !scheme) return new Disposable(() => {});
    _fsProviders.set(scheme, provider);
    return new Disposable(() => _fsProviders.delete(scheme));
  },

  fs: {
    readFile: (uri) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.readFile === "function") return Promise.resolve(provider.readFile(uri));
        return Promise.reject(new Error(`No FileSystemProvider for scheme: ${uri.scheme}`));
      }
      return Promise.resolve(require("fs").readFileSync(uri.fsPath));
    },
    writeFile: (uri, content) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.writeFile === "function") return Promise.resolve(provider.writeFile(uri, content, { create: true, overwrite: true }));
        return Promise.reject(new Error(`No FileSystemProvider for scheme: ${uri.scheme}`));
      }
      require("fs").writeFileSync(uri.fsPath, content);
      return Promise.resolve();
    },
    readDirectory: (uri) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.readDirectory === "function") return Promise.resolve(provider.readDirectory(uri));
        return Promise.resolve([]);
      }
      try {
        return Promise.resolve(require("fs").readdirSync(uri.fsPath, { withFileTypes: true })
          .map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]));
      } catch { return Promise.resolve([]); }
    },
    stat: (uri) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.stat === "function") return Promise.resolve(provider.stat(uri));
        return Promise.reject(new Error(`No FileSystemProvider for scheme: ${uri.scheme}`));
      }
      try {
        const s = require("fs").statSync(uri.fsPath);
        return Promise.resolve({ type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs });
      } catch { return Promise.reject(); }
    },
    createDirectory: (uri) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.createDirectory === "function") return Promise.resolve(provider.createDirectory(uri));
        return Promise.resolve();
      }
      require("fs").mkdirSync(uri.fsPath, { recursive: true });
      return Promise.resolve();
    },
    delete: (uri) => {
      if (uri?.scheme && uri.scheme !== "file") {
        const provider = _fsProviders.get(uri.scheme);
        if (provider && typeof provider.delete === "function") return Promise.resolve(provider.delete(uri, { recursive: true, useTrash: false }));
        return Promise.resolve();
      }
      try { require("fs").unlinkSync(uri.fsPath); } catch {}
      return Promise.resolve();
    },
  },
};

// ── window ────────────────────────────────────────────────────────────────────

const window = {
  tabGroups: { all: [] },
  onDidChangeWindowState: new EventEmitter().event,
  onDidChangeTerminalShellIntegration: new EventEmitter().event,
  createTreeView(viewId, options) {
    const provider = options.treeDataProvider;
    treeProviders.set(viewId, { provider });

    // When the tree data changes, notify the renderer
    if (provider.onDidChangeTreeData) {
      provider.onDidChangeTreeData(() => {
        send({ type: "treeChanged", viewId });
      });
    }

    // Notify renderer that this view is now available
    send({ type: "viewRegistered", viewId });

    return {
      viewId,
      visible: true,
      message: undefined,
      title: undefined,
      description: undefined,
      badge: undefined,
      onDidChangeSelection: new EventEmitter().event,
      onDidChangeVisibility: new EventEmitter().event,
      onDidChangeCheckboxState: new EventEmitter().event,
      onDidCollapseElement: new EventEmitter().event,
      onDidExpandElement: new EventEmitter().event,
      reveal: () => Promise.resolve(),
      dispose: () => { treeProviders.delete(viewId); },
    };
  },

  createStatusBarItem(alignmentOrId, priority) {
    return {
      text: "", tooltip: "", command: undefined, color: undefined, backgroundColor: undefined,
      alignment: StatusBarAlignment.Left, priority: 0,
      show() {}, hide() {}, dispose() {},
    };
  },

  showInformationMessage(msg) { send({ type: "notification", level: "info", message: msg }); return Promise.resolve(undefined); },
  showWarningMessage(msg) { send({ type: "notification", level: "warning", message: msg }); return Promise.resolve(undefined); },
  showErrorMessage(msg) { send({ type: "notification", level: "error", message: msg }); return Promise.resolve(undefined); },

  createOutputChannel(name) {
    const lines = [];
    function append(text) { lines.push(String(text ?? "")); }
    function appendLine(text) { lines.push(String(text ?? "") + "\n"); }
    function log(level, text) { appendLine(`[${level}] ${String(text ?? "")}`); }
    return {
      name,
      append,
      appendLine,
      clear() { lines.length = 0; },
      show() {},
      hide() {},
      dispose() { lines.length = 0; },
      trace(text) { log("trace", text); },
      debug(text) { log("debug", text); },
      info(text) { log("info", text); },
      warn(text) { log("warn", text); },
      error(text) { log("error", text); },
    };
  },

  createWebviewPanel(viewType, title, column, options) {
    return {
      webview: { html: "", onDidReceiveMessage: new EventEmitter().event, postMessage: () => {}, options: {} },
      title, viewType, active: false, visible: false,
      onDidChangeViewState: new EventEmitter().event,
      onDidDispose: new EventEmitter().event,
      reveal() {}, dispose() {},
    };
  },

  registerWebviewPanelSerializer(_viewType, _serializer) {
    return new Disposable(() => {});
  },

  registerUriHandler(_handler) {
    return new Disposable(() => {});
  },

  createTextEditorDecorationType() { return { dispose() {} }; },
  withProgress(options, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event }); },
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  activeTextEditor: new TextEditor(new TextDocument(Uri.file(""), "")),
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: new EventEmitter().event,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  activeNotebookEditor: undefined,
  visibleNotebookEditors: [],
  onDidChangeActiveNotebookEditor: new EventEmitter().event,
  showNotebookDocument: async (notebookOrUri) => {
    const document = notebookOrUri?.notebookType
      ? notebookOrUri
      : await workspace.openNotebookDocument(notebookOrUri);
    const editor = { notebook: document, selection: new NotebookRange(0, 0), selections: [], visibleRanges: [] };
    window.activeNotebookEditor = editor;
    window.visibleNotebookEditors = [editor];
    return editor;
  },
  registerWebviewViewProvider: () => new Disposable(() => {}),
  registerCustomEditorProvider: () => new Disposable(() => {}),
  createTerminal(optionsOrName) {
    const terminal = {
      name: typeof optionsOrName === "string" ? optionsOrName : (optionsOrName?.name || "Terminal"),
      shellIntegration: {},
      sendText() {},
      show() {},
      hide() {},
      dispose() {},
    };
    return terminal;
  },
};

// ── commands ──────────────────────────────────────────────────────────────────

const registeredCommands = new Map();

const commands = {
  registerCommand(id, handler, thisArg) {
    registeredCommands.set(id, thisArg ? handler.bind(thisArg) : handler);
    return new Disposable(() => registeredCommands.delete(id));
  },
  executeCommand(id, ...args) {
    const handler = registeredCommands.get(id);
    if (handler) return Promise.resolve(handler(...args));
    return Promise.resolve(undefined);
  },
  getCommands() { return Promise.resolve([...registeredCommands.keys()]); },
  registerTextEditorCommand(id, handler) { return commands.registerCommand(id, handler); },
};

// ── languages ─────────────────────────────────────────────────────────────────

const languages = {
  _diagnostics: new Map(),
  createDiagnosticCollection(name) {
    const key = String(name || "default");
    const store = new Map();
    languages._diagnostics.set(key, store);
    return {
      name: key,
      set(uri, diagnostics) { store.set(uri?.toString?.() || String(uri), diagnostics || []); },
      delete(uri) { store.delete(uri?.toString?.() || String(uri)); },
      clear() { store.clear(); },
      dispose() { store.clear(); languages._diagnostics.delete(key); },
      forEach(cb) { store.forEach((value, uri) => cb(Uri.parse(uri), value, this)); },
      get(uri) { return store.get(uri?.toString?.() || String(uri)) || []; },
      has(uri) { return store.has(uri?.toString?.() || String(uri)); },
    };
  },
  getDiagnostics(uri) {
    const rows = [];
    for (const store of languages._diagnostics.values()) {
      for (const [key, value] of store.entries()) {
        if (!uri || key === (uri?.toString?.() || String(uri))) rows.push([Uri.parse(key), value || []]);
      }
    }
    return uri ? (rows[0]?.[1] || []) : rows;
  },
  registerHoverProvider: () => new Disposable(() => {}),
  registerCompletionItemProvider: () => new Disposable(() => {}),
  registerDefinitionProvider: () => new Disposable(() => {}),
  registerCodeActionsProvider: () => new Disposable(() => {}),
  registerDocumentFormattingEditProvider: () => new Disposable(() => {}),
  getLanguages: () => Promise.resolve(["plaintext", "javascript", "typescript", "json", "markdown", "html", "css"]),
  match: () => 0,
};

const notebooks = {
  createNotebookController(id, notebookType, label, handler) {
    const execHandler = typeof handler === "function" ? handler : async () => {};
    return {
      id,
      notebookType,
      label,
      supportedLanguages: [],
      supportsExecutionOrder: false,
      executeHandler: execHandler,
      updateNotebookAffinity() {},
      createNotebookCellExecution() {
        return {
          token: CancellationToken.None,
          executionOrder: undefined,
          start() {},
          clearOutput() { return Promise.resolve(); },
          appendOutput() { return Promise.resolve(); },
          replaceOutput() { return Promise.resolve(); },
          end() {},
        };
      },
      dispose() {},
    };
  },
  registerNotebookCellStatusBarItemProvider() {
    return new Disposable(() => {});
  },
  get notebookDocuments() { return notebookDocuments; },
  onDidOpenNotebookDocument: notebookOpenEmitter.event,
  onDidCloseNotebookDocument: notebookCloseEmitter.event,
  onDidChangeNotebookDocument: notebookChangeEmitter.event,
};

// ── env ───────────────────────────────────────────────────────────────────────

const env = {
  appRoot: process.env.VSCODE_APP_ROOT || "",
  appName: "Athva",
  appHost: "desktop",
  language: "en",
  machineId: "athva-machine",
  sessionId: "athva-session",
  uriScheme: "athva",
  remoteName: undefined,
  shell: process.env.SHELL || "/bin/zsh",
  openExternal: (uri) => { send({ type: "openExternal", uri: uri.toString() }); return Promise.resolve(true); },
  clipboard: { readText: () => Promise.resolve(""), writeText: () => Promise.resolve() },
};

const version = "1.106.0";

// ── l10n ─────────────────────────────────────────────────────────────────────
function formatL10n(message, args) {
  if (typeof message !== "string") return "";
  return message.replace(/\{(\d+)\}/g, (_m, idx) => String(args[Number(idx)] ?? ""));
}

const l10n = {
  t(message, ...args) {
    return formatL10n(message, args);
  },
};

// ── extensions ────────────────────────────────────────────────────────────────

const extensions = {
  all: [],
  getExtension: () => undefined,
  onDidChange: new EventEmitter().event,
};

// ── IPC: handle incoming messages from renderer ───────────────────────────────

async function handleMessage(msg) {
  if (msg.type === "getChildren") {
    const { viewId, elementId } = msg;
    const entry = treeProviders.get(viewId);
    if (!entry) { send({ type: "children", viewId, elementId, items: [] }); return; }

    try {
      const element = elementId != null ? entry.elementCache?.get(elementId) : undefined;
      const children = await entry.provider.getChildren(element);
      if (!children) { send({ type: "children", viewId, elementId, items: [] }); return; }

      if (!entry.elementCache) entry.elementCache = new Map();
      const items = await Promise.all(children.map(async (child, i) => {
        const id = `${viewId}:${elementId ?? "root"}:${i}`;
        entry.elementCache.set(id, child);
        const treeItem = await entry.provider.getTreeItem(child);
        return {
          id,
          label: typeof treeItem.label === "string" ? treeItem.label : treeItem.label?.label ?? "",
          description: treeItem.description ?? "",
          tooltip: typeof treeItem.tooltip === "string" ? treeItem.tooltip : treeItem.tooltip?.value ?? "",
          iconId: treeItem.iconPath instanceof ThemeIcon ? treeItem.iconPath.id : undefined,
          resourceUri: treeItem.resourceUri?.fsPath,
          collapsibleState: treeItem.collapsibleState ?? 0,
          contextValue: treeItem.contextValue,
          command: treeItem.command ? { command: treeItem.command.command, title: treeItem.command.title } : undefined,
        };
      }));
      send({ type: "children", viewId, elementId, items });
    } catch (e) {
      send({ type: "children", viewId, elementId, items: [], error: e.message });
    }
  }

  if (msg.type === "setWorkspace") {
    _workspaceFolders = (msg.folders || []).map((f, i) => ({
      index: i, name: require("path").basename(f), uri: Uri.file(f),
    }));
    _configuration = msg.configuration || {};
    workspaceFoldersEmitter.fire({ added: _workspaceFolders, removed: [] });
  }

  if (msg.type === "executeCommand") {
    try {
      const result = await commands.executeCommand(msg.command, ...(msg.args || []));
      send({ type: "commandResult", id: msg.id, result });
    } catch (e) {
      send({ type: "commandResult", id: msg.id, error: e.message });
    }
  }
}

const _missingApiWarned = new Set();
const _missingApiProxyCache = new Map();

function warnMissingApi(path) {
  if (_missingApiWarned.has(path)) return;
  _missingApiWarned.add(path);
  try { console.warn(`[Missing API] Extension accessed: ${path}`); } catch {}
}

function createMissingApiProxy(path) {
  if (_missingApiProxyCache.has(path)) return _missingApiProxyCache.get(path);
  const fallback = function () { return undefined; };
  const proxy = new Proxy(fallback, {
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      if (prop === "then") return undefined;
      if (prop === "toString") return () => `[AthvaMissingVscodeApi:${path}]`;
      const nextPath = `${path}.${String(prop)}`;
      warnMissingApi(nextPath);
      return createMissingApiProxy(nextPath);
    },
    apply() {
      warnMissingApi(`${path}()`);
      return createMissingApiProxy(`${path}()`);
    },
    construct() {
      warnMissingApi(`new ${path}()`);
      return createMissingApiProxy(`new ${path}()`);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  _missingApiProxyCache.set(path, proxy);
  return proxy;
}

function withApiFallback(obj, rootPath) {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop === "symbol") return undefined;
      const path = `${rootPath}.${String(prop)}`;
      warnMissingApi(path);
      return createMissingApiProxy(path);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

const vscodeApi = {
  // value types
  Uri, Range, Position, Selection, ThemeIcon, ThemeColor, TreeItem, NotebookCellOutputItem, NotebookCellOutput, NotebookCellData, NotebookData, NotebookRange, NotebookCellKind,
  CancellationTokenSource, CancellationToken, CompletionItem, CompletionItemKind, TextEdit, WorkspaceEdit, CodeAction, Diagnostic,
  TextDocument, TextEditor,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn,
  InlineCompletionEndOfLifeReasonKind, InlineCompletionsDisposeReasonKind, InlineCompletionDisplayLocationKind,
  DiagnosticSeverity, ConfigurationTarget, ExtensionMode, FileType,
  Event, EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace: withApiFallback(workspace, "vscode.workspace"),
  window: withApiFallback(window, "vscode.window"),
  commands: withApiFallback(commands, "vscode.commands"),
  languages: withApiFallback(languages, "vscode.languages"),
  notebooks: withApiFallback(notebooks, "vscode.notebooks"),
  env: withApiFallback(env, "vscode.env"),
  l10n: withApiFallback(l10n, "vscode.l10n"),
  extensions: withApiFallback(extensions, "vscode.extensions"),
  version,
  // internal
  _handleMessage: handleMessage,
};

module.exports = new Proxy(vscodeApi, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
    if (typeof prop === "symbol") return undefined;
    const path = `vscode.${String(prop)}`;
    warnMissingApi(path);
    return createMissingApiProxy(path);
  },
  set(target, prop, value, receiver) {
    return Reflect.set(target, prop, value, receiver);
  },
});

function _offsetAt(content, position) {
  const lines = String(content).split("\n");
  const targetLine = Math.max(0, Math.min(lines.length - 1, position.line || 0));
  let offset = 0;
  for (let i = 0; i < targetLine; i += 1) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(lines[targetLine].length, position.character || 0));
}
