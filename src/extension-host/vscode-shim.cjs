"use strict";

// Minimal vscode API shim for running extensions in Athva's Node.js extension host.
// Only implements the surface needed by tree-view extensions (Todo Tree, etc.).
// All calls that require VS Code's UI are bridged back to the renderer via IPC (send/recv on stdout/stdin).

const { send } = require("./ipc.cjs");
const fs = require("fs");
const path = require("path");
const DISPOSE_SYMBOL = Symbol.dispose || Symbol.for("Symbol.dispose");
const ASYNC_DISPOSE_SYMBOL = Symbol.asyncDispose || Symbol.for("Symbol.asyncDispose");

function ensureDisposable(target) {
  if (!target || typeof target.dispose !== "function") return target;
  if (!target[DISPOSE_SYMBOL]) target[DISPOSE_SYMBOL] = target.dispose.bind(target);
  if (!target[ASYNC_DISPOSE_SYMBOL]) target[ASYNC_DISPOSE_SYMBOL] = async () => target.dispose();
  return target;
}

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
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return ensureDisposable({
        dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); },
      });
    };
  }
  fire(data) { this._listeners.forEach(l => { try { l(data); } catch {} }); }
  dispose() { this._listeners = []; }
}

class Disposable {
  constructor(callOnDispose) { this._fn = callOnDispose; }
  dispose() { if (this._fn) { this._fn(); this._fn = null; } }
  [DISPOSE_SYMBOL]() { this.dispose(); }
  async [ASYNC_DISPOSE_SYMBOL]() { this.dispose(); }
  static from(...disposables) {
    return new Disposable(() => disposables.forEach(d => { try { d.dispose(); } catch {} }));
  }
}

class MarkdownString {
  constructor(value, isTrusted) { this.value = value || ""; this.isTrusted = isTrusted || false; }
  appendMarkdown(v) { this.value += v; return this; }
  appendText(v) { this.value += v.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&"); return this; }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event };
  }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() { this.cancel(); }
}

class SnippetString {
  constructor(value = "") { this.value = String(value); }
  appendText(text) { this.value += String(text ?? ""); return this; }
  appendPlaceholder(value) { this.value += String(value ?? ""); return this; }
  appendChoice(values = []) { this.value += values.join(","); return this; }
  appendTabstop() { return this; }
  appendVariable(name, defaultValue = "") { this.value += String(defaultValue ?? name ?? ""); return this; }
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

class CodeLens {
  constructor(range, command) { this.range = range; this.command = command; }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
    this.tooltip = undefined;
    this.data = undefined;
  }
}

function makeTextEditor(document) {
  return {
    document,
    selection: undefined,
    selections: [],
    revealRange() {},
    setDecorations() {},
    edit() { return Promise.resolve(false); },
    insertSnippet() { return Promise.resolve(false); },
  };
}

// ── Notebook value shims ─────────────────────────────────────────────────────

const NOTEBOOK_ERROR_MIME = "application/vnd.code.notebook.error";

class NotebookCellOutputItem {
  static error(_err) {
    return { mime: NOTEBOOK_ERROR_MIME, data: "" };
  }
}

// ── Registered tree data providers ───────────────────────────────────────────
// viewId → { provider, onDidChangeTreeDataSub }
const treeProviders = new Map();
const webviewChannels = new Map();
const gitRepositoryEmitter = new EventEmitter();
const gitApi = {
  repositories: [],
  onDidOpenRepository: gitRepositoryEmitter.event,
  onDidCloseRepository: new EventEmitter().event,
  getRepository: () => undefined,
};

function makeWebviewBridge(viewId) {
  let _html = "";
  const inbound = new EventEmitter();
  webviewChannels.set(viewId, inbound);
  const webview = {
    get html() { return _html; },
    set html(value) {
      _html = inlineFileAssetUris(String(value ?? ""));
      send({ type: "webviewHtml", viewId, html: _html });
    },
    options: {},
    cspSource: "",
    onDidReceiveMessage: inbound.event,
    postMessage: (message) => {
      send({ type: "webviewPostMessage", viewId, message });
      return Promise.resolve(true);
    },
    asWebviewUri: (uri) => {
      const fsPath = uri && typeof uri === "object" ? (uri.fsPath || uri.path || "") : String(uri || "");
      if (!fsPath) return uri;
      const data = encodeDataUri(fsPath);
      if (!data) return uri;
      const dataUriObj = {
        scheme: "data",
        authority: "",
        path: data,
        query: "",
        fragment: "",
        fsPath: data,
        toString: () => data,
        with: () => dataUriObj,
      };
      return dataUriObj;
    },
  };
  return { webview, dispose: () => webviewChannels.delete(viewId) };
}

function guessMime(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".html":
    case ".htm":
      return "text/html";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

function encodeDataUri(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    const mime = guessMime(filePath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

function decodeFileUriToPath(uri) {
  try {
    if (!uri || typeof uri !== "string") return "";
    if (!uri.startsWith("file://")) return "";
    const raw = uri.replace(/^file:\/\//i, "");
    const normalized = process.platform === "win32"
      ? raw.replace(/^\//, "")
      : raw;
    return decodeURIComponent(normalized);
  } catch {
    return "";
  }
}

function inlineFileAssetUris(html) {
  const source = String(html ?? "");
  const replaceAttr = (input, attrName) => {
    const re = new RegExp(`${attrName}\\s*=\\s*["'](file:\\/\\/[^"']+)["']`, "gi");
    return input.replace(re, (full, uri) => {
      const fsPath = decodeFileUriToPath(uri);
      if (!fsPath) return full;
      const data = encodeDataUri(fsPath);
      if (!data) return full;
      return `${attrName}="${data}"`;
    });
  };
  let out = source;
  out = replaceAttr(out, "src");
  out = replaceAttr(out, "href");
  // Also rewrite file:// URLs that appear inside inline scripts/CSS/JSON strings
  // (common in VS Code webviews that build link/script tags dynamically).
  out = out.replace(/file:\/\/\/[^\s"'<>`\\)]+/gi, (uri) => {
    const fsPath = decodeFileUriToPath(uri);
    if (!fsPath) return uri;
    const data = encodeDataUri(fsPath);
    return data || uri;
  });
  // Rewrites escaped file URLs inside JS strings (e.g. "file:\\/\\/\\/...").
  out = out.replace(/file:\\\/\\\/\\\/[^"'`\s<>)]+/gi, (escapedUri) => {
    const asNormal = escapedUri.replace(/\\\//g, "/");
    const fsPath = decodeFileUriToPath(asNormal);
    if (!fsPath) return escapedUri;
    const data = encodeDataUri(fsPath);
    if (!data) return escapedUri;
    // Keep slash-escaped form so surrounding JS string syntax remains valid.
    return data.replace(/\//g, "\\/");
  });
  return out;
}

// ── workspace ────────────────────────────────────────────────────────────────

let _workspaceFolders = [];
let _configuration = {};
// Schema-defined defaults keyed as "section.key" (e.g. "todo-tree.general.tagGroups")
let _schemaDefaults = {};
// scheme -> FileSystemProvider
const _fsProviders = new Map();

const workspaceFoldersEmitter = new EventEmitter();
const onDidSaveTextDocumentEmitter = new EventEmitter();
const onDidOpenTextDocumentEmitter = new EventEmitter();
const onDidCloseTextDocumentEmitter = new EventEmitter();
const onDidChangeTextDocumentEmitter = new EventEmitter();

function _getConfigValue(section, key) {
  // Check explicit config first, then schema defaults
  const sectionData = section ? (_configuration[section] || {}) : _configuration;
  if (key in sectionData) return sectionData[key];
  // Try flattened schema default: "section.key"
  const flatKey = section ? `${section}.${key}` : key;
  if (flatKey in _schemaDefaults) return _schemaDefaults[flatKey];
  return undefined;
}

const workspace = {
  get workspaceFolders() { return _workspaceFolders; },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
  onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
  onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
  onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
  onDidChangeTextDocument: onDidChangeTextDocumentEmitter.event,

  getConfiguration(section) {
    const sectionData = section ? (_configuration[section] || {}) : _configuration;
    const api = {
      get(key, defaultValue) {
        const val = _getConfigValue(section, key);
        return val !== undefined ? val : defaultValue;
      },
      has(key) {
        const flatKey = section ? `${section}.${key}` : key;
        return key in sectionData || flatKey in _schemaDefaults;
      },
      inspect(key) {
        const flatKey = section ? `${section}.${key}` : key;
        return {
          key: flatKey,
          defaultValue: _schemaDefaults[flatKey],
          globalValue: sectionData[key],
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        };
      },
      update(key, value) { sectionData[key] = value; return Promise.resolve(); },
    };
    // Proxy so extensions can access config values as direct properties (e.g. config.tagGroups)
    return new Proxy(api, {
      get(target, prop) {
        if (prop in target) return target[prop];
        // Direct property access: look up the value the same way .get() does
        const val = _getConfigValue(section, prop);
        // Return an empty object for missing keys to avoid common crashes like
        // Object.keys(config.someObject) when defaults are not available.
        return val !== undefined ? val : {};
      },
    });
  },

  onDidChangeConfiguration(listener) {
    // fire once so extensions initialize; real config-change events not yet supported
    return ensureDisposable({ dispose: () => {} });
  },

  findFiles(include, exclude, maxResults) {
    // Bridge to renderer for actual file search
    return Promise.resolve([]);
  },

  openTextDocument(pathOrUri) {
    const fspath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri?.fsPath ?? "";
    try {
      const content = require("fs").readFileSync(fspath, "utf8");
      return Promise.resolve({
        uri: Uri.file(fspath),
        getText: () => content,
        lineCount: content.split("\n").length,
        languageId: "plaintext",
        fileName: fspath,
      });
    } catch {
      return Promise.reject(new Error(`Cannot open ${fspath}`));
    }
  },

  createFileSystemWatcher(pattern) {
    const e = new EventEmitter();
    return ensureDisposable({ onDidCreate: e.event, onDidChange: e.event, onDidDelete: e.event, dispose: () => {} });
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

    return ensureDisposable({
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
    });
  },

  createStatusBarItem(alignmentOrId, priority) {
    return ensureDisposable({
      text: "", tooltip: "", command: undefined, color: undefined, backgroundColor: undefined,
      alignment: StatusBarAlignment.Left, priority: 0,
      show() {}, hide() {}, dispose() {},
    });
  },

  showInformationMessage(msg) { send({ type: "notification", level: "info", message: msg }); return Promise.resolve(undefined); },
  showWarningMessage(msg) { send({ type: "notification", level: "warning", message: msg }); return Promise.resolve(undefined); },
  showErrorMessage(msg) { send({ type: "notification", level: "error", message: msg }); return Promise.resolve(undefined); },

  createOutputChannel(name) {
    const lines = [];
    function append(text) { lines.push(String(text ?? "")); }
    function appendLine(text) { lines.push(String(text ?? "") + "\n"); }
    function log(level, text) { appendLine(`[${level}] ${String(text ?? "")}`); }
    return ensureDisposable({
      name,
      append,
      appendLine,
      clear() { lines.length = 0; },
      show() {},
      hide() {},
      dispose() { lines.length = 0; },
      // LogOutputChannel-style helpers (used by some extensions)
      debug(text) { log("debug", text); },
      info(text) { log("info", text); },
      warn(text) { log("warn", text); },
      error(text) { log("error", text); },
    });
  },

  createWebviewPanel(viewType, title, column, options) {
    const bridge = makeWebviewBridge(String(viewType || "panel"));
    return ensureDisposable({
      webview: bridge.webview,
      title, viewType, active: false, visible: false,
      onDidChangeViewState: new EventEmitter().event,
      onDidDispose: new EventEmitter().event,
      reveal() {}, dispose() { bridge.dispose(); },
    });
  },

  registerWebviewPanelSerializer(_viewType, _serializer) {
    return new Disposable(() => {});
  },

  registerUriHandler(_handler) {
    return new Disposable(() => {});
  },

  createTextEditorDecorationType() { return ensureDisposable({ dispose() {} }); },
  withProgress(options, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event }); },
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  showTextDocument: async (documentOrUri, _columnOrOptions, _preserveFocus) => {
    let doc = documentOrUri;
    if (typeof documentOrUri === "string" || documentOrUri?.scheme || documentOrUri?.fsPath) {
      try { doc = await workspace.openTextDocument(documentOrUri); } catch {}
    }
    const editor = makeTextEditor(doc || { uri: Uri.file(""), fileName: "", languageId: "plaintext", getText: () => "" });
    window.activeTextEditor = editor;
    return editor;
  },
  activeTextEditor: makeTextEditor({ uri: Uri.file(""), fileName: "", languageId: "plaintext", getText: () => "" }),
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: new EventEmitter().event,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  registerWebviewViewProvider(viewId, provider, _options) {
    // Notify renderer that this webview view is registered so the panel can show
    send({ type: "viewRegistered", viewId, viewType: "webview" });
    // Give the provider a stub WebviewView so it can initialize
    const bridge = makeWebviewBridge(viewId);
    const webviewView = {
      viewType: viewId,
      webview: bridge.webview,
      title: undefined,
      description: undefined,
      badge: undefined,
      visible: true,
      onDidChangeVisibility: new EventEmitter().event,
      onDidDispose: new EventEmitter().event,
      show: () => {},
    };
    Promise.resolve().then(() => {
      try { provider.resolveWebviewView(webviewView, {}, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event }); } catch {}
    });
    return new Disposable(() => {
      bridge.dispose();
    });
  },
  registerCustomEditorProvider: () => new Disposable(() => {}),
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
    if (id === "git.api.getAPI") return Promise.resolve(gitApi);
    if (id === "git.repositories") return Promise.resolve([]);
    if (id === "git.state") return Promise.resolve({ repositories: [] });
    return Promise.resolve(undefined);
  },
  getCommands() { return Promise.resolve([...registeredCommands.keys()]); },
  registerTextEditorCommand(id, handler) { return commands.registerCommand(id, handler); },
};

// ── languages ─────────────────────────────────────────────────────────────────

const languages = {
  createDiagnosticCollection(name) {
    return { name, set() {}, delete() {}, clear() {}, dispose() {}, forEach() {}, get() { return []; }, has() { return false; } };
  },
  getDiagnostics() { return []; },
  registerHoverProvider: () => new Disposable(() => {}),
  registerCompletionItemProvider: () => new Disposable(() => {}),
  registerInlineCompletionItemProvider: () => new Disposable(() => {}),
  registerDefinitionProvider: () => new Disposable(() => {}),
  registerCodeActionsProvider: () => new Disposable(() => {}),
  registerCodeLensProvider: () => new Disposable(() => {}),
  registerReferenceProvider: () => new Disposable(() => {}),
  registerDocumentSymbolProvider: () => new Disposable(() => {}),
  registerRenameProvider: () => new Disposable(() => {}),
  registerSignatureHelpProvider: () => new Disposable(() => {}),
  registerInlayHintsProvider: () => new Disposable(() => {}),
  registerDocumentSemanticTokensProvider: () => new Disposable(() => {}),
  registerColorProvider: () => new Disposable(() => {}),
  registerDocumentFormattingEditProvider: () => new Disposable(() => {}),
  match: () => 0,
};

const authentication = {
  onDidChangeSessions: new EventEmitter().event,
  getSession: () => Promise.resolve(undefined),
  getAccounts: () => Promise.resolve([]),
  registerAuthenticationProvider: () => new Disposable(() => {}),
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

// Report a VS Code-like version so extensions can gate behavior.
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
  getExtension: (id) => {
    if (id === "vscode.git") {
      const exports = { getAPI: () => gitApi };
      return {
        id: "vscode.git",
        isActive: true,
        exports,
        activate: () => Promise.resolve(exports),
        packageJSON: { name: "git", publisher: "vscode", version: "1.0.0" },
      };
    }
    return undefined;
  },
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

  if (msg.type === "webviewMessage") {
    const channel = webviewChannels.get(msg.viewId);
    if (channel) {
      try { channel.fire(msg.message); } catch {}
    }
  }
}

module.exports = {
  // value types
  Uri, Range, Position, ThemeIcon, ThemeColor, TreeItem, NotebookCellOutputItem,
  CancellationTokenSource, SnippetString, CompletionItem, CompletionItemKind, TextEdit, WorkspaceEdit, CodeLens, DocumentLink,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn,
  DiagnosticSeverity, ConfigurationTarget, ExtensionMode, FileType,
  EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace, window, commands, languages, authentication, env, l10n, extensions,
  version,
  // internal
  _handleMessage: handleMessage,
  _initDefaults(defaults) { _schemaDefaults = defaults || {}; },
};
