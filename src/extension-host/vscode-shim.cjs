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

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === "string" ? Uri.file(base) : base;
    this.pattern = String(pattern || "");
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
const LogLevel = { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Off: 6 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const CodeActionKind = {
  Empty: "",
  QuickFix: "quickfix",
  Refactor: "refactor",
  RefactorExtract: "refactor.extract",
  RefactorInline: "refactor.inline",
  RefactorRewrite: "refactor.rewrite",
  Source: "source",
  SourceFixAll: "source.fixAll",
  Notebook: "notebook",
};

function makeFsError(message, code) {
  const err = new Error(message);
  err.name = "FileSystemError";
  err.code = code;
  return err;
}
const FileSystemError = {
  FileNotFound: (uri) => makeFsError(`File not found: ${uri?.fsPath || uri || ""}`, "FileNotFound"),
  FileExists: (uri) => makeFsError(`File exists: ${uri?.fsPath || uri || ""}`, "FileExists"),
  FileNotADirectory: (uri) => makeFsError(`Not a directory: ${uri?.fsPath || uri || ""}`, "FileNotADirectory"),
  FileIsADirectory: (uri) => makeFsError(`Is a directory: ${uri?.fsPath || uri || ""}`, "FileIsADirectory"),
  NoPermissions: (uri) => makeFsError(`No permissions: ${uri?.fsPath || uri || ""}`, "NoPermissions"),
  Unavailable: (uri) => makeFsError(`Unavailable: ${uri?.fsPath || uri || ""}`, "Unavailable"),
};

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
const Event = { None: () => new Disposable(() => {}) };

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
    selection: new Selection(0, 0, 0, 0),
    selections: [],
    revealRange() {},
    setDecorations() {},
    edit(callback) {
      const edits = [];
      const builder = {
        replace(range, value) { edits.push(TextEdit.replace(range, value)); },
        insert(position, value) { edits.push(TextEdit.insert(position, value)); },
        delete(range) { edits.push(TextEdit.delete(range)); },
      };
      try { if (typeof callback === "function") callback(builder); } catch {}
      return Promise.resolve(edits.length > 0);
    },
    insertSnippet() { return Promise.resolve(false); },
  };
}

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
  getText(range) {
    if (!range) return this._content;
    const lines = this._content.split("\n");
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.max(startLine, range.end.line);
    const selected = lines.slice(startLine, endLine + 1);
    if (!selected.length) return "";
    selected[0] = selected[0].slice(range.start.character);
    selected[selected.length - 1] = selected[selected.length - 1].slice(0, range.end.character);
    return selected.join("\n");
  }
  lineAt(line) {
    const lines = this._content.split("\n");
    const text = lines[Math.max(0, line)] ?? "";
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line, text.length + 1),
      firstNonWhitespaceCharacterIndex: text.search(/\S|$/),
      isEmptyOrWhitespace: !/\S/.test(text),
    };
  }
  offsetAt(position) {
    const lines = this._content.split("\n");
    const prefix = lines.slice(0, Math.max(0, position.line)).join("\n");
    return prefix.length + (position.line > 0 ? 1 : 0) + Math.max(0, position.character);
  }
  positionAt(offset) {
    const text = this._content;
    const safeOffset = Math.max(0, Math.min(text.length, offset));
    const prefix = text.slice(0, safeOffset);
    const line = (prefix.match(/\n/g) || []).length;
    const lastBreak = prefix.lastIndexOf("\n");
    const character = lastBreak === -1 ? prefix.length : prefix.length - lastBreak - 1;
    return new Position(line, character);
  }
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
const webviewChannels = new Map();
const notebookSerializers = new Map();
const notebookDocuments = [];
const notebookControllers = new Map();
const notebookOpenEmitter = new EventEmitter();
const notebookCloseEmitter = new EventEmitter();
const notebookChangeEmitter = new EventEmitter();
const activeNotebookEditorEmitter = new EventEmitter();
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
const onDidOpenNotebookDocumentEmitter = new EventEmitter();
const onDidCloseNotebookDocumentEmitter = new EventEmitter();
const onDidChangeNotebookDocumentEmitter = new EventEmitter();
const onDidChangeConfigurationEmitter = new EventEmitter();

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
  onDidOpenNotebookDocument: onDidOpenNotebookDocumentEmitter.event,
  onDidCloseNotebookDocument: onDidCloseNotebookDocumentEmitter.event,
  onDidChangeNotebookDocument: onDidChangeNotebookDocumentEmitter.event,

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
    return onDidChangeConfigurationEmitter.event(listener);
  },

  findFiles(include, exclude, maxResults) {
    const includePattern = normalizeGlobPattern(include);
    const excludePattern = normalizeGlobPattern(exclude);
    const limit = Number.isFinite(Number(maxResults)) && Number(maxResults) > 0 ? Number(maxResults) : 10_000;
    const results = [];
    const seen = new Set();

    for (const folder of _workspaceFolders) {
      const root = folder?.uri?.fsPath;
      if (!root || !fs.existsSync(root)) continue;
      walkFiles(root, (filePath) => {
        if (results.length >= limit) return false;
        const rel = toPosix(path.relative(root, filePath));
        if (!globMatch(rel, includePattern)) return true;
        if (excludePattern && globMatch(rel, excludePattern)) return true;
        if (seen.has(filePath)) return true;
        seen.add(filePath);
        results.push(Uri.file(filePath));
        return true;
      });
      if (results.length >= limit) break;
    }
    return Promise.resolve(results);
  },

  openTextDocument(pathOrUri) {
    const fspath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri?.fsPath ?? "";
    try {
      const content = require("fs").readFileSync(fspath, "utf8");
      return Promise.resolve(new TextDocument(Uri.file(fspath), content));
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
    onDidOpenNotebookDocumentEmitter.fire(doc);
    notebookOpenEmitter.fire(doc);
    return Promise.resolve(doc);
  },
  registerNotebookSerializer(viewType, serializer, _options) {
    notebookSerializers.set(String(viewType), serializer);
    return new Disposable(() => notebookSerializers.delete(String(viewType)));
  },
  applyEdit(edit) {
    const all = Array.isArray(edit?._edits) ? edit._edits : [];
    for (const batch of all) {
      const uri = batch?.uri;
      if (!uri?.fsPath) continue;
      let content = "";
      try { content = fs.readFileSync(uri.fsPath, "utf8"); } catch { continue; }
      const updates = Array.isArray(batch.edits) ? batch.edits : [];
      const decorated = updates
        .map((e) => {
          const start = _offsetAt(content, e.range?.start || new Position(0, 0));
          const end = _offsetAt(content, e.range?.end || new Position(0, 0));
          return { start, end, newText: String(e.newText ?? "") };
        })
        .sort((a, b) => b.start - a.start);
      for (const u of decorated) {
        content = content.slice(0, u.start) + u.newText + content.slice(u.end);
      }
      try { fs.writeFileSync(uri.fsPath, content); } catch {}
    }
    return Promise.resolve(true);
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
  showQuickPick: (items, options) => {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return Promise.resolve(undefined);
    if (options?.canPickMany) return Promise.resolve([list[0]]);
    return Promise.resolve(list[0]);
  },
  showInputBox: (options = {}) => {
    const defaultValue = typeof options.value === "string"
      ? options.value
      : typeof options.prompt === "string" && options.prompt.trim()
        ? options.prompt
        : "";
    return Promise.resolve(defaultValue);
  },
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
  activeNotebookEditor: undefined,
  visibleNotebookEditors: [],
  onDidChangeActiveNotebookEditor: activeNotebookEditorEmitter.event,
  showNotebookDocument: async (notebookOrUri, _options) => {
    const document = notebookOrUri?.notebookType
      ? notebookOrUri
      : await workspace.openNotebookDocument(notebookOrUri);
    const editor = { notebook: document, selection: new NotebookRange(0, 0), selections: [], visibleRanges: [] };
    window.activeNotebookEditor = editor;
    window.visibleNotebookEditors = [editor];
    activeNotebookEditorEmitter.fire(editor);
    return editor;
  },
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
    const safeHandler = typeof handler === "function"
      ? (thisArg ? handler.bind(thisArg) : handler)
      : (() => undefined);
    registeredCommands.set(id, safeHandler);
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
  _diagnostics: new Map(),
  _completionProviders: new Set(),
  _codeActionProviders: new Set(),
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
  registerCompletionItemProvider(_selector, provider) {
    languages._completionProviders.add(provider);
    return new Disposable(() => languages._completionProviders.delete(provider));
  },
  registerInlineCompletionItemProvider: () => new Disposable(() => {}),
  registerDefinitionProvider: () => new Disposable(() => {}),
  registerCodeActionsProvider(_selector, provider) {
    languages._codeActionProviders.add(provider);
    return new Disposable(() => languages._codeActionProviders.delete(provider));
  },
  registerCodeLensProvider: () => new Disposable(() => {}),
  registerReferenceProvider: () => new Disposable(() => {}),
  registerDocumentSymbolProvider: () => new Disposable(() => {}),
  registerRenameProvider: () => new Disposable(() => {}),
  registerSignatureHelpProvider: () => new Disposable(() => {}),
  registerInlayHintsProvider: () => new Disposable(() => {}),
  registerDocumentSemanticTokensProvider: () => new Disposable(() => {}),
  registerColorProvider: () => new Disposable(() => {}),
  registerDocumentFormattingEditProvider: () => new Disposable(() => {}),
  getLanguages: () => Promise.resolve(["plaintext", "javascript", "typescript", "json", "markdown", "html", "css"]),
  match: () => 0,
};

const notebooks = {
  createNotebookController(id, notebookType, label, handler) {
    const execHandler = typeof handler === "function" ? handler : async () => {};
    const ctl = {
      id,
      notebookType,
      label,
      supportedLanguages: [],
      supportsExecutionOrder: false,
      executeHandler: execHandler,
      updateNotebookAffinity() {},
      createNotebookCellExecution(cell) {
        return {
          token: CancellationToken.None,
          executionOrder: undefined,
          start() {},
          clearOutput() { return Promise.resolve(); },
          appendOutput(_outputs) { return Promise.resolve(); },
          replaceOutput(_outputs) { return Promise.resolve(); },
          end(_success, _endTime) {},
        };
      },
      dispose() { notebookControllers.delete(String(id)); },
    };
    notebookControllers.set(String(id), ctl);
    return ensureDisposable(ctl);
  },
  registerNotebookCellStatusBarItemProvider() {
    return new Disposable(() => {});
  },
  get notebookDocuments() { return notebookDocuments; },
  onDidOpenNotebookDocument: notebookOpenEmitter.event,
  onDidCloseNotebookDocument: notebookCloseEmitter.event,
  onDidChangeNotebookDocument: notebookChangeEmitter.event,
};

const authentication = {
  onDidChangeSessions: new EventEmitter().event,
  getSession: () => Promise.resolve(undefined),
  getAccounts: () => Promise.resolve([]),
  registerAuthenticationProvider: () => new Disposable(() => {}),
};

const tasks = {
  fetchTasks: async () => [],
  executeTask: async () => undefined,
  registerTaskProvider: () => new Disposable(() => {}),
  onDidStartTask: new EventEmitter().event,
  onDidEndTask: new EventEmitter().event,
  onDidStartTaskProcess: new EventEmitter().event,
  onDidEndTaskProcess: new EventEmitter().event,
};

const debug = {
  startDebugging: async () => false,
  stopDebugging: async () => undefined,
  registerDebugConfigurationProvider: () => new Disposable(() => {}),
  registerDebugAdapterDescriptorFactory: () => new Disposable(() => {}),
  onDidStartDebugSession: new EventEmitter().event,
  onDidTerminateDebugSession: new EventEmitter().event,
};

const chat = {
  createChatParticipant: () => ensureDisposable({ dispose() {} }),
};

const lm = {
  registerLanguageModelChatProvider: () => new Disposable(() => {}),
  selectChatModels: async () => [],
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
    const prevConfig = JSON.stringify(_configuration || {});
    _workspaceFolders = (msg.folders || []).map((f, i) => ({
      index: i, name: require("path").basename(f), uri: Uri.file(f),
    }));
    _configuration = msg.configuration || {};
    workspaceFoldersEmitter.fire({ added: _workspaceFolders, removed: [] });
    const nextConfig = JSON.stringify(_configuration || {});
    if (prevConfig !== nextConfig) {
      onDidChangeConfigurationEmitter.fire({
        affectsConfiguration: (section) => {
          if (!section) return prevConfig !== nextConfig;
          const beforeSection = JSON.stringify((JSON.parse(prevConfig || "{}") || {})[section] ?? null);
          const afterSection = JSON.stringify((_configuration || {})[section] ?? null);
          return beforeSection !== afterSection;
        },
      });
    }
  }

  if (msg.type === "executeCommand") {
    try {
      const result = await commands.executeCommand(msg.command, ...(msg.args || []));
      send({ type: "commandResult", id: msg.id, result });
    } catch (e) {
      send({ type: "commandResult", id: msg.id, error: e.message });
    }
  }

  if (msg.type === "provideCompletions") {
    try {
      const filePath = String(msg.filePath || "");
      const content = typeof msg.content === "string" ? msg.content : "";
      const lineNumber = Number(msg.lineNumber || 1);
      const column = Number(msg.column || 1);
      const languageId = String(msg.languageId || "plaintext");
      const uri = Uri.file(filePath || "");
      const doc = new TextDocument(uri, content, languageId, 1);
      const position = new Position(Math.max(0, lineNumber - 1), Math.max(0, column - 1));
      const token = CancellationToken.None;

      const merged = [];
      for (const provider of languages._completionProviders) {
        if (!provider || typeof provider.provideCompletionItems !== "function") continue;
        let provided;
        try {
          provided = await provider.provideCompletionItems(doc, position, token, { triggerKind: 0 });
        } catch {
          continue;
        }
        const items = Array.isArray(provided)
          ? provided
          : Array.isArray(provided?.items)
            ? provided.items
            : [];
        for (const item of items) {
          if (!item) continue;
          const label = typeof item.label === "string"
            ? item.label
            : (item.label?.label || "");
          if (!label) continue;
          merged.push({
            label,
            insertText: typeof item.insertText === "string" ? item.insertText : undefined,
            detail: typeof item.detail === "string" ? item.detail : undefined,
            documentation: typeof item.documentation === "string"
              ? item.documentation
              : typeof item.documentation?.value === "string"
                ? item.documentation.value
                : undefined,
            kind: typeof item.kind === "number" ? item.kind : undefined,
          });
        }
      }
      send({ type: "completionResult", id: msg.id, items: merged.slice(0, 200) });
    } catch (e) {
      send({ type: "completionResult", id: msg.id, items: [], error: e && e.message ? e.message : String(e) });
    }
  }

  if (msg.type === "webviewMessage") {
    const channel = webviewChannels.get(msg.viewId);
    if (channel) {
      try { channel.fire(msg.message); } catch {}
    }
  }
}

const vscodeApi = {
  // value types
  Uri, RelativePattern, Range, Position, Selection, ThemeIcon, ThemeColor, TreeItem, NotebookCellOutputItem, NotebookCellOutput, NotebookCellData, NotebookData, NotebookRange, NotebookCellKind,
  CancellationTokenSource, CancellationToken, SnippetString, CompletionItem, CompletionItemKind, TextEdit, WorkspaceEdit, CodeAction, CodeLens, DocumentLink, Diagnostic,
  TextDocument, TextEditor,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn, LogLevel, CodeActionKind,
  DiagnosticSeverity, ConfigurationTarget, ExtensionMode, FileType,
  FileSystemError,
  Event, EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace, window, commands, languages, notebooks, authentication, tasks, debug, chat, lm, env, l10n, extensions,
  version,
  // internal
  _handleMessage: handleMessage,
  _initDefaults(defaults) { _schemaDefaults = defaults || {}; },
};

const NOOP_FN = function () { return undefined; };
const NOOP_PROXY = new Proxy(NOOP_FN, {
  get(_target, prop) {
    if (prop === "then") return undefined; // avoid being treated as Promise-like
    if (prop === "toString") return () => "[AthvaMissingVscodeApi]";
    return NOOP_PROXY;
  },
  apply() {
    return undefined;
  },
  construct() {
    return NOOP_PROXY;
  },
});

module.exports = new Proxy(vscodeApi, {
  get(target, prop, receiver) {
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
    return NOOP_PROXY;
  },
});

function _offsetAt(content, position) {
  const lines = String(content).split("\n");
  const targetLine = Math.max(0, Math.min(lines.length - 1, position.line || 0));
  let offset = 0;
  for (let i = 0; i < targetLine; i += 1) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(lines[targetLine].length, position.character || 0));
}

function walkFiles(root, onFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      walkFiles(full, onFile);
      continue;
    }
    const keepWalking = onFile(full);
    if (keepWalking === false) return;
  }
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeGlobPattern(pattern) {
  if (!pattern) return "**/*";
  if (typeof pattern === "string") return pattern;
  if (typeof pattern?.pattern === "string") return pattern.pattern;
  return "**/*";
}

function globMatch(file, pattern) {
  const normalizedFile = toPosix(file);
  const normalizedPattern = toPosix(String(pattern || "**/*"));
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${escaped}$`);
  return re.test(normalizedFile);
}
