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
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
  }
  fire(data) { this._listeners.forEach(l => { try { l(data); } catch {} }); }
  dispose() { this._listeners = []; }
}

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

// ── Registered tree data providers ───────────────────────────────────────────
// viewId → { provider, onDidChangeTreeDataSub }
const treeProviders = new Map();

// ── workspace ────────────────────────────────────────────────────────────────

let _workspaceFolders = [];
let _configuration = {};

const workspaceFoldersEmitter = new EventEmitter();

const workspace = {
  get workspaceFolders() { return _workspaceFolders; },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,

  getConfiguration(section) {
    const sectionData = section ? (_configuration[section] || {}) : _configuration;
    return {
      get(key, defaultValue) {
        const val = sectionData[key];
        return val !== undefined ? val : defaultValue;
      },
      has(key) { return key in sectionData; },
      inspect(key) { return { key, defaultValue: undefined, globalValue: sectionData[key] }; },
      update(key, value) { sectionData[key] = value; return Promise.resolve(); },
    };
  },

  onDidChangeConfiguration(listener) {
    // fire once so extensions initialize; real config-change events not yet supported
    return { dispose: () => {} };
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
    return { onDidCreate: e.event, onDidChange: e.event, onDidDelete: e.event, dispose: () => {} };
  },

  registerTextDocumentContentProvider(scheme, provider) {
    return new Disposable(() => {});
  },

  fs: {
    readFile: (uri) => Promise.resolve(require("fs").readFileSync(uri.fsPath)),
    writeFile: (uri, content) => { require("fs").writeFileSync(uri.fsPath, content); return Promise.resolve(); },
    readDirectory: (uri) => {
      try {
        return Promise.resolve(require("fs").readdirSync(uri.fsPath, { withFileTypes: true })
          .map(e => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]));
      } catch { return Promise.resolve([]); }
    },
    stat: (uri) => {
      try {
        const s = require("fs").statSync(uri.fsPath);
        return Promise.resolve({ type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs });
      } catch { return Promise.reject(); }
    },
    createDirectory: (uri) => { require("fs").mkdirSync(uri.fsPath, { recursive: true }); return Promise.resolve(); },
    delete: (uri) => { try { require("fs").unlinkSync(uri.fsPath); } catch {} return Promise.resolve(); },
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
    return { name, append() {}, appendLine() {}, clear() {}, show() {}, hide() {}, dispose() {} };
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

  createTextEditorDecorationType() { return { dispose() {} }; },
  withProgress(options, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event }); },
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: new EventEmitter().event,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  registerWebviewViewProvider: () => new Disposable(() => {}),
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
  registerDefinitionProvider: () => new Disposable(() => {}),
  registerCodeActionsProvider: () => new Disposable(() => {}),
  registerDocumentFormattingEditProvider: () => new Disposable(() => {}),
  match: () => 0,
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

module.exports = {
  // value types
  Uri, Range, Position, ThemeIcon, ThemeColor, TreeItem,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn,
  DiagnosticSeverity, ConfigurationTarget, ExtensionMode, FileType,
  EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace, window, commands, languages, env, l10n, extensions,
  // internal
  _handleMessage: handleMessage,
};
