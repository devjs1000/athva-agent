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
  static from(components = {}) {
    const scheme = components.scheme || "file";
    const authority = components.authority || "";
    const p = components.path || "";
    const query = components.query || "";
    const fragment = components.fragment || "";
    const u = new Uri(scheme, authority, p, query, fragment);
    if (scheme === "file") u.fsPath = p;
    return u;
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

class TabInputText {
  constructor(uri) { this.uri = uri; }
}

class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

class TabInputNotebook {
  constructor(uri) { this.uri = uri; }
}

class TabInputNotebookDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

class TabInputCustom {
  constructor(uri) { this.uri = uri; }
}

class LanguageModelChat {}

class LanguageModelTextPart {
  constructor(value) { this.value = String(value ?? ""); this.kind = "text"; }
}

class LanguageModelTextPart2 extends LanguageModelTextPart {}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
    this.kind = "data";
  }
}

class LanguageModelDataPart2 extends LanguageModelDataPart {}

class LanguageModelThinkingPart {
  constructor(value, id = "", metadata = {}) {
    this.value = String(value ?? "");
    this.id = id;
    this.metadata = metadata;
    this.kind = "thinking";
  }
}

class LanguageModelToolCallPart {
  constructor(id, name, input) {
    this.callId = id;
    this.id = id;
    this.name = name;
    this.input = input;
    this.kind = "tool_call";
  }
}

class LanguageModelToolResultPart {
  constructor(toolCallId, content = []) {
    this.toolCallId = toolCallId;
    this.content = content;
    this.kind = "tool_result";
  }
}

class LanguageModelToolResultPart2 extends LanguageModelToolResultPart {}

class LanguageModelToolResult extends LanguageModelToolResultPart {}

class LanguageModelPromptTsxPart {
  constructor(value = "") {
    this.value = String(value ?? "");
    this.kind = "prompt_tsx";
  }
}

class LanguageModelError extends Error {
  constructor(message = "") { super(String(message ?? "")); this.name = "LanguageModelError"; }
}

function _toLanguageModelContent(content) {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  return [new LanguageModelTextPart(content)];
}

class LanguageModelChatMessage {
  static User(content, name = "") {
    return { role: "user", name, content: _toLanguageModelContent(content) };
  }
  static Assistant(content, name = "") {
    return { role: "assistant", name, content: _toLanguageModelContent(content) };
  }
  static System(content, name = "") {
    return { role: "system", name, content: _toLanguageModelContent(content) };
  }
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
const UIKind = { Desktop: 1, Web: 2 };
const QuickPickItemKind = { Default: 0, Separator: -1 };
const QuickInputButtons = { Back: { tooltip: "Back" } };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Info: 2, Hint: 3 };
const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 };
const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
const CompletionItemTag = { Deprecated: 1 };
const CodeActionTriggerKind = { Invoke: 1, Automatic: 2 };
const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };
const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const DecorationRangeBehavior = { OpenOpen: 0, OpenClosed: 1, ClosedOpen: 2, ClosedClosed: 3 };
const EndOfLine = { LF: 1, CRLF: 2 };
const DebugAdapterInlineImplementation = class {};
const InlineCompletionEndOfLifeReasonKind = { Accepted: 1, Rejected: 2, Ignored: 3 };
const InlineCompletionsDisposeReasonKind = { Unknown: 0, Automatic: 1, ExplicitCancel: 2 };
const InlineCompletionDisplayLocationKind = { Label: 1, Code: 2 };
const InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 };
const CompletionList = class { constructor(items = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } };
const Color = class { constructor(red = 0, green = 0, blue = 0, alpha = 1) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha; } };
const ColorInformation = class { constructor(range, color) { this.range = range; this.color = color; } };
const ColorPresentation = class { constructor(label = "") { this.label = label; this.textEdit = undefined; this.additionalTextEdits = []; } };
const DiagnosticRelatedInformation = class { constructor(location, message) { this.location = location; this.message = String(message ?? ""); } };
class DocumentHighlight { constructor(range, kind) { this.range = range; this.kind = kind; } }
const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
class DocumentSymbol { constructor(name = "", detail = "", kind = 0, range = undefined, selectionRange = undefined) { this.name = name; this.detail = detail; this.kind = kind; this.range = range; this.selectionRange = selectionRange; this.children = []; } }
class FoldingRange { constructor(start, end, kind) { this.start = start; this.end = end; this.kind = kind; } }
const FoldingRangeKind = { Comment: "comment", Imports: "imports", Region: "region" };
class Hover { constructor(contents = [], range = undefined) { this.contents = contents; this.range = range; } }
class InlayHintLabelPart { constructor(value = "") { this.value = String(value); this.tooltip = undefined; this.location = undefined; this.command = undefined; } }
class InlineValueEvaluatableExpression { constructor(range, expression) { this.range = range; this.expression = expression; } }
class InlineValueText { constructor(range, text) { this.range = range; this.text = text; } }
class InlineValueVariableLookup { constructor(range, variableName, caseSensitiveLookup) { this.range = range; this.variableName = variableName; this.caseSensitiveLookup = !!caseSensitiveLookup; } }
class LinkedEditingRanges { constructor(ranges = [], wordPattern = undefined) { this.ranges = ranges; this.wordPattern = wordPattern; } }
class ParameterInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; } }
class SelectionRange { constructor(range, parent = undefined) { this.range = range; this.parent = parent; } }
class SemanticTokens { constructor(data = []) { this.data = data; } }
class SemanticTokensEdit { constructor(start, deleteCount, data = []) { this.start = start; this.deleteCount = deleteCount; this.data = data; } }
class SemanticTokensEdits { constructor(edits = [], resultId = undefined) { this.edits = edits; this.resultId = resultId; } }
class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
const SignatureHelpTriggerKind = { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 };
class SignatureInformation { constructor(label, documentation = undefined) { this.label = label; this.documentation = documentation; this.parameters = []; } }
const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };
const SymbolTag = { Deprecated: 1 };
const PortAttributes = class { constructor() { this.onOpen = undefined; this.onReconnect = undefined; } };
const PortAutoForwardAction = { Notify: 1, Ignore: 2, OpenBrowser: 3 };
const NotebookControllerAffinity = { Default: 1, Preferred: 2 };
const NotebookEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
const TabInputInteractiveWindow = class { constructor(uri) { this.uri = uri; } };
const NotebookRendererScript = class { constructor(id, path) { this.id = id; this.path = path; } };
const NotebookEdit = {
  updateNotebookMetadata: () => ({}),
  insertCells: () => ({}),
  replaceCells: () => ({}),
  updateCellMetadata: () => ({}),
  deleteCells: () => ({}),
};
const ChatEditingSessionActionOutcome = { Accepted: 1, Rejected: 2, Saved: 3 };
const ChatVariableLevel = { Full: 1 };
const ProgressLocation = { SourceControl: 1, Notification: 15 };
const SettingsSearchResultKind = { EMBEDDED: 1, LLM_RANKED: 2 };
const TerminalLocation = { Panel: 1, Editor: 2 };
const TextDocumentChangeReason = { Undo: 0, Redo: 1 };
const ExcludeSettingOptions = { None: 0, FilesExclude: 1, SearchAndFilesExclude: 2 };
const LanguageStatusSeverity = { Information: 0, Warning: 1, Error: 2 };
const TestResultState = { Queued: 0, Running: 1, Passed: 2, Failed: 3, Skipped: 4, Errored: 5, Unknown: 6 };
const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 };

class ChatCompletionItem {}
class ChatRequestTurn {}
class ChatRequestTurn2 {}
class ChatResponseMarkdownPart {}
class ChatResponseProgressPart {}
class ChatResponseReferencePart {}
class ChatResponseThinkingProgressPart {}
class ChatResponseTurn {}
class ChatResponseTurn2 {}
class ChatResponseWarningPart {}
class ChatToolInvocationPart {}
class TerminalProfile {}
class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class TestMessage {
  constructor(message, expected = undefined, actual = undefined) {
    this.message = String(message ?? "");
    this.expected = expected;
    this.actual = actual;
  }
  static diff(message, expected, actual) {
    return new TestMessage(message, expected, actual);
  }
  static escaped(message) {
    return new TestMessage(message);
  }
}

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
class InlineCompletionList {
  constructor(items = []) { this.items = Array.isArray(items) ? items : []; }
}
class InlineCompletionItem {
  constructor(insertText = "") {
    this.insertText = insertText;
    this.range = undefined;
    this.filterText = undefined;
    this.command = undefined;
    this.additionalTextEdits = [];
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

class CodeActionKindValue {
  constructor(value = "") { this.value = String(value); }
  append(part) {
    const suffix = String(part || "");
    return new CodeActionKindValue(this.value ? `${this.value}.${suffix}` : suffix);
  }
  contains(other) {
    const candidate = other instanceof CodeActionKindValue ? other.value : String(other?.value ?? other ?? "");
    return candidate === this.value || candidate.startsWith(`${this.value}.`);
  }
  intersects(other) {
    const candidate = other instanceof CodeActionKindValue ? other.value : String(other?.value ?? other ?? "");
    return this.contains(candidate) || String(this.value).startsWith(`${candidate}.`);
  }
  toString() { return this.value; }
}
const CodeActionKind = {
  Empty: new CodeActionKindValue(""),
  QuickFix: new CodeActionKindValue("quickfix"),
  Refactor: new CodeActionKindValue("refactor"),
  RefactorExtract: new CodeActionKindValue("refactor.extract"),
  RefactorInline: new CodeActionKindValue("refactor.inline"),
  RefactorRewrite: new CodeActionKindValue("refactor.rewrite"),
  Source: new CodeActionKindValue("source"),
  SourceFixAll: new CodeActionKindValue("source.fixAll"),
  SourceOrganizeImports: new CodeActionKindValue("source.organizeImports"),
  Notebook: new CodeActionKindValue("notebook"),
};

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

class SymbolInformation {
  constructor(name, kind, containerNameOrRange, locationOrUri, containerName) {
    this.name = name;
    this.kind = kind;
    if (containerNameOrRange instanceof Range) {
      this.location = { uri: locationOrUri, range: containerNameOrRange };
      this.containerName = containerName || "";
    } else {
      this.location = locationOrUri || {};
      this.containerName = containerNameOrRange || "";
    }
  }
}

class CallHierarchyIncomingCall {
  constructor(item, fromRanges = []) {
    this.from = item;
    this.fromRanges = fromRanges;
  }
}

class CallHierarchyOutgoingCall {
  constructor(item, fromRanges = []) {
    this.to = item;
    this.fromRanges = fromRanges;
  }
}

class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) {
    this.kind = kind; this.name = name; this.detail = detail;
    this.uri = uri; this.range = range; this.selectionRange = selectionRange;
  }
}

class TypeHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) {
    this.kind = kind; this.name = name; this.detail = detail;
    this.uri = uri; this.range = range; this.selectionRange = selectionRange;
  }
}

class InlayHint {
  constructor(position, label, kind) {
    this.position = position; this.label = label; this.kind = kind;
  }
}

class CancellationError extends Error {
  constructor() { super("Cancelled"); this.name = "CancellationError"; }
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
const notebookSaveEmitter = new EventEmitter();
const activeNotebookEditorEmitter = new EventEmitter();
const visibleNotebookEditorsEmitter = new EventEmitter();
const activeDebugSessionEmitter = new EventEmitter();
const debugCustomEventEmitter = new EventEmitter();
const activeColorThemeEmitter = new EventEmitter();
const onDidRenameFilesEmitter = new EventEmitter();
const onDidDeleteFilesEmitter = new EventEmitter();
const onWillSaveTextDocumentEmitter = new EventEmitter();
const onDidCreateFilesEmitter = new EventEmitter();
const onWillCreateFilesEmitter = new EventEmitter();
const onWillRenameFilesEmitter = new EventEmitter();
const onWillDeleteFilesEmitter = new EventEmitter();
const onDidChangeConfigurationEmitter = new EventEmitter();
const terminals = [];
let activeTerminal = {
  name: "",
  processId: 0,
  creationOptions: {},
  state: {},
  shellIntegration: {},
  sendText() {},
  show() {},
  hide() {},
  dispose() {},
  selection: undefined,
};
const activeColorTheme = { kind: ColorThemeKind.Dark, backgroundColor: undefined, foregroundColor: undefined };
const activeTabGroupState = { activeTab: undefined, viewColumn: ViewColumn.One, tabs: [] };
let activeNotebookEditorState = {
  notebook: { uri: Uri.file(""), cellCount: 0, getCells: () => [] },
  selection: new NotebookRange(0, 0),
  selections: [],
  visibleRanges: [],
};
let visibleNotebookEditorsState = [];
const onDidChangeTextEditorVisibleRangesEmitter = new EventEmitter();

function setActiveTab(input, label, viewColumn = ViewColumn.One) {
  const tab = { input, label, viewColumn, active: true };
  activeTabGroupState.activeTab = tab;
  activeTabGroupState.viewColumn = viewColumn;
  activeTabGroupState.tabs = [tab];
}

// ── workspace ────────────────────────────────────────────────────────────────

let _workspaceFolders = [];
let _configuration = {};
let _schemaDefaults = {};
const _fsProviders = new Map();
const textDocuments = [];

const workspaceFoldersEmitter = new EventEmitter();

function _getConfigValue(section, key) {
  const sectionData = section ? (_configuration[section] || {}) : _configuration;
  if (key in sectionData) return sectionData[key];
  const flatKey = section ? `${section}.${key}` : key;
  if (_schemaDefaults && flatKey in _schemaDefaults) return _schemaDefaults[flatKey];
  if (!section) {
    const deepValue = findDeepLeafValue(_schemaDefaults, key);
    if (deepValue !== undefined) return deepValue;
  }
  return undefined;
}

function setDeepValue(target, pathParts, value) {
  let cursor = target;
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    const part = pathParts[i];
    if (!part) continue;
    if (cursor[part] == null || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  const leaf = pathParts[pathParts.length - 1];
  if (leaf) cursor[leaf] = value;
}

function findDeepLeafValue(tree, leafKey) {
  if (!tree || typeof tree !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(tree, leafKey)) return tree[leafKey];
  for (const value of Object.values(tree)) {
    const found = findDeepLeafValue(value, leafKey);
    if (found !== undefined) return found;
  }
  return undefined;
}

function buildConfigTree(section) {
  const tree = {};
  const prefix = section ? `${section}.` : "";
  const sectionData = section ? (_configuration[section] || {}) : _configuration;

  for (const [key, value] of Object.entries(_schemaDefaults || {})) {
    if (!prefix) {
      setDeepValue(tree, String(key).split("."), value);
      continue;
    }
    if (!String(key).startsWith(prefix)) continue;
    setDeepValue(tree, String(key).slice(prefix.length).split("."), value);
  }

  for (const [key, value] of Object.entries(sectionData || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tree[key] = { ...(tree[key] && typeof tree[key] === "object" ? tree[key] : {}), ...value };
    } else {
      tree[key] = value;
    }
  }

  return tree;
}

const workspace = {
  get workspaceFolders() { return _workspaceFolders; },
  isTrusted: true,
  isAgentSessionsWorkspace: false,
  get name() { return _workspaceFolders[0]?.name || ""; },
  get rootPath() { return _workspaceFolders[0]?.uri?.fsPath || undefined; },
  get workspaceFile() { return undefined; },
  get textDocuments() { return textDocuments.filter(Boolean); },
  get notebookDocuments() { return notebookDocuments.filter(Boolean); },
  onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
  onDidRenameFiles: onDidRenameFilesEmitter.event,
  onDidDeleteFiles: onDidDeleteFilesEmitter.event,
  onWillSaveTextDocument: onWillSaveTextDocumentEmitter.event,
  onDidCreateFiles: onDidCreateFilesEmitter.event,
  onWillCreateFiles: onWillCreateFilesEmitter.event,
  onWillRenameFiles: onWillRenameFilesEmitter.event,
  onWillDeleteFiles: onWillDeleteFilesEmitter.event,
  onDidSaveNotebookDocument: notebookSaveEmitter.event,
  onDidGrantWorkspaceTrust: new EventEmitter().event,

  getConfiguration(section) {
    const sectionData = section ? (_configuration[section] || {}) : _configuration;
    const configTree = buildConfigTree(section);

    const config = {
      get(key, defaultValue) {
        if (!section && typeof key === "string" && key in configTree) {
          return configTree[key];
        }
        const val = _getConfigValue(section, key);
        return val !== undefined ? val : defaultValue;
      },
      has(key) {
        const flatKey = section ? `${section}.${key}` : key;
        return key in sectionData || flatKey in (_schemaDefaults || {});
      },
      inspect(key) {
        const flatKey = section ? `${section}.${key}` : key;
        return { key: flatKey, defaultValue: (_schemaDefaults || {})[flatKey], globalValue: sectionData[key] };
      },
      update(key, value) { sectionData[key] = value; return Promise.resolve(); },
    };

    // VS Code extensions sometimes (incorrectly) read config values via property access
    // (e.g. getConfiguration('x').someKey). Provide a Proxy to match that behavior.
    return new Proxy(config, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "symbol") return undefined;
        if (typeof prop !== "string") return undefined;
        if (prop in configTree) return configTree[prop];
        return section ? undefined : findDeepLeafValue(configTree, prop);
      },
      has(_target, prop) {
        if (prop in config) return true;
        return typeof prop === "string" ? prop in configTree : false;
      },
    });
  },

  onDidChangeConfiguration(listener) {
    return onDidChangeConfigurationEmitter.event(listener);
  },
  requestResourceTrust(_resource) { return Promise.resolve(true); },
  requestWorkspaceTrust(_options) { return Promise.resolve(true); },
  saveAll(_includeUntitled) { return Promise.resolve(true); },
  registerPortAttributesProvider() { return new Disposable(() => {}); },
  showWorkspaceFolderPick() { return Promise.resolve(_workspaceFolders[0]); },
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
  getWorkspaceFolder(uri) {
    const target = uri && typeof uri === "object" ? (uri.fsPath || uri.path || "") : String(uri || "");
    for (const folder of _workspaceFolders) {
      const root = folder?.uri?.fsPath || "";
      if (target && root && target.startsWith(root)) return folder;
    }
    return _workspaceFolders[0];
  },

  findFiles(include, exclude, maxResults) {
    // Bridge to renderer for actual file search
    return Promise.resolve([]);
  },

  findFiles2(includes, options) {
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
  tabGroups: {
    all: [activeTabGroupState],
    activeTabGroup: activeTabGroupState,
    onDidChangeTabGroups: new EventEmitter().event,
    onDidChangeTabs: new EventEmitter().event,
    close: async () => undefined,
  },
  onDidChangeWindowState: new EventEmitter().event,
  onDidChangeActiveColorTheme: activeColorThemeEmitter.event,
  activeColorTheme,
  terminals,
  activeTerminal,
  onDidChangeActiveTerminal: new EventEmitter().event,
  onDidChangeTerminalShellIntegration: new EventEmitter().event,
  onDidChangeTerminalState: new EventEmitter().event,
  onDidStartTerminalShellExecution: new EventEmitter().event,
  onDidEndTerminalShellExecution: new EventEmitter().event,
  onDidWriteTerminalData: new EventEmitter().event,
  onDidExecuteTerminalCommand: new EventEmitter().event,
  onDidCloseTerminal: new EventEmitter().event,
  onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRangesEmitter.event,
  setStatusBarMessage: (message, timeoutOrThenable) => {
    const disposable = ensureDisposable({ dispose() {} });
    if (timeoutOrThenable && typeof timeoutOrThenable.then === "function") {
      Promise.resolve(timeoutOrThenable).finally(() => disposable.dispose());
    }
    return disposable;
  },
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
  registerTreeDataProvider(viewId, provider) {
    return window.createTreeView(viewId, { treeDataProvider: provider });
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
  showWorkspaceFolderPick() { return Promise.resolve(_workspaceFolders[0]); },

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
    setActiveTab(new TabInputCustom(Uri.file("")), title || viewType || "panel", typeof column === "number" ? column : ViewColumn.One);
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
  createQuickPick: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      items: [],
      selectedItems: [],
      value: "",
      title: "",
      placeholder: "",
      canSelectMany: false,
      busy: false,
      ignoreFocusOut: false,
      onDidChangeValue: emitter.event,
      onDidChangeSelection: emitter.event,
      onDidAccept: emitter.event,
      onDidHide: emitter.event,
      show() {},
      hide() {},
      dispose() { emitter.dispose(); },
    });
  },
  createInputBox: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      value: "",
      prompt: "",
      placeholder: "",
      title: "",
      password: false,
      busy: false,
      ignoreFocusOut: false,
      onDidChangeValue: emitter.event,
      onDidAccept: emitter.event,
      onDidHide: emitter.event,
      show() {},
      hide() {},
      dispose() { emitter.dispose(); },
    });
  },
  showInputBox: () => Promise.resolve(undefined),
  showOpenDialog: async (options = {}) => {
    if (options?.defaultUri) return [options.defaultUri];
    return [];
  },
  showSaveDialog: async (options = {}) => {
    return options?.defaultUri;
  },
  showTextDocument: async (documentOrUri, _columnOrOptions, _preserveFocus) => {
    let doc = documentOrUri;
    if (typeof documentOrUri === "string" || documentOrUri?.scheme || documentOrUri?.fsPath) {
      try { doc = await workspace.openTextDocument(documentOrUri); } catch {}
    }
    const editor = makeTextEditor(doc || { uri: Uri.file(""), fileName: "", languageId: "plaintext", getText: () => "" });
    window.activeTextEditor = editor;
    setActiveTab(new TabInputText(editor.document.uri), editor.document.fileName || require("path").basename(editor.document.uri?.fsPath || "") || "Untitled", ViewColumn.One);
    return editor;
  },
  activeTextEditor: new TextEditor(new TextDocument(Uri.file(""), "")),
  get visibleTextEditors() { return []; },
  set visibleTextEditors(_editors) {},
  onDidChangeActiveTextEditor: new EventEmitter().event,
  onDidChangeVisibleTextEditors: new EventEmitter().event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  get activeNotebookEditor() { return activeNotebookEditorState; },
  set activeNotebookEditor(editor) {
    activeNotebookEditorState = editor && typeof editor === "object"
      ? {
          ...editor,
          notebook: editor.notebook && typeof editor.notebook === "object"
            ? { ...editor.notebook, uri: editor.notebook.uri ?? Uri.file(""), getCells: editor.notebook.getCells || (() => []) }
            : { uri: Uri.file(""), cellCount: 0, getCells: () => [] },
        }
      : {
          notebook: { uri: Uri.file(""), cellCount: 0, getCells: () => [] },
          selection: new NotebookRange(0, 0),
          selections: [],
          visibleRanges: [],
        };
  },
  get visibleNotebookEditors() { return visibleNotebookEditorsState.filter(Boolean); },
  set visibleNotebookEditors(editors) {
    visibleNotebookEditorsState = Array.isArray(editors) ? editors.filter(Boolean) : [];
  },
  onDidChangeActiveNotebookEditor: activeNotebookEditorEmitter.event,
  onDidChangeVisibleNotebookEditors: visibleNotebookEditorsEmitter.event,
  showNotebookDocument: async (notebookOrUri) => {
    const document = notebookOrUri?.notebookType
      ? notebookOrUri
      : await workspace.openNotebookDocument(notebookOrUri);
    const editor = { notebook: document, selection: new NotebookRange(0, 0), selections: [], visibleRanges: [] };
    window.activeNotebookEditor = editor;
    window.visibleNotebookEditors = [editor];
    activeNotebookEditorEmitter.fire(editor);
    visibleNotebookEditorsEmitter.fire(window.visibleNotebookEditors);
    setActiveTab(new TabInputNotebook(document.uri), document.uri?.fsPath ? require("path").basename(document.uri.fsPath) : "Notebook", ViewColumn.One);
    return editor;
  },
  registerWebviewViewProvider: () => new Disposable(() => {}),
  registerCustomEditorProvider: () => new Disposable(() => {}),
  createChatStatusItem: () => ensureDisposable({ text: "", tooltip: "", command: undefined, show() {}, hide() {}, dispose() {} }),
  createTerminal(optionsOrName) {
    const terminal = {
      name: typeof optionsOrName === "string" ? optionsOrName : (optionsOrName?.name || "Terminal"),
      processId: terminals.length + 1,
      creationOptions: typeof optionsOrName === "object" ? optionsOrName : { name: String(optionsOrName || "Terminal") },
      state: { shell: process.env.SHELL || "/bin/zsh" },
      shellIntegration: {},
      sendText() {},
      show() { activeTerminal = terminal; window.activeTerminal = terminal; },
      hide() {},
      dispose() {},
    };
    terminals.push(terminal);
    activeTerminal = terminal;
    window.activeTerminal = terminal;
    setActiveTab(new TabInputCustom(Uri.file("")), terminal.name, ViewColumn.One);
    return terminal;
  },
  registerTerminalLinkProvider: () => new Disposable(() => {}),
  registerTerminalProfileProvider: () => new Disposable(() => {}),
};

// ── commands ──────────────────────────────────────────────────────────────────

const registeredCommands = new Map();

const commands = {
  registerCommand(id, handler, thisArg) {
    registeredCommands.set(id, thisArg ? handler.bind(thisArg) : handler);
    return new Disposable(() => registeredCommands.delete(id));
  },
  async executeCommand(id, ...args) {
    const handler = registeredCommands.get(id);
    if (handler) return handler(...args);
    if (id === "vscode.open") {
      const uri = args[0];
      if (uri) {
        try { await window.showTextDocument(uri); } catch {}
      }
      return true;
    }
    if (id === "vscode.openFolder" || id === "vscode.diff") return true;
    if (id === "vscode.executeDefinitionProvider" || id === "vscode.executeTypeDefinitionProvider" || id === "vscode.executeImplementationProvider" || id === "vscode.executeReferenceProvider" || id === "vscode.executeWorkspaceSymbolProvider" || id === "vscode.executeDocumentSymbolProvider" || id === "vscode.executeCodeActionProvider" || id === "vscode.executeNotebookVariableProvider") {
      return [];
    }
    if (id === "vscode.testing.getControllersWithTests" || id === "vscode.testing.getTestsInFile") {
      return [];
    }
    if (id === "vscode.openWith") {
      const uri = args[0];
      if (uri) {
        try { await window.showTextDocument(uri); } catch {}
      }
      return true;
    }
    if (id === "vscode.editor.open" || id === "vscode.editor.openLast" || id === "vscode.primaryEditor.open" || id === "vscode.sidebar.open" || id === "vscode.terminal.open" || id === "vscode.window.open" || id === "vscode.openWalkthrough" || id === "vscode.acceptProposedDiff" || id === "vscode.rejectProposedDiff" || id === "vscode.toggleDictation" || id === "vscode.showLogs" || id === "vscode.newConversation" || id === "vscode.logout" || id === "vscode.installPlugin" || id === "vscode.focus" || id === "vscode.blur" || id === "vscode.insertAtMention") {
      return true;
    }
    if (id.startsWith("vscode.")) return true;
    return undefined;
  },
  getCommands() { return Promise.resolve([...registeredCommands.keys()]); },
  registerTextEditorCommand(id, handler) { return commands.registerCommand(id, handler); },
};

// ── languages ─────────────────────────────────────────────────────────────────

const languages = {
  _diagnostics: new Map(),
  inlineCompletionsUnificationState: { expAssignments: [] },
  onDidChangeCompletionsUnificationState: new EventEmitter().event,
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
  registerTypeDefinitionProvider: () => new Disposable(() => {}),
  registerImplementationProvider: () => new Disposable(() => {}),
  registerDeclarationProvider: () => new Disposable(() => {}),
  registerCallHierarchyProvider: () => new Disposable(() => {}),
  registerInlineValuesProvider: () => new Disposable(() => {}),
  registerLinkedEditingRangeProvider: () => new Disposable(() => {}),
  registerTypeHierarchyProvider: () => new Disposable(() => {}),
  setTextDocumentLanguage: async (document, languageId) => {
    if (document && typeof document === "object") document.languageId = languageId;
    return document;
  },
  createLanguageStatusItem(id, _selector) {
    const emitter = new EventEmitter();
    return { id, text: "", detail: "", severity: 0, command: undefined, busy: false,
      onDidDispose: emitter.event, dispose() { emitter.fire(); } };
  },
  registerHoverProvider: () => new Disposable(() => {}),
  registerCompletionItemProvider: () => new Disposable(() => {}),
  registerDefinitionProvider: () => new Disposable(() => {}),
  registerDocumentHighlightProvider: () => new Disposable(() => {}),
  registerDocumentLinkProvider: () => new Disposable(() => {}),
  registerSelectionRangeProvider: () => new Disposable(() => {}),
  registerDocumentRangeFormattingEditProvider: () => new Disposable(() => {}),
  registerDocumentRangeSemanticTokensProvider: () => new Disposable(() => {}),
  registerColorPresentationProvider: () => new Disposable(() => {}),
  registerOnTypeFormattingEditProvider: () => new Disposable(() => {}),
  registerCodeActionsProvider: () => new Disposable(() => {}),
  registerWorkspaceSymbolProvider: () => new Disposable(() => {}),
  registerDocumentFormattingEditProvider: () => new Disposable(() => {}),
  registerFoldingRangeProvider: () => new Disposable(() => {}),
  onDidChangeDiagnostics: new EventEmitter().event,
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
  createNotebookControllerDetectionTask() {
    return ensureDisposable({
      dispose() {},
    });
  },
  registerKernelSourceActionProvider() {
    return new Disposable(() => {});
  },
  createRendererMessaging() {
    const emitter = new EventEmitter();
    return ensureDisposable({
      onDidReceiveMessage: emitter.event,
      postMessage: async () => true,
      dispose() {
        emitter.dispose();
      },
    });
  },
  get notebookDocuments() { return notebookDocuments.filter(Boolean); },
  onDidOpenNotebookDocument: notebookOpenEmitter.event,
  onDidCloseNotebookDocument: notebookCloseEmitter.event,
  onDidChangeNotebookDocument: notebookChangeEmitter.event,
};

const debug = {
  startDebugging: async () => false,
  stopDebugging: async () => undefined,
  registerDebugConfigurationProvider: () => new Disposable(() => {}),
  registerDebugAdapterDescriptorFactory: () => new Disposable(() => {}),
  registerDebugAdapterTrackerFactory: () => new Disposable(() => {}),
  activeDebugSession: { name: "", id: "debug-session", type: "", parentSession: undefined, configuration: {} },
  activeDebugConsole: { append() {}, appendLine() {}, clear() {}, show() {}, hide() {}, dispose() {} },
  breakpoints: [],
  onDidChangeBreakpoints: new EventEmitter().event,
  onDidStartDebugSession: new EventEmitter().event,
  onDidTerminateDebugSession: new EventEmitter().event,
  onDidChangeActiveDebugSession: activeDebugSessionEmitter.event,
  onDidReceiveDebugSessionCustomEvent: debugCustomEventEmitter.event,
  addBreakpoints: async (bps) => bps || [],
  removeBreakpoints: async () => undefined,
};

const chat = {
  createChatParticipant: () => ensureDisposable({ dispose() {} }),
  createDynamicChatParticipant: () => ensureDisposable({ dispose() {} }),
  onDidDisposeChatSession: new EventEmitter().event,
  onDidChangeCustomAgents: new EventEmitter().event,
  onDidChangeInstructions: new EventEmitter().event,
  onDidChangeSkills: new EventEmitter().event,
  onDidChangeHooks: new EventEmitter().event,
  onDidChangePlugins: new EventEmitter().event,
  registerChatSessionItemProvider: () => ensureDisposable({ enabled: true, isEnabled: true, onDidChangeEnablement: new EventEmitter().event, onDidChangeEnableStates: new EventEmitter().event, onDidChangeChatSessionItemState: new EventEmitter().event, dispose() {} }),
  registerChatSessionContentProvider: () => ensureDisposable({ enabled: true, isEnabled: true, onDidChangeEnablement: new EventEmitter().event, onDidChangeEnableStates: new EventEmitter().event, dispose() {} }),
  registerChatSessionCustomizationProvider: () => ensureDisposable({ enabled: true, isEnabled: true, onDidChangeEnablement: new EventEmitter().event, onDidChangeEnableStates: new EventEmitter().event, dispose() {} }),
  getCustomAgents: async () => [],
};

const tests = {
  testResults: [],
  onDidChangeTestResults: new EventEmitter().event,
  createTestController(id, label) {
    const emitter = new EventEmitter();
    return {
      id,
      label,
      items: new Map(),
      createTestItem(testId, testLabel, uri) {
        return {
          id: testId,
          label: testLabel,
          uri,
          children: new Map(),
          tags: [],
          canResolveChildren: false,
          busy: false,
          description: undefined,
          error: undefined,
          range: undefined,
          parent: undefined,
          dispose() {},
        };
      },
      createRunProfile() {
        return ensureDisposable({ dispose() {} });
      },
      createTestRun(request) {
        return ensureDisposable({
          enqueued() {},
          started() {},
          skipped() {},
          passed() {},
          failed() {},
          errored() {},
          appendOutput() {},
          end() {},
          dispose() {},
          request,
        });
      },
      refreshHandler: undefined,
      resolveHandler: undefined,
      invalidateTestResults() {},
      onDidDispose: emitter.event,
      dispose() {
        emitter.fire();
      },
    };
  },
  createTestMessage(message, expected, actual) {
    return new TestMessage(message, expected, actual);
  },
};

const lmTools = [];
const mcpServerDefinitionsEmitter = new EventEmitter();
const mcpServerDefinitions = [];

const lm = {
  isModelProxyAvailable: false,
  onDidChangeModelProxyAvailability: new EventEmitter().event,
  onDidChangeMcpServerDefinitions: mcpServerDefinitionsEmitter.event,
  mcpServerDefinitions,
  tools: lmTools,
  getModelProxy: async () => ({
    uri: "athva://lm/proxy",
    dispose() {},
  }),
  registerLanguageModelChatProvider: () => new Disposable(() => {}),
  registerMcpServerDefinitionProvider: () => new Disposable(() => {}),
  startMcpGateway: async () => undefined,
  invokeTool: async (name, _args) => lmTools.find((tool) => tool?.name === name || tool?.toolName === name),
  registerTool: (tool) => {
    if (tool) lmTools.push(tool);
    return new Disposable(() => {
      const index = lmTools.indexOf(tool);
      if (index >= 0) lmTools.splice(index, 1);
    });
  },
  selectChatModels: async () => [],
};

const editorChat = {
  start: async (...args) => commands.executeCommand("vscode.editorChat.start", ...args),
};

function extensionPromptFileProvider(...args) {
  return commands.executeCommand("vscode.extensionPromptFileProvider", ...args);
}

const interactive = {
  transferActiveChat: async () => undefined,
};

// ── env ───────────────────────────────────────────────────────────────────────

const env = {
  appRoot: process.env.VSCODE_APP_ROOT || "",
  appName: "Athva",
  appCommit: process.env.GIT_COMMIT || process.env.COMMIT_SHA || "",
  appHost: "desktop",
  language: "en",
  machineId: "athva-machine",
  sessionId: "athva-session",
  uriScheme: "athva",
  uiKind: UIKind.Desktop,
  devDeviceId: "athva-device",
  isTelemetryEnabled: true,
  onDidChangeTelemetryEnabled: new EventEmitter().event,
  createTelemetryLogger: () => {
    const stateEmitter = new EventEmitter();
    return {
      isUsageEnabled: true,
      isErrorsEnabled: true,
      onDidChangeEnableStates: stateEmitter.event,
      onDidChangeEnablement: stateEmitter.event,
      logUsage() {},
      logError() {},
      dispose() {},
    };
  },
  remoteName: undefined,
  shell: process.env.SHELL || "/bin/zsh",
  openExternal: (uri) => { send({ type: "openExternal", uri: uri.toString() }); return Promise.resolve(true); },
  clipboard: { readText: () => Promise.resolve(""), writeText: () => Promise.resolve() },
  getDataChannel: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      onDidReceiveData: emitter.event,
      append() {},
      send() {},
      dispose() {},
    });
  },
  power: {
    isOnBatteryPower: async () => false,
    getCurrentThermalState: async () => "nominal",
    getSystemIdleTime: async () => 0,
    onDidSuspend: new EventEmitter().event,
    onDidResume: new EventEmitter().event,
    onDidChangeOnBatteryPower: new EventEmitter().event,
    onDidChangeThermalState: new EventEmitter().event,
    onDidChangeSpeedLimit: new EventEmitter().event,
    onWillShutdown: new EventEmitter().event,
    onDidLockScreen: new EventEmitter().event,
    onDidUnlockScreen: new EventEmitter().event,
  },
};

const version = "1.106.0";

// ── l10n ─────────────────────────────────────────────────────────────────────
function formatL10n(message, args) {
  if (typeof message !== "string") return "";
  return message.replace(/\{(\d+)\}/g, (_m, idx) => String(args[Number(idx)] ?? ""));
}

const l10n = {
  bundle: {},
  t(message, ...args) {
    return formatL10n(message, args);
  },
};

// ── extensions ────────────────────────────────────────────────────────────────

const extensions = {
  all: [],
  getExtension: (id) => {
    const ensureEnablementShape = (ext) => {
      if (!ext || typeof ext !== "object") return ext;
      if (typeof ext.enabled !== "boolean") ext.enabled = true;
      if (typeof ext.onDidChangeEnablement !== "function") {
        const emitter = new EventEmitter();
        ext.onDidChangeEnablement = emitter.event;
      }
      return ext;
    };
    if (id === "vscode.git") {
      const enablementEmitter = new EventEmitter();
      const exports = {
        enabled: true,
        onDidChangeEnablement: enablementEmitter.event,
        getAPI: () => ({ repositories: [] }),
      };
      return ensureEnablementShape({
        id: "vscode.git",
        isActive: true,
        enabled: true,
        onDidChangeEnablement: enablementEmitter.event,
        exports,
        activate: () => Promise.resolve(exports),
        packageJSON: { name: "git", publisher: "vscode", version: "1.0.0" },
      });
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
      if (prop === Symbol.iterator) {
        return function* emptyIterator() {};
      }
      if (prop === Symbol.asyncIterator) {
        return async function* emptyAsyncIterator() {};
      }
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
  __esModule: true,
  // value types
  Uri, Range, Position, Selection, Location, Color, ColorInformation, ColorPresentation, ThemeIcon, ThemeColor, TreeItem, NotebookCellOutputItem, NotebookCellOutput, NotebookCellData, NotebookData, NotebookRange, NotebookCellKind, NotebookEdit, NotebookRendererScript, NotebookControllerAffinity, NotebookEditorRevealType,
  TabInputText, TabInputTextDiff, TabInputNotebook, TabInputNotebookDiff, TabInputCustom,
  LanguageModelChat, LanguageModelChatMessage, LanguageModelTextPart, LanguageModelTextPart2, LanguageModelDataPart, LanguageModelDataPart2, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelToolResultPart2, LanguageModelToolResult, LanguageModelPromptTsxPart, LanguageModelError,
  ChatCompletionItem, ChatRequestTurn, ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseProgressPart, ChatResponseReferencePart, ChatResponseThinkingProgressPart, ChatResponseTurn, ChatResponseTurn2, ChatResponseWarningPart, ChatToolInvocationPart, ChatVariableLevel,
  CancellationTokenSource, CancellationToken, CancellationError, CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, TextEdit, WorkspaceEdit, CodeAction, CodeActionKind, CodeActionTriggerKind, Diagnostic, DiagnosticTag, DiagnosticRelatedInformation, InlineCompletionList, InlineCompletionItem, DebugAdapterInlineImplementation,
  SymbolInformation, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem, InlayHint, InlayHintLabelPart,
  TextDocument, TextEditor,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn, UIKind, QuickPickItemKind, QuickInputButtons, LogLevel, TerminalProfile, TerminalLocation, TabInputInteractiveWindow,
  InlineCompletionEndOfLifeReasonKind, InlineCompletionsDisposeReasonKind, InlineCompletionDisplayLocationKind, InlineCompletionTriggerKind, DecorationRangeBehavior, ChatEditingSessionActionOutcome,
  DiagnosticSeverity, ColorThemeKind, ConfigurationTarget, ExtensionKind, ExtensionMode, FileType, EndOfLine, ExcludeSettingOptions, LanguageStatusSeverity, ProgressLocation, SettingsSearchResultKind, TextDocumentChangeReason, CompletionTriggerKind,
  DocumentHighlight, DocumentHighlightKind, DocumentSymbol, FoldingRange, FoldingRangeKind, Hover, PortAttributes, PortAutoForwardAction, TextDocumentSaveReason, TextEditorRevealType,
  TestResultState, TestRunProfileKind, TestMessage,
  Event, EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace: withApiFallback(workspace, "vscode.workspace"),
  window: withApiFallback(window, "vscode.window"),
  commands: withApiFallback(commands, "vscode.commands"),
  languages: withApiFallback(languages, "vscode.languages"),
  notebooks: withApiFallback(notebooks, "vscode.notebooks"),
  chat: withApiFallback(chat, "vscode.chat"),
  tests: withApiFallback(tests, "vscode.tests"),
  testing: withApiFallback(tests, "vscode.testing"),
  debug: withApiFallback(debug, "vscode.debug"),
  lm: withApiFallback(lm, "vscode.lm"),
  editorChat,
  extensionPromptFileProvider,
  interactive,
  env: withApiFallback(env, "vscode.env"),
  l10n: withApiFallback(l10n, "vscode.l10n"),
  extensions: withApiFallback(extensions, "vscode.extensions"),
  process,
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
