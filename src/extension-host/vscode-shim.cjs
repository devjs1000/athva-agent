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
  translate(lineDelta = 0, characterDelta = 0) {
    if (typeof lineDelta === "object" && lineDelta !== null) {
      return new Position(
        this.line + (Number(lineDelta.lineDelta) || 0),
        this.character + (Number(lineDelta.characterDelta) || 0),
      );
    }
    return new Position(
      this.line + (Number(lineDelta) || 0),
      this.character + (Number(characterDelta) || 0),
    );
  }
  isEqual(other) {
    return !!other && this.line === other.line && this.character === other.character;
  }
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
const LogLevel = { Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Off: 6 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ExtensionKind = { UI: 1, Workspace: 2 };
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
const ProgressLocation = { SourceControl: 1, Notification: 15, Window: 10 };
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

class SymbolInformation {
  constructor(name, kind, containerNameOrRange, locationOrUri, containerName) {
    this.name = name;
    this.kind = kind;
    if (containerNameOrRange instanceof Range) {
      this.location = new Location(locationOrUri, containerNameOrRange);
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

function makeTextEditor(document) {
  return {
    document,
    viewColumn: ViewColumn.One,
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
      if (!edits.length || !document || typeof document._content !== "string") {
        return Promise.resolve(edits.length > 0);
      }
      const nextContent = applyTextEditsToContent(document._content, edits);
      if (nextContent !== document._content) {
        document._content = nextContent;
        document.lineCount = String(nextContent).split("\n").length;
        document.version = (Number(document.version) || 0) + 1;
        document.isDirty = true;
        onDidChangeTextDocumentEmitter.fire({
          document,
          contentChanges: [{ text: nextContent }],
          reason: TextDocumentChangeReason.Undo,
        });
      }
      return Promise.resolve(true);
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
    this.isUntitled = (uri?.scheme || "") === "untitled" || !this.fileName;
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
  save() {
    const target = this.uri?.fsPath || this.fileName;
    if (!target || this.isUntitled) return Promise.resolve(false);
    try {
      fs.writeFileSync(target, this._content, "utf8");
      this.isDirty = false;
      onDidSaveTextDocumentEmitter.fire(this);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
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
    if (!edits.length || !this.document || typeof this.document._content !== "string") {
      return Promise.resolve(edits.length > 0);
    }
    const nextContent = applyTextEditsToContent(this.document._content, edits);
    if (nextContent !== this.document._content) {
      this.document._content = nextContent;
      this.document.lineCount = String(nextContent).split("\n").length;
      this.document.version = (Number(this.document.version) || 0) + 1;
      this.document.isDirty = true;
      onDidChangeTextDocumentEmitter.fire({
        document: this.document,
        contentChanges: [{ text: nextContent }],
        reason: TextDocumentChangeReason.Undo,
      });
    }
    return Promise.resolve(true);
  }
  insertSnippet() { return Promise.resolve(false); }
}

function applyTextEditsToContent(content, edits) {
  let next = String(content ?? "");
  const updates = Array.isArray(edits)
    ? edits
        .map((e) => {
          const start = _offsetAt(next, e.range?.start || new Position(0, 0));
          const end = _offsetAt(next, e.range?.end || new Position(0, 0));
          return { start, end, newText: String(e.newText ?? "") };
        })
        .sort((a, b) => b.start - a.start)
    : [];
  for (const update of updates) {
    next = next.slice(0, update.start) + update.newText + next.slice(update.end);
  }
  return next;
}

function trackOpenTextDocument(document) {
  if (!document || textDocuments.includes(document)) return document;
  textDocuments.push(document);
  return document;
}

function updateTrackedTextDocument(uri, content, options = {}) {
  const target = uri?.toString?.() || String(uri || "");
  for (const doc of textDocuments) {
    if (!doc || (doc.uri?.toString?.() || String(doc.uri || "")) !== target) continue;
    doc._content = String(content ?? "");
    doc.lineCount = doc._content.split("\n").length;
    doc.version = (Number(doc.version) || 0) + 1;
    doc.isDirty = !!options.markDirty;
    if (typeof options.languageId === "string") doc.languageId = options.languageId;
    if (options.fireChange) {
      onDidChangeTextDocumentEmitter.fire({
        document: doc,
        contentChanges: [{ text: doc._content }],
        reason: options.reason,
      });
    }
  }
}

function createTextDocumentInput(input) {
  if (!input || typeof input !== "object") return undefined;
  if ("scheme" in input || "fsPath" in input || "path" in input) return undefined;
  return input;
}

function makeUntitledUri(languageId = "plaintext") {
  return Uri.from({
    scheme: "untitled",
    path: `Untitled-${languageId || "file"}`,
  });
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
const customEditorProviders = new Map();
const textDocumentContentProviders = new Map();
const webviewPanelSerializers = new Map();
const uriHandlers = new Set();
const portAttributesProviders = [];
const notebookCellStatusBarItemProviders = [];
const kernelSourceActionProviders = [];
const notebookSerializers = new Map();
const notebookDocuments = [];
const notebookControllers = new Map();
const debugConfigurationProviders = new Map();
const debugAdapterDescriptorFactories = [];
const debugAdapterTrackerFactories = [];
let activeDebugSessionState = undefined;
const notebookOpenEmitter = new EventEmitter();
const notebookCloseEmitter = new EventEmitter();
const notebookChangeEmitter = new EventEmitter();
const notebookSaveEmitter = new EventEmitter();
const activeNotebookEditorEmitter = new EventEmitter();
const visibleNotebookEditorsEmitter = new EventEmitter();
const activeDebugSessionEmitter = new EventEmitter();
const debugCustomEventEmitter = new EventEmitter();
const activeColorThemeEmitter = new EventEmitter();
const gitRepositoryEmitter = new EventEmitter();
const gitStateEmitter = new EventEmitter();
const gitInputEmitter = new EventEmitter();
const gitRepoStateEmitter = new EventEmitter();
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
function matchesDebugType(entryType, debugType) {
  const normalizedEntryType = String(entryType || "");
  const normalizedDebugType = String(debugType || "");
  return !normalizedEntryType || normalizedEntryType === "*" || normalizedEntryType === normalizedDebugType;
}
function callDebugTrackerHook(trackers, hookName, ...args) {
  for (const tracker of trackers || []) {
    const hook = tracker?.[hookName];
    if (typeof hook !== "function") continue;
    try {
      hook.apply(tracker, args);
    } catch {}
  }
}
const activeColorTheme = { kind: ColorThemeKind.Dark, backgroundColor: undefined, foregroundColor: undefined };
const activeTabGroupState = {
  activeTab: undefined,
  viewColumn: ViewColumn.One,
  tabs: [],
};
let activeNotebookEditorState = {
  notebook: { uri: Uri.file(""), cellCount: 0, getCells: () => [] },
  selection: new NotebookRange(0, 0),
  selections: [],
  visibleRanges: [],
};
let visibleNotebookEditorsState = [];
const onDidChangeTextEditorVisibleRangesEmitter = new EventEmitter();
let activeTextEditorState = makeTextEditor({ uri: Uri.file(""), fileName: "", languageId: "plaintext", getText: () => "" });
let visibleTextEditorsState = [];
function setActiveTab(input, label, viewColumn = ViewColumn.One) {
  const tab = { input, label, viewColumn, active: true };
  activeTabGroupState.activeTab = tab;
  activeTabGroupState.viewColumn = viewColumn;
  activeTabGroupState.tabs = [tab];
}
const mockGitRepository = {
  rootUri: Uri.file(""),
  state: {
    HEAD: undefined,
    refs: [],
    indexChanges: [],
    workingTreeChanges: [],
    mergeChanges: [],
    onDidChange: gitRepoStateEmitter.event,
  },
  inputBox: {
    value: "",
    placeholder: "",
    onDidChange: gitInputEmitter.event,
  },
  ui: { selected: false },
  status: async () => {},
  add: async () => {},
  commit: async () => {},
  checkout: async () => {},
  fetch: async () => {},
  pull: async () => {},
  push: async () => {},
};
const gitApi = {
  repositories: [mockGitRepository],
  onDidOpenRepository: gitRepositoryEmitter.event,
  onDidCloseRepository: new EventEmitter().event,
  onDidChangeState: gitStateEmitter.event,
  getRepository: () => mockGitRepository,
};

function makeWebviewBridge(viewId) {
  let _html = "";
  const inbound = new EventEmitter();
  webviewChannels.set(viewId, inbound);
  const webview = {
    get html() { return _html; },
    set html(value) {
      _html = String(value ?? "");
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
      return Uri.file(fsPath);
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
const onDidChangeActiveTextEditorEmitter = new EventEmitter();
const onDidChangeVisibleTextEditorsEmitter = new EventEmitter();
let _clipboardText = "";
const onDidOpenNotebookDocumentEmitter = new EventEmitter();
const onDidCloseNotebookDocumentEmitter = new EventEmitter();
const onDidChangeNotebookDocumentEmitter = new EventEmitter();
const onDidChangeConfigurationEmitter = new EventEmitter();
const onDidRenameFilesEmitter = new EventEmitter();
const onDidDeleteFilesEmitter = new EventEmitter();
const onWillSaveTextDocumentEmitter = new EventEmitter();
const onDidCreateFilesEmitter = new EventEmitter();
const onWillCreateFilesEmitter = new EventEmitter();
const onWillRenameFilesEmitter = new EventEmitter();
const onWillDeleteFilesEmitter = new EventEmitter();
const textDocuments = [];
const authSessionsEmitter = new EventEmitter();
const authProviders = new Map();

function resolveGithubToken() {
  const keys = [
    "ATHVA_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
  ];
  for (const key of keys) {
    const val = process.env[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return "";
}

function makeGithubSession() {
  const token = resolveGithubToken();
  if (!token) return undefined;
  return {
    id: "athva-github-session",
    accessToken: token,
    account: { id: "athva-user", label: "Athva GitHub" },
    scopes: ["read:user", "user:email", "repo", "copilot"],
  };
}

function getGithubAccount() {
  const session = makeGithubSession();
  return session ? session.account : undefined;
}

function _getConfigValue(section, key) {
  // Check explicit config first, then schema defaults
  const sectionData = section ? (_configuration[section] || {}) : _configuration;
  if (key in sectionData) return sectionData[key];
  // Try flattened schema default: "section.key"
  const flatKey = section ? `${section}.${key}` : key;
  if (flatKey in _schemaDefaults) return _schemaDefaults[flatKey];
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
  onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
  onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
  onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
  onDidChangeTextDocument: onDidChangeTextDocumentEmitter.event,
  onDidOpenNotebookDocument: onDidOpenNotebookDocumentEmitter.event,
  onDidCloseNotebookDocument: onDidCloseNotebookDocumentEmitter.event,
  onDidChangeNotebookDocument: onDidChangeNotebookDocumentEmitter.event,
  onDidSaveNotebookDocument: notebookSaveEmitter.event,
  onDidGrantWorkspaceTrust: new EventEmitter().event,
  onDidRenameFiles: onDidRenameFilesEmitter.event,
  onDidDeleteFiles: onDidDeleteFilesEmitter.event,
  onWillSaveTextDocument: onWillSaveTextDocumentEmitter.event,
  onDidCreateFiles: onDidCreateFilesEmitter.event,
  onWillCreateFiles: onWillCreateFilesEmitter.event,
  onWillRenameFiles: onWillRenameFilesEmitter.event,
  onWillDeleteFiles: onWillDeleteFilesEmitter.event,

  getConfiguration(section) {
    const sectionData = section ? (_configuration[section] || {}) : _configuration;
    const configTree = buildConfigTree(section);
    const api = {
      get(key, defaultValue) {
        if (!section && typeof key === "string" && key in configTree) {
          return configTree[key];
        }
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
    return new Proxy(api, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === "symbol") return undefined;
        const key = String(prop);
        if (key in configTree) return configTree[key];
        return section ? undefined : findDeepLeafValue(configTree, key);
      },
      has(target, prop) {
        if (prop in target) return true;
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
  registerPortAttributesProvider(provider) {
    if (provider) portAttributesProviders.push(provider);
    return new Disposable(() => {
      const index = portAttributesProviders.indexOf(provider);
      if (index >= 0) portAttributesProviders.splice(index, 1);
    });
  },
  showWorkspaceFolderPick() { return Promise.resolve(_workspaceFolders[0]); },
  asRelativePath(pathOrUri, includeWorkspaceFolder) {
    const inputPath = typeof pathOrUri === "string"
      ? pathOrUri
      : (pathOrUri?.fsPath || pathOrUri?.path || String(pathOrUri || ""));
    if (!inputPath) return "";
    for (const folder of _workspaceFolders) {
      const root = folder?.uri?.fsPath;
      if (!root) continue;
      const rel = path.relative(root, inputPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        const out = toPosix(rel || path.basename(inputPath));
        return includeWorkspaceFolder ? `${folder.name}/${out}` : out;
      }
    }
    return toPosix(path.basename(inputPath) || inputPath);
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
    const includePattern = normalizeGlobPattern(include);
    const excludePattern = exclude ? normalizeGlobPattern(exclude) : "";
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

  findFiles2(includes, options) {
    const patterns = Array.isArray(includes) ? includes : [includes];
    const limit = Number.isFinite(Number(options?.maxResults)) && Number(options?.maxResults) > 0
      ? Number(options?.maxResults) : 10_000;
    const excludePatterns = Array.isArray(options?.exclude)
      ? options.exclude.map(normalizeGlobPattern).filter(Boolean)
      : options?.exclude
        ? [normalizeGlobPattern(options.exclude)]
        : [];
    const results = [];
    const seen = new Set();

    for (const folder of _workspaceFolders) {
      const root = folder?.uri?.fsPath;
      if (!root || !fs.existsSync(root)) continue;
      walkFiles(root, (filePath) => {
        if (results.length >= limit) return false;
        const rel = toPosix(path.relative(root, filePath));
        const matchesInclude = patterns.some(p => globMatch(rel, normalizeGlobPattern(p)));
        if (!matchesInclude) return true;
        if (excludePatterns.some(ex => globMatch(rel, ex))) return true;
        if (seen.has(filePath)) return true;
        seen.add(filePath);
        results.push(Uri.file(filePath));
        return true;
      });
      if (results.length >= limit) break;
    }
    return Promise.resolve(results);
  },

  findTextInFiles(query, options = {}, callback) {
    const search = normalizeTextSearchQuery(query);
    if (!search) return Promise.resolve([]);

    const includePattern = normalizeGlobPattern(options.include || "**/*");
    const excludePattern = options.exclude ? normalizeGlobPattern(options.exclude) : "";
    const limit = Number.isFinite(Number(options.maxResults)) && Number(options.maxResults) > 0
      ? Number(options.maxResults) : 1_000;
    const results = [];
    const seen = new Set();
    const onResult = typeof callback === "function" ? callback : null;

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

        let content = "";
        try {
          content = fs.readFileSync(filePath, "utf8");
        } catch {
          return true;
        }

        for (const match of searchTextContent(content, search)) {
          if (results.length >= limit) return false;
          const result = {
            uri: Uri.file(filePath),
            ranges: [new Range(match.line, match.startCharacter, match.line, match.endCharacter)],
            preview: {
              text: match.lineText,
              matches: [new Range(0, match.startCharacter, 0, match.endCharacter)],
            },
          };
          results.push(result);
          if (onResult) {
            try { onResult(result); } catch {}
          }
        }
        return true;
      });
      if (results.length >= limit) break;
    }

    return Promise.resolve(onResult ? undefined : results);
  },

  openTextDocument(pathOrUri) {
    const input = createTextDocumentInput(pathOrUri);
    const hasContent = input && ("content" in input || "language" in input || "languageId" in input);
    if (hasContent) {
      const uriInput = input.uri;
      const uri = uriInput && typeof uriInput === "object"
        ? (uriInput.scheme ? Uri.from(uriInput) : Uri.file(uriInput.fsPath || uriInput.path || ""))
        : makeUntitledUri(input.languageId || input.language || "plaintext");
      const doc = new TextDocument(
        uri,
        String(input.content ?? ""),
        String(input.languageId || input.language || "plaintext"),
      );
      trackOpenTextDocument(doc);
      onDidOpenTextDocumentEmitter.fire(doc);
      return Promise.resolve(doc);
    }
    const uriInput = typeof pathOrUri === "string" ? Uri.parse(pathOrUri) : pathOrUri;
    if (uriInput?.scheme && uriInput.scheme !== "file") {
      const provider = textDocumentContentProviders.get(uriInput.scheme);
      if (provider && typeof provider.provideTextDocumentContent === "function") {
        try {
          const value = provider.provideTextDocumentContent(uriInput, CancellationToken.None);
          return Promise.resolve(value && typeof value.then === "function"
            ? value.then((content) => {
                const doc = new TextDocument(uriInput, String(content ?? ""));
                trackOpenTextDocument(doc);
                onDidOpenTextDocumentEmitter.fire(doc);
                return doc;
              })
            : Promise.resolve().then(() => {
                const doc = new TextDocument(uriInput, String(value ?? ""));
                trackOpenTextDocument(doc);
                onDidOpenTextDocumentEmitter.fire(doc);
                return doc;
              }));
        } catch {}
      }
    }
    const fspath = typeof pathOrUri === "string" ? pathOrUri : pathOrUri?.fsPath ?? "";
    try {
      const content = fs.readFileSync(fspath, "utf8");
      const doc = new TextDocument(Uri.file(fspath), content);
      trackOpenTextDocument(doc);
      onDidOpenTextDocumentEmitter.fire(doc);
      return Promise.resolve(doc);
    } catch {
      return Promise.reject(new Error(`Cannot open ${fspath}`));
    }
  },
  openNotebookDocument(viewTypeOrUri, maybeUri) {
    const viewType = typeof viewTypeOrUri === "string" && maybeUri ? viewTypeOrUri : "jupyter-notebook";
    const uriInput = maybeUri || viewTypeOrUri;
    const uri = typeof uriInput === "string" ? Uri.parse(uriInput) : (uriInput || Uri.file(""));
    const serializer = notebookSerializers.get(String(viewType));
    if (serializer && typeof serializer.deserializeNotebook === "function") {
      try {
        const raw = uri?.fsPath ? fs.readFileSync(uri.fsPath) : Buffer.from("");
        const deserialized = serializer.deserializeNotebook(raw, CancellationToken.None);
        const applyNotebook = (data) => {
          const cells = Array.isArray(data?.cells) ? data.cells : [];
          const doc = {
            uri,
            notebookType: viewType,
            version: 1,
            isDirty: false,
            isClosed: false,
            metadata: data?.metadata || {},
            cellCount: cells.length,
            getCells: () => cells,
            save: () => Promise.resolve(true),
          };
          notebookDocuments.push(doc);
          notebookOpenEmitter.fire(doc);
          return Promise.resolve(doc);
        };
        return Promise.resolve(deserialized && typeof deserialized.then === "function" ? deserialized.then(applyNotebook) : applyNotebook(deserialized));
      } catch {}
    }
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
      content = applyTextEditsToContent(content, Array.isArray(batch.edits) ? batch.edits : []);
      try { fs.writeFileSync(uri.fsPath, content); } catch {}
      updateTrackedTextDocument(uri, content, { markDirty: false, fireChange: true, reason: TextDocumentChangeReason.Manual });
    }
    return Promise.resolve(true);
  },

  createFileSystemWatcher(pattern) {
    const e = new EventEmitter();
    return ensureDisposable({ onDidCreate: e.event, onDidChange: e.event, onDidDelete: e.event, dispose: () => {} });
  },

  registerTextDocumentContentProvider(scheme, provider) {
    if (typeof scheme !== "string" || !scheme) return new Disposable(() => {});
    textDocumentContentProviders.set(scheme, provider);
    return new Disposable(() => textDocumentContentProviders.delete(scheme));
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
      try {
        const stat = require("fs").statSync(uri.fsPath);
        if (stat.isDirectory()) {
          require("fs").rmSync(uri.fsPath, { recursive: true, force: true });
        } else {
          require("fs").unlinkSync(uri.fsPath);
        }
      } catch {}
      return Promise.resolve();
    },
    rename: (oldUri, newUri, _options) => {
      try { require("fs").renameSync(oldUri.fsPath, newUri.fsPath); } catch {}
      return Promise.resolve();
    },
    copy: (source, destination, _options) => {
      try { require("fs").copyFileSync(source.fsPath, destination.fsPath); } catch {}
      return Promise.resolve();
    },
    isWritableFileSystem: () => true,
  },
};

// ── window ────────────────────────────────────────────────────────────────────

const window = {
  state: { focused: true, active: true },
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
  registerTreeDataProvider(viewId, provider) {
    return window.createTreeView(viewId, { treeDataProvider: provider });
  },

  createStatusBarItem(alignmentOrId, priority) {
    const isAlignment = alignmentOrId === StatusBarAlignment.Left || alignmentOrId === StatusBarAlignment.Right;
    return ensureDisposable({
      text: "", tooltip: "", command: undefined, color: undefined, backgroundColor: undefined,
      alignment: isAlignment ? alignmentOrId : StatusBarAlignment.Left, priority: Number(priority) || 0,
      show() {}, hide() {}, dispose() {},
    });
  },

  showInformationMessage(message, ...items) { send({ type: "notification", level: "info", message: String(message ?? "") }); return Promise.resolve(items[0]); },
  showWarningMessage(message, ...items) { send({ type: "notification", level: "warning", message: String(message ?? "") }); return Promise.resolve(items[0]); },
  showErrorMessage(message, ...items) { send({ type: "notification", level: "error", message: String(message ?? "") }); return Promise.resolve(items[0]); },
  showWorkspaceFolderPick() { return Promise.resolve(_workspaceFolders[0]); },

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
      trace(text) { log("trace", text); },
      debug(text) { log("debug", text); },
      info(text) { log("info", text); },
      warn(text) { log("warn", text); },
      error(text) { log("error", text); },
    });
  },

  createWebviewPanel(viewType, title, column, options) {
    const bridge = makeWebviewBridge(String(viewType || "panel"));
    setActiveTab(new TabInputCustom(Uri.file("")), title || viewType || "panel", typeof column === "number" ? column : ViewColumn.One);
    return ensureDisposable({
      webview: bridge.webview,
      title, viewType, active: false, visible: false,
      onDidChangeViewState: new EventEmitter().event,
      onDidDispose: new EventEmitter().event,
      reveal() {}, dispose() { bridge.dispose(); },
    });
  },

  registerWebviewPanelSerializer(_viewType, _serializer) {
    webviewPanelSerializers.set(String(_viewType), _serializer);
    return new Disposable(() => webviewPanelSerializers.delete(String(_viewType)));
  },

  registerUriHandler(_handler) {
    if (_handler) uriHandlers.add(_handler);
    return new Disposable(() => {
      if (_handler) uriHandlers.delete(_handler);
    });
  },

  createTextEditorDecorationType() { return ensureDisposable({ dispose() {} }); },
  withProgress(options, task) { return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event }); },
  showQuickPick: (items, options) => {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return Promise.resolve(undefined);
    if (options?.canPickMany) return Promise.resolve([list[0]]);
    return Promise.resolve(list[0]);
  },
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
  showInputBox: (options = {}) => {
    const defaultValue = typeof options.value === "string"
      ? options.value
      : typeof options.placeholder === "string"
        ? options.placeholder
        : "";
    return Promise.resolve(defaultValue);
  },
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
    window.visibleTextEditors = [editor];
    setActiveTab(new TabInputText(editor.document.uri), editor.document.fileName || path.basename(editor.document.uri?.fsPath || "") || "Untitled", ViewColumn.One);
    return editor;
  },
  get activeTextEditor() { return activeTextEditorState; },
  set activeTextEditor(editor) {
    activeTextEditorState = editor || null;
    onDidChangeActiveTextEditorEmitter.fire(activeTextEditorState);
  },
  get visibleTextEditors() { return visibleTextEditorsState.slice(); },
  set visibleTextEditors(editors) {
    visibleTextEditorsState = Array.isArray(editors) ? editors.filter(Boolean) : [];
    onDidChangeVisibleTextEditorsEmitter.fire(visibleTextEditorsState.slice());
  },
  onDidChangeActiveTextEditor: onDidChangeActiveTextEditorEmitter.event,
  onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditorsEmitter.event,
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
  showNotebookDocument: async (notebookOrUri, _options) => {
    const document = notebookOrUri?.notebookType
      ? notebookOrUri
      : await workspace.openNotebookDocument(notebookOrUri);
    const editor = { notebook: document, selection: new NotebookRange(0, 0), selections: [], visibleRanges: [] };
    window.activeNotebookEditor = editor;
    window.visibleNotebookEditors = [editor];
    activeNotebookEditorEmitter.fire(editor);
    visibleNotebookEditorsEmitter.fire(window.visibleNotebookEditors);
    setActiveTab(new TabInputNotebook(document.uri), document.uri?.fsPath ? path.basename(document.uri.fsPath) : "Notebook", ViewColumn.One);
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
  registerCustomEditorProvider(viewType, provider) {
    const entry = { viewType, provider };
    customEditorProviders.set(String(viewType), entry);
    return new Disposable(() => {
      const current = customEditorProviders.get(String(viewType));
      if (current === entry) customEditorProviders.delete(String(viewType));
    });
  },
  createChatStatusItem: () => ensureDisposable({ text: "", tooltip: "", command: undefined, show() {}, hide() {}, dispose() {} }),
  createTerminal(optionsOrName) {
    const processId = terminals.length + 1;
    const requestedName = typeof optionsOrName === "string" ? optionsOrName : (optionsOrName?.name || "Terminal");
    const profile = terminalProfileProviders.length > 0
      ? terminalProfileProviders
          .map((provider) => {
            try {
              if (provider && typeof provider.provideTerminalProfile === "function") {
                return provider.provideTerminalProfile(CancellationToken.None);
              }
            } catch {}
            return undefined;
          })
          .find((value) => value)
      : undefined;
    const terminal = {
      name: profile?.name || requestedName,
      processId,
      creationOptions: profile || (typeof optionsOrName === "object" ? optionsOrName : { name: String(optionsOrName || "Terminal") }),
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
    return ensureDisposable(terminal);
  },
  registerTerminalLinkProvider(_provider) {
    terminalLinkProviders.push(_provider);
    return new Disposable(() => {
      const index = terminalLinkProviders.indexOf(_provider);
      if (index >= 0) terminalLinkProviders.splice(index, 1);
    });
  },
  registerTerminalProfileProvider(_id, provider) {
    terminalProfileProviders.push(provider);
    return new Disposable(() => {
      const index = terminalProfileProviders.indexOf(provider);
      if (index >= 0) terminalProfileProviders.splice(index, 1);
    });
  },
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
  async executeCommand(id, ...args) {
    const handler = registeredCommands.get(id);
    if (handler) return handler(...args);
    if (id === "git.api.getAPI") return gitApi;
    if (id === "git.repositories") return [];
    if (id === "git.state") return { repositories: [] };
    if (id === "vscode.open") {
      const uri = args[0];
      if (uri) {
        try { await window.showTextDocument(uri); } catch {}
      }
      return true;
    }
    if (id === "vscode.openFolder" || id === "vscode.diff") return true;
    if (id === "vscode.executeCompletionItemProvider") return executeCompletionItemProvider(args[0], args[1], args[2], args[3]);
    if (id === "vscode.executeHoverProvider") return executeHoverProvider(args[0], args[1]);
    if (id === "vscode.executeInlineCompletionItemProvider") return executeInlineCompletionItemProvider(args[0], args[1], args[2]);
    if (id === "vscode.executeCodeLensProvider") return executeCodeLensProvider(args[0]);
    if (id === "vscode.executeDefinitionProvider") return executeLocationProvider(languages._definitionProviders, "provideDefinition", args[0], args[1]);
    if (id === "vscode.executeTypeDefinitionProvider") return executeLocationProvider(languages._typeDefinitionProviders, "provideTypeDefinition", args[0], args[1]);
    if (id === "vscode.executeImplementationProvider") return executeLocationProvider(languages._implementationProviders, "provideImplementation", args[0], args[1]);
    if (id === "vscode.executeDeclarationProvider") return executeLocationProvider(languages._declarationProviders, "provideDeclaration", args[0], args[1]);
    if (id === "vscode.executeReferenceProvider") return executeReferenceProvider(args[0], args[1], args[2]);
    if (id === "vscode.executeWorkspaceSymbolProvider") return executeWorkspaceSymbolProvider(args[0] || "");
    if (id === "vscode.executeDocumentSymbolProvider") return executeDocumentSymbolProvider(args[0]);
    if (id === "vscode.executeCodeActionProvider") return executeCodeActionProvider(args[0], args[1], args[2]);
    if (id === "vscode.executeNotebookVariableProvider") return [];
    if (id === "vscode.executeSignatureHelpProvider") return executeSignatureHelpProvider(args[0], args[1], args[2]);
    if (id === "vscode.executeDocumentFormattingEditProvider") return executeFormattingProvider(languages._documentFormattingProviders, "provideDocumentFormattingEdits", args[0]);
    if (id === "vscode.executeDocumentRangeFormattingEditProvider") return executeFormattingProvider(languages._documentRangeFormattingProviders, "provideDocumentRangeFormattingEdits", args[0], args[1]);
    if (id === "vscode.executeDocumentHighlightProvider") return executeDocumentHighlightProvider(args[0], args[1]);
    if (id === "vscode.executeDocumentLinkProvider") return executeDocumentLinkProvider(args[0]);
    if (id === "vscode.executeSelectionRangeProvider") return executeSelectionRangeProvider(args[0], args[1]);
    if (id === "vscode.executeInlayHintProvider") return executeInlayHintProvider(args[0], args[1]);
    if (id === "vscode.executeFoldingRangeProvider") return executeFoldingRangeProvider(args[0]);
    if (id === "vscode.executeDocumentSemanticTokensProvider") return executeFirstRegisteredProvider(languages._documentSemanticTokensProviders, "provideDocumentSemanticTokens", args[0], args[1]);
    if (id === "vscode.executeDocumentRangeSemanticTokensProvider") return executeFirstRegisteredProvider(languages._documentRangeSemanticTokensProviders, "provideDocumentRangeSemanticTokens", args[0], args[1]);
    if (id === "vscode.executeDocumentColorProvider") return executeFirstRegisteredProvider(languages._documentColorProviders, "provideDocumentColors", args[0]);
    if (id === "vscode.executeLinkedEditingRangeProvider") return executeFirstRegisteredProvider(languages._linkedEditingRangeProviders, "provideLinkedEditingRanges", args[0], args[1]);
    if (id === "vscode.provideCallHierarchyItems" || id === "vscode.executeCallHierarchyProvider") return executeCallHierarchyProvider(args[0], args[1]);
    if (id === "vscode.provideTypeHierarchyItems" || id === "vscode.executeTypeHierarchyProvider") return executeTypeHierarchyProvider(args[0], args[1]);
    if (id === "vscode.executeInlineValuesProvider") return executeInlineValuesProvider(args[0], args[1]);
    if (id === "vscode.testing.getControllersWithTests" || id === "vscode.testing.getTestsInFile") {
      return [];
    }
    if (id === "vscode.openWith") {
      const uri = args[0];
      const viewType = typeof args[1] === "string" ? args[1] : "";
      const customEditor = viewType ? customEditorProviders.get(viewType) : undefined;
      if (uri && customEditor) {
        try {
          const document = await workspace.openTextDocument(uri);
          const panel = window.createWebviewPanel(viewType, viewType, ViewColumn.One, { enableScripts: true });
          const provider = customEditor.provider;
          if (provider) {
            if (typeof provider.resolveCustomTextEditor === "function") {
              await provider.resolveCustomTextEditor(document, panel, { backups: [] }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event });
            } else if (typeof provider.resolveCustomEditor === "function") {
              await provider.resolveCustomEditor(document, panel, { backups: [] }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event });
            }
          }
        } catch {}
        return true;
      }
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
  _completionProviders: new Set(),
  _codeActionProviders: new Set(),
  _hoverProviders: [],
  _definitionProviders: [],
  _typeDefinitionProviders: [],
  _implementationProviders: [],
  _declarationProviders: [],
  _referenceProviders: [],
  _documentSymbolProviders: [],
  _workspaceSymbolProviders: [],
  _codeLensProviders: [],
  _callHierarchyProviders: [],
  _typeHierarchyProviders: [],
  _renameProviders: [],
  _signatureHelpProviders: [],
  _foldingRangeProviders: [],
  _documentHighlightProviders: [],
  _documentLinkProviders: [],
  _selectionRangeProviders: [],
  _inlineValuesProviders: [],
  _documentFormattingProviders: [],
  _documentRangeFormattingProviders: [],
  _documentSemanticTokensProviders: [],
  _documentRangeSemanticTokensProviders: [],
  _documentColorProviders: [],
  _linkedEditingRangeProviders: [],
  _inlayHintProviders: [],
  _inlineCompletionProviders: [],
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
  registerTypeDefinitionProvider(_selector, provider) {
    languages._typeDefinitionProviders.push(provider);
    return new Disposable(() => {
      languages._typeDefinitionProviders = languages._typeDefinitionProviders.filter((item) => item !== provider);
    });
  },
  registerImplementationProvider(_selector, provider) {
    languages._implementationProviders.push(provider);
    return new Disposable(() => {
      languages._implementationProviders = languages._implementationProviders.filter((item) => item !== provider);
    });
  },
  registerDeclarationProvider(_selector, provider) {
    languages._declarationProviders.push(provider);
    return new Disposable(() => {
      languages._declarationProviders = languages._declarationProviders.filter((item) => item !== provider);
    });
  },
  registerCallHierarchyProvider(_selector, provider) {
    languages._callHierarchyProviders.push(provider);
    return new Disposable(() => {
      languages._callHierarchyProviders = languages._callHierarchyProviders.filter((item) => item !== provider);
    });
  },
  registerInlineValuesProvider(_selector, provider) {
    languages._inlineValuesProviders.push(provider);
    return new Disposable(() => {
      languages._inlineValuesProviders = languages._inlineValuesProviders.filter((item) => item !== provider);
    });
  },
  registerLinkedEditingRangeProvider(_selector, provider) {
    languages._linkedEditingRangeProviders.push(provider);
    return new Disposable(() => {
      languages._linkedEditingRangeProviders = languages._linkedEditingRangeProviders.filter((item) => item !== provider);
    });
  },
  registerTypeHierarchyProvider(_selector, provider) {
    languages._typeHierarchyProviders.push(provider);
    return new Disposable(() => {
      languages._typeHierarchyProviders = languages._typeHierarchyProviders.filter((item) => item !== provider);
    });
  },
  setTextDocumentLanguage: async (document, languageId) => {
    if (document && typeof document === "object") document.languageId = languageId;
    return document;
  },
  createLanguageStatusItem(id, _selector) {
    const emitter = new EventEmitter();
    const item = ensureDisposable({
      id, text: "", detail: "", severity: 0, command: undefined, busy: false,
      onDidDispose: emitter.event,
      dispose() { emitter.fire(); },
    });
    return item;
  },
  registerHoverProvider(_selector, provider) {
    languages._hoverProviders.push(provider);
    return new Disposable(() => {
      languages._hoverProviders = languages._hoverProviders.filter((item) => item !== provider);
    });
  },
  registerCompletionItemProvider(_selector, provider) {
    languages._completionProviders.add(provider);
    return new Disposable(() => languages._completionProviders.delete(provider));
  },
  registerInlineCompletionItemProvider(_selector, provider) {
    languages._inlineCompletionProviders.push(provider);
    return new Disposable(() => {
      languages._inlineCompletionProviders = languages._inlineCompletionProviders.filter((item) => item !== provider);
    });
  },
  registerDefinitionProvider(_selector, provider) {
    languages._definitionProviders.push(provider);
    return new Disposable(() => {
      languages._definitionProviders = languages._definitionProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentHighlightProvider(_selector, provider) {
    languages._documentHighlightProviders.push(provider);
    return new Disposable(() => {
      languages._documentHighlightProviders = languages._documentHighlightProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentLinkProvider(_selector, provider) {
    languages._documentLinkProviders.push(provider);
    return new Disposable(() => {
      languages._documentLinkProviders = languages._documentLinkProviders.filter((item) => item !== provider);
    });
  },
  registerSelectionRangeProvider(_selector, provider) {
    languages._selectionRangeProviders.push(provider);
    return new Disposable(() => {
      languages._selectionRangeProviders = languages._selectionRangeProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentRangeFormattingEditProvider(_selector, provider) {
    languages._documentRangeFormattingProviders.push(provider);
    return new Disposable(() => {
      languages._documentRangeFormattingProviders = languages._documentRangeFormattingProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentRangeSemanticTokensProvider(_selector, provider) {
    languages._documentRangeSemanticTokensProviders.push(provider);
    return new Disposable(() => {
      languages._documentRangeSemanticTokensProviders = languages._documentRangeSemanticTokensProviders.filter((item) => item !== provider);
    });
  },
  registerColorPresentationProvider(_selector, provider) {
    languages._documentColorProviders.push(provider);
    return new Disposable(() => {
      languages._documentColorProviders = languages._documentColorProviders.filter((item) => item !== provider);
    });
  },
  registerOnTypeFormattingEditProvider(_selector, provider) {
    languages._documentRangeFormattingProviders.push(provider);
    return new Disposable(() => {
      languages._documentRangeFormattingProviders = languages._documentRangeFormattingProviders.filter((item) => item !== provider);
    });
  },
  registerCodeActionsProvider(_selector, provider) {
    languages._codeActionProviders.add(provider);
    return new Disposable(() => languages._codeActionProviders.delete(provider));
  },
  registerCodeActionProvider(_selector, provider, metadata) {
    return languages.registerCodeActionsProvider(_selector, provider, metadata);
  },
  registerWorkspaceSymbolProvider(_selector, provider) {
    languages._workspaceSymbolProviders.push(provider);
    return new Disposable(() => {
      languages._workspaceSymbolProviders = languages._workspaceSymbolProviders.filter((item) => item !== provider);
    });
  },
  registerCodeLensProvider(_selector, provider) {
    languages._codeLensProviders.push(provider);
    return new Disposable(() => {
      languages._codeLensProviders = languages._codeLensProviders.filter((item) => item !== provider);
    });
  },
  registerReferenceProvider(_selector, provider) {
    languages._referenceProviders.push(provider);
    return new Disposable(() => {
      languages._referenceProviders = languages._referenceProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentSymbolProvider(_selector, provider) {
    languages._documentSymbolProviders.push(provider);
    return new Disposable(() => {
      languages._documentSymbolProviders = languages._documentSymbolProviders.filter((item) => item !== provider);
    });
  },
  registerRenameProvider(_selector, provider) {
    languages._renameProviders.push(provider);
    return new Disposable(() => {
      languages._renameProviders = languages._renameProviders.filter((item) => item !== provider);
    });
  },
  registerSignatureHelpProvider(_selector, provider) {
    languages._signatureHelpProviders.push(provider);
    return new Disposable(() => {
      languages._signatureHelpProviders = languages._signatureHelpProviders.filter((item) => item !== provider);
    });
  },
  registerInlayHintsProvider(_selector, provider) {
    languages._inlayHintProviders.push(provider);
    return new Disposable(() => {
      languages._inlayHintProviders = languages._inlayHintProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentSemanticTokensProvider(_selector, provider) {
    languages._documentSemanticTokensProviders.push(provider);
    return new Disposable(() => {
      languages._documentSemanticTokensProviders = languages._documentSemanticTokensProviders.filter((item) => item !== provider);
    });
  },
  registerLinkedEditingRangeProvider(_selector, provider) {
    languages._linkedEditingRangeProviders.push(provider);
    return new Disposable(() => {
      languages._linkedEditingRangeProviders = languages._linkedEditingRangeProviders.filter((item) => item !== provider);
    });
  },
  registerColorProvider(_selector, provider) {
    languages._documentColorProviders.push(provider);
    return new Disposable(() => {
      languages._documentColorProviders = languages._documentColorProviders.filter((item) => item !== provider);
    });
  },
  registerDocumentFormattingEditProvider(_selector, provider) {
    languages._documentFormattingProviders.push(provider);
    return new Disposable(() => {
      languages._documentFormattingProviders = languages._documentFormattingProviders.filter((item) => item !== provider);
    });
  },
  registerFoldingRangeProvider(_selector, provider) {
    languages._foldingRangeProviders.push(provider);
    return new Disposable(() => {
      languages._foldingRangeProviders = languages._foldingRangeProviders.filter((item) => item !== provider);
    });
  },
  onDidChangeDiagnostics: new EventEmitter().event,
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
    const provider = arguments[0];
    if (provider) notebookCellStatusBarItemProviders.push(provider);
    return new Disposable(() => {
      const index = notebookCellStatusBarItemProviders.indexOf(provider);
      if (index >= 0) notebookCellStatusBarItemProviders.splice(index, 1);
    });
  },
  createNotebookControllerDetectionTask() {
    return ensureDisposable({
      dispose() {},
    });
  },
  registerKernelSourceActionProvider() {
    const provider = arguments[0];
    if (provider) kernelSourceActionProviders.push(provider);
    return new Disposable(() => {
      const index = kernelSourceActionProviders.indexOf(provider);
      if (index >= 0) kernelSourceActionProviders.splice(index, 1);
    });
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

const authentication = {
  onDidChangeSessions: authSessionsEmitter.event,
  async getSession(providerId, scopes, options) {
    const provider = authProviders.get(providerId);
    if (provider && typeof provider.getSessions === "function") {
      try {
        const sessions = await provider.getSessions(Array.isArray(scopes) ? scopes : []);
        if (Array.isArray(sessions) && sessions.length > 0) return sessions[0];
      } catch {}
    }
    if (providerId !== "github") return undefined;
    const session = makeGithubSession();
    if (session) return session;
    if (options?.createIfNone) {
      send({
        type: "notification",
        level: "warning",
        message: "GitHub auth required. Set ATHVA_GITHUB_TOKEN (or GITHUB_TOKEN) and restart Athva.",
      });
    }
    return undefined;
  },
  getAccounts(providerId) {
    if (providerId === "github") {
      const account = getGithubAccount();
      return Promise.resolve(account ? [account] : []);
    }
    const provider = authProviders.get(providerId);
    if (provider && typeof provider.getSessions === "function") {
      return Promise.resolve()
        .then(() => provider.getSessions([]))
        .then((sessions) => {
          if (!Array.isArray(sessions)) return [];
          const seen = new Set();
          const accounts = [];
          for (const session of sessions) {
            const account = session?.account;
            if (!account?.id || seen.has(account.id)) continue;
            seen.add(account.id);
            accounts.push(account);
          }
          return accounts;
        })
        .catch(() => []);
    }
    return Promise.resolve([]);
  },
  registerAuthenticationProvider(id, _label, provider) {
    if (id && provider && typeof provider === "object") authProviders.set(id, provider);
    return new Disposable(() => {
      if (id) authProviders.delete(id);
    });
  },
};

const tasks = {
  _providers: [],
  async fetchTasks() {
    const results = [];
    for (const entry of tasks._providers) {
      const provider = entry?.provider;
      if (!provider || typeof provider.provideTasks !== "function") continue;
      try {
        const value = await provider.provideTasks();
        if (Array.isArray(value)) results.push(...value);
      } catch {}
    }
    return results;
  },
  async executeTask(task) {
    const execution = {
      task,
      terminate() {
        tasks.onDidEndTaskEmitter.fire({ task });
        return Promise.resolve();
      },
      dispose() {
        tasks.onDidEndTaskEmitter.fire({ task });
      },
    };
    tasks.onDidStartTaskEmitter.fire({ task });
    tasks.onDidStartTaskProcessEmitter.fire({ task, processId: 1 });
    return execution;
  },
  registerTaskProvider(type, provider) {
    const entry = { type, provider };
    tasks._providers.push(entry);
    return new Disposable(() => {
      tasks._providers = tasks._providers.filter((item) => item !== entry);
    });
  },
  onDidStartTaskEmitter: new EventEmitter(),
  onDidEndTaskEmitter: new EventEmitter(),
  onDidStartTaskProcessEmitter: new EventEmitter(),
  onDidEndTaskProcessEmitter: new EventEmitter(),
  onDidStartTask: null,
  onDidEndTask: null,
  onDidStartTaskProcess: null,
  onDidEndTaskProcess: null,
};
tasks.onDidStartTask = tasks.onDidStartTaskEmitter.event;
tasks.onDidEndTask = tasks.onDidEndTaskEmitter.event;
tasks.onDidStartTaskProcess = tasks.onDidStartTaskProcessEmitter.event;
tasks.onDidEndTaskProcess = tasks.onDidEndTaskProcessEmitter.event;

const debugStartSessionEmitter = new EventEmitter();
const debugTerminateSessionEmitter = new EventEmitter();
const terminalLinkProviders = [];
const terminalProfileProviders = [];

const scmSourceControls = new Map();
const scm = {
  sourceControls: [],
  onDidChangeSelectedSourceControl: new EventEmitter().event,
  createSourceControl(id, label, rootUri) {
    const resourceGroups = new Map();
    const controller = ensureDisposable({
      id,
      label,
      rootUri,
      count: 0,
      commitTemplate: "",
      quickDiffProvider: undefined,
      inputBox: {
        value: "",
        placeholder: "",
        prompt: "",
        enabled: true,
        visible: true,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        validateInput: undefined,
      },
      statusBarCommands: [],
      selected: false,
      createResourceGroup(groupId, groupLabel) {
        const group = ensureDisposable({
          id: groupId,
          label: groupLabel,
          resourceStates: [],
          hideWhenEmpty: false,
          resourceStateCount: 0,
          dispose() { resourceGroups.delete(String(groupId)); },
        });
        resourceGroups.set(String(groupId), group);
        return group;
      },
      dispose() {
        resourceGroups.clear();
        scmSourceControls.delete(String(id));
        scm.sourceControls = scm.sourceControls.filter((item) => item !== controller);
      },
    });
    scmSourceControls.set(String(id), controller);
    scm.sourceControls.push(controller);
    return controller;
  },
};

const comments = {
  controllers: [],
  onDidChangeCommentingRanges: new EventEmitter().event,
  createCommentController(id, label) {
    const threads = new Map();
    const controller = ensureDisposable({
      id,
      label,
      commentingRangeProvider: undefined,
      options: {},
      threads: [],
      createCommentThread(uri, range, commentsList = []) {
        const thread = ensureDisposable({
          uri,
          range,
          comments: Array.isArray(commentsList) ? commentsList : [],
          label: undefined,
          collapsibleState: 0,
          canReply: true,
          contextValue: undefined,
          inputBox: undefined,
          state: 0,
          dispose() {
            threads.delete(String(thread.label || thread.range?.toString?.() || threads.size));
          },
        });
        threads.set(String(thread.label || thread.range?.toString?.() || threads.size), thread);
        controller.threads.push(thread);
        return thread;
      },
      dispose() {
        threads.clear();
        comments.controllers = comments.controllers.filter((item) => item !== controller);
      },
    });
    comments.controllers.push(controller);
    return controller;
  },
};

const tests = {
  testResults: [],
  onDidChangeTestResults: new EventEmitter().event,
  createTestController(id, label) {
    const emitter = new EventEmitter();
    const controller = ensureDisposable({
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
      createRunProfile() { return ensureDisposable({ dispose() {} }); },
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
      dispose() { emitter.fire(); },
    });
    return controller;
  },
  createTestMessage(message, expected, actual) {
    return new TestMessage(message, expected, actual);
  },
};

const debug = {
  async startDebugging(folder, nameOrConfiguration, options) {
    let configuration = typeof nameOrConfiguration === "object" && nameOrConfiguration ? { ...nameOrConfiguration } : undefined;
    const debugType = configuration?.type || (typeof nameOrConfiguration === "string" ? nameOrConfiguration : "");
    const providers = debugConfigurationProviders.get(String(debugType)) || [];
    for (const provider of providers) {
      try {
        if (!configuration && typeof provider.provideDebugConfigurations === "function") {
          const provided = await provider.provideDebugConfigurations(folder, undefined);
          if (Array.isArray(provided) && provided.length) configuration = { ...provided[0] };
        }
        if (configuration && typeof provider.resolveDebugConfiguration === "function") {
          const resolved = await provider.resolveDebugConfiguration(folder, configuration, options);
          if (resolved) configuration = { ...resolved };
        }
      } catch {}
    }
    if (!configuration) configuration = { type: String(debugType || "debug"), name: String(nameOrConfiguration || "Launch") };
    const sessionDescriptorState = {
      descriptor: undefined,
      trackers: [],
    };
    const session = {
      name: String(configuration.name || "Launch"),
      id: `debug-session-${Math.random().toString(36).slice(2)}`,
      type: String(configuration.type || debugType || "debug"),
      parentSession: undefined,
      configuration,
      _adapterState: sessionDescriptorState,
    };
    for (const entry of debugAdapterDescriptorFactories) {
      if (!matchesDebugType(entry.type, session.type)) continue;
      try {
        const descriptor = await entry.factory?.createDebugAdapterDescriptor?.(session, undefined);
        if (descriptor !== undefined) {
          sessionDescriptorState.descriptor = descriptor;
          break;
        }
      } catch {}
    }
    for (const entry of debugAdapterTrackerFactories) {
      if (!matchesDebugType(entry.type, session.type)) continue;
      try {
        const tracker = await entry.factory?.createDebugAdapterTracker?.(session);
        if (tracker) sessionDescriptorState.trackers.push(tracker);
      } catch {}
    }
    callDebugTrackerHook(sessionDescriptorState.trackers, "onWillStartSession");
    activeDebugSessionState = session;
    debugStartSessionEmitter.fire(session);
    callDebugTrackerHook(sessionDescriptorState.trackers, "onDidStartSession");
    activeDebugSessionEmitter.fire(session);
    return true;
  },
  async stopDebugging(session) {
    if (!activeDebugSessionState) return undefined;
    if (session && session.id && session.id !== activeDebugSessionState.id) return undefined;
    const ended = activeDebugSessionState;
    activeDebugSessionState = undefined;
    const trackers = ended?._adapterState?.trackers || [];
    callDebugTrackerHook(trackers, "onWillStopSession");
    callDebugTrackerHook(trackers, "onWillTerminateSession");
    debugTerminateSessionEmitter.fire(ended);
    callDebugTrackerHook(trackers, "onDidTerminateSession");
    for (const tracker of trackers) {
      try {
        if (typeof tracker?.dispose === "function") tracker.dispose();
      } catch {}
    }
    activeDebugSessionEmitter.fire(undefined);
    return undefined;
  },
  registerDebugConfigurationProvider(type, provider) {
    const entry = { type, provider };
    const key = String(type || "");
    const list = debugConfigurationProviders.get(key) || [];
    list.push(provider);
    debugConfigurationProviders.set(key, list);
    return new Disposable(() => {
      const current = debugConfigurationProviders.get(key) || [];
      const next = current.filter((item) => item !== provider);
      if (next.length) debugConfigurationProviders.set(key, next);
      else debugConfigurationProviders.delete(key);
    });
  },
  registerDebugAdapterDescriptorFactory(type, factory) {
    debugAdapterDescriptorFactories.push({ type, factory });
    return new Disposable(() => {
      const index = debugAdapterDescriptorFactories.findIndex((entry) => entry.factory === factory && entry.type === type);
      if (index >= 0) debugAdapterDescriptorFactories.splice(index, 1);
    });
  },
  registerDebugAdapterTrackerFactory(type, factory) {
    debugAdapterTrackerFactories.push({ type, factory });
    return new Disposable(() => {
      const index = debugAdapterTrackerFactories.findIndex((entry) => entry.factory === factory && entry.type === type);
      if (index >= 0) debugAdapterTrackerFactories.splice(index, 1);
    });
  },
  get activeDebugSession() { return activeDebugSessionState; },
  activeDebugConsole: { append() {}, appendLine() {}, clear() {}, show() {}, hide() {}, dispose() {} },
  breakpoints: [],
  onDidChangeBreakpoints: new EventEmitter().event,
  onDidStartDebugSession: debugStartSessionEmitter.event,
  onDidTerminateDebugSession: debugTerminateSessionEmitter.event,
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
  registerChatSessionItemProvider: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      enabled: true,
      isEnabled: true,
      onDidChangeEnablement: emitter.event,
      onDidChangeEnableStates: emitter.event,
      onDidChangeChatSessionItemState: emitter.event,
      dispose() {},
    });
  },
  registerChatSessionContentProvider: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      enabled: true,
      isEnabled: true,
      onDidChangeEnablement: emitter.event,
      onDidChangeEnableStates: emitter.event,
      dispose() {},
    });
  },
  registerChatSessionCustomizationProvider: () => {
    const emitter = new EventEmitter();
    return ensureDisposable({
      enabled: true,
      isEnabled: true,
      onDidChangeEnablement: emitter.event,
      onDidChangeEnableStates: emitter.event,
      dispose() {},
    });
  },
  getCustomAgents: async () => [],
};

const lmTools = [];
const mcpServerDefinitionsEmitter = new EventEmitter();
const mcpServerDefinitions = [];
const lmChatProviders = [];
const mcpServerDefinitionProviders = [];

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
  registerLanguageModelChatProvider(_id, provider) {
    lmChatProviders.push(provider);
    return new Disposable(() => {
      const index = lmChatProviders.indexOf(provider);
      if (index >= 0) lmChatProviders.splice(index, 1);
    });
  },
  registerMcpServerDefinitionProvider(_id, provider) {
    mcpServerDefinitionProviders.push(provider);
    return new Disposable(() => {
      const index = mcpServerDefinitionProviders.indexOf(provider);
      if (index >= 0) mcpServerDefinitionProviders.splice(index, 1);
    });
  },
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
    return ensureDisposable({
      isUsageEnabled: true,
      isErrorsEnabled: true,
      onDidChangeEnableStates: stateEmitter.event,
      onDidChangeEnablement: stateEmitter.event,
      logUsage() {},
      logError() {},
      dispose() {},
    });
  },
  remoteName: undefined,
  shell: process.env.SHELL || "/bin/zsh",
  openExternal: async (uri) => {
    const parsed = uri && typeof uri === "object" && typeof uri.scheme === "string"
      ? uri
      : Uri.parse(String(uri?.toString?.() ?? uri ?? ""));
    if (parsed?.scheme === env.uriScheme || parsed?.scheme === "vscode") {
      for (const handler of uriHandlers) {
        if (!handler || typeof handler.handleUri !== "function") continue;
        try {
          await handler.handleUri(parsed);
        } catch {}
      }
      return true;
    }
    send({ type: "openExternal", uri: parsed.toString() });
    return true;
  },
  clipboard: {
    readText: () => Promise.resolve(_clipboardText),
    writeText: (text) => { _clipboardText = String(text ?? ""); return Promise.resolve(); },
  },
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

// Report a VS Code-like version so extensions can gate behavior.
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
        getAPI: () => gitApi,
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
    if (id === "vscode.github-authentication") {
      const exports = {
        getSession: (...args) => authentication.getSession("github", ...(args || [])),
      };
      return ensureEnablementShape({
        id: "vscode.github-authentication",
        isActive: true,
        enabled: true,
        onDidChangeEnablement: new EventEmitter().event,
        exports,
        activate: () => Promise.resolve(exports),
        packageJSON: { name: "github-authentication", publisher: "vscode", version: "1.0.0" },
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

  if (msg.type === "terminalLink") {
    const uri = String(msg.uri || "");
    let handled = false;
    const token = CancellationToken.None;
    const syntheticTerminal = activeTerminal || { name: "", processId: 0, creationOptions: {}, state: {}, shellIntegration: {} };
    const context = {
      terminal: syntheticTerminal,
      line: uri,
      rawLine: uri,
    };
    for (const provider of terminalLinkProviders) {
      if (!provider) continue;
      try {
        if (typeof provider.provideTerminalLinks === "function") {
          const links = await provider.provideTerminalLinks(context, token);
          const list = Array.isArray(links) ? links : [];
          const match = list.find((link) => String(link?.text || "") === uri) || list[0];
          if (match && typeof provider.handleLink === "function") {
            await provider.handleLink(match);
            handled = true;
            break;
          }
          if (match) {
            handled = true;
            break;
          }
        } else if (typeof provider.handleLink === "function") {
          await provider.handleLink({ text: uri });
          handled = true;
          break;
        }
      } catch {}
    }
    send({ type: "terminalLinkResult", id: msg.id, handled });
  }

  if (msg.type === "webviewMessage") {
    const channel = webviewChannels.get(msg.viewId);
    if (channel) {
      try { channel.fire(msg.message); } catch {}
    }
  }
}

const vscodeApi = {
  __esModule: true,
  // value types
  Uri, RelativePattern, Range, Position, Selection, Location, Color, ColorInformation, ColorPresentation, ThemeIcon, ThemeColor, TreeItem, NotebookCellOutputItem, NotebookCellOutput, NotebookCellData, NotebookData, NotebookRange, NotebookCellKind, NotebookEdit, NotebookRendererScript, NotebookControllerAffinity, NotebookEditorRevealType,
  TabInputText, TabInputTextDiff, TabInputNotebook, TabInputNotebookDiff, TabInputCustom,
  LanguageModelChat, LanguageModelChatMessage, LanguageModelTextPart, LanguageModelTextPart2, LanguageModelDataPart, LanguageModelDataPart2, LanguageModelThinkingPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelToolResultPart2, LanguageModelToolResult, LanguageModelPromptTsxPart, LanguageModelError,
  ChatCompletionItem, ChatRequestTurn, ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseProgressPart, ChatResponseReferencePart, ChatResponseThinkingProgressPart, ChatResponseTurn, ChatResponseTurn2, ChatResponseWarningPart, ChatToolInvocationPart, ChatVariableLevel,
  CancellationTokenSource, CancellationToken, CancellationError, SnippetString, CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, TextEdit, WorkspaceEdit, CodeAction, CodeActionKind, CodeActionTriggerKind, CodeLens, DocumentLink, Diagnostic, DiagnosticTag, DiagnosticRelatedInformation,
  SymbolInformation, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem, InlayHint, InlayHintLabelPart,
  InlineCompletionList, InlineCompletionItem, InlineValueEvaluatableExpression, InlineValueText, InlineValueVariableLookup, LinkedEditingRanges, ParameterInformation, SelectionRange, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SignatureHelp, SignatureInformation, SignatureHelpTriggerKind, SymbolKind, SymbolTag, DebugAdapterInlineImplementation,
  TextDocument, TextEditor,
  TreeItemCollapsibleState, StatusBarAlignment, ViewColumn, UIKind, QuickPickItemKind, QuickInputButtons, LogLevel, TerminalProfile, TerminalLocation, TabInputInteractiveWindow,
  InlineCompletionEndOfLifeReasonKind, InlineCompletionsDisposeReasonKind, InlineCompletionDisplayLocationKind, InlineCompletionTriggerKind, DecorationRangeBehavior,
  ChatEditingSessionActionOutcome, TextDocumentSaveReason, TextEditorRevealType,
  DiagnosticSeverity, ColorThemeKind, ConfigurationTarget, ExtensionMode, FileType, EndOfLine, ExcludeSettingOptions, LanguageStatusSeverity, ProgressLocation, SettingsSearchResultKind, TextDocumentChangeReason, CompletionTriggerKind,
  ExtensionKind,
  DocumentHighlight, DocumentHighlightKind, DocumentSymbol, FoldingRange, FoldingRangeKind, Hover, PortAttributes, PortAutoForwardAction,
  FileSystemError,
  Event, EventEmitter, Disposable, MarkdownString,
  // namespaces
  workspace, window, commands, languages, notebooks, authentication, tasks, scm, comments, tests, testing: tests, debug, chat, lm, editorChat, extensionPromptFileProvider, interactive, env, l10n, extensions, process,
  TestResultState, TestRunProfileKind, TestMessage,
  version,
  // internal
  _handleMessage: handleMessage,
  _initDefaults(defaults) { _schemaDefaults = defaults || {}; },
};

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
      if (prop === "then") return undefined; // avoid Promise-like behavior
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

vscodeApi.workspace = withApiFallback(workspace, "vscode.workspace");
vscodeApi.window = withApiFallback(window, "vscode.window");
vscodeApi.commands = withApiFallback(commands, "vscode.commands");
vscodeApi.languages = withApiFallback(languages, "vscode.languages");
vscodeApi.notebooks = withApiFallback(notebooks, "vscode.notebooks");
vscodeApi.authentication = withApiFallback(authentication, "vscode.authentication");
vscodeApi.tasks = withApiFallback(tasks, "vscode.tasks");
vscodeApi.scm = withApiFallback(scm, "vscode.scm");
vscodeApi.comments = withApiFallback(comments, "vscode.comments");
vscodeApi.debug = withApiFallback(debug, "vscode.debug");
vscodeApi.chat = withApiFallback(chat, "vscode.chat");
vscodeApi.lm = withApiFallback(lm, "vscode.lm");
vscodeApi.env = withApiFallback(env, "vscode.env");
vscodeApi.l10n = withApiFallback(l10n, "vscode.l10n");
vscodeApi.extensions = withApiFallback(extensions, "vscode.extensions");

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
  let escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  escaped = escaped.replace(/\*\*\//g, "__DOUBLE_STAR_DIR__");
  escaped = escaped.replace(/\*\*/g, "__DOUBLE_STAR__");
  escaped = escaped.replace(/\*/g, "[^/]*");
  escaped = escaped.replace(/\?/g, ".");
  escaped = escaped.replace(/__DOUBLE_STAR_DIR__/g, "(?:.*/)?");
  escaped = escaped.replace(/__DOUBLE_STAR__/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(normalizedFile);
}

function normalizeTextSearchQuery(query) {
  if (query == null) return "";
  if (typeof query === "string") return query;
  if (query instanceof RegExp) return query;
  if (typeof query === "object") {
    if (typeof query.pattern === "string" && query.pattern) return query.pattern;
    if (query.pattern instanceof RegExp) return query.pattern;
    if (typeof query.value === "string" && query.value) return query.value;
  }
  return "";
}

function searchTextContent(content, query) {
  const text = String(content ?? "");
  const lines = text.split(/\r?\n/);
  const results = [];
  if (!query) return results;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineText = lines[lineIndex];
    if (query instanceof RegExp) {
      const flags = query.flags.includes("g") ? query.flags : `${query.flags}g`;
      const regex = new RegExp(query.source, flags);
      let match;
      while ((match = regex.exec(lineText))) {
        const startCharacter = match.index || 0;
        const endCharacter = startCharacter + String(match[0] ?? "").length;
        results.push({ line: lineIndex, startCharacter, endCharacter, lineText });
        if (!match[0]) break;
      }
      continue;
    }

    const needle = String(query);
    if (!needle) continue;
    let offset = 0;
    while (offset <= lineText.length) {
      const index = lineText.indexOf(needle, offset);
      if (index < 0) break;
      results.push({
        line: lineIndex,
        startCharacter: index,
        endCharacter: index + needle.length,
        lineText,
      });
      offset = index + Math.max(1, needle.length);
    }
  }

  return results;
}

async function loadTextDocumentFromArg(arg) {
  if (!arg) return undefined;
  if (typeof arg === "object" && typeof arg.getText === "function" && arg.uri) return arg;
  try {
    return await workspace.openTextDocument(arg);
  } catch {
    return undefined;
  }
}

function normalizeProviderResults(result) {
  if (result == null) return [];
  if (Array.isArray(result)) return result.flatMap((item) => normalizeProviderResults(item));
  if (result.items && Array.isArray(result.items)) return normalizeProviderResults(result.items);
  return [result];
}

async function executeProviderCollection(providers, methodName, ...invokeArgs) {
  const results = [];
  for (const provider of providers || []) {
    if (!provider || typeof provider[methodName] !== "function") continue;
    try {
      const value = await provider[methodName](...invokeArgs);
      results.push(...normalizeProviderResults(value));
    } catch {}
  }
  return results;
}

async function executeFirstRegisteredProvider(providers, methodName, ...invokeArgs) {
  for (const provider of providers || []) {
    if (!provider || typeof provider[methodName] !== "function") continue;
    try {
      const value = await provider[methodName](...invokeArgs);
      if (value != null) return value;
    } catch {}
  }
  return undefined;
}

async function executeCallHierarchyProvider(uriArg, positionArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = [];
  for (const provider of languages._callHierarchyProviders) {
    if (!provider) continue;
    try {
      if (typeof provider.prepareCallHierarchy === "function") {
        const prepared = await provider.prepareCallHierarchy(document, position, CancellationToken.None);
        results.push(...normalizeProviderResults(prepared));
        continue;
      }
      if (typeof provider.provideCallHierarchyItems === "function") {
        const prepared = await provider.provideCallHierarchyItems(document, position, CancellationToken.None);
        results.push(...normalizeProviderResults(prepared));
      }
    } catch {}
  }
  return results;
}

async function executeTypeHierarchyProvider(uriArg, positionArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = [];
  for (const provider of languages._typeHierarchyProviders) {
    if (!provider) continue;
    try {
      if (typeof provider.prepareTypeHierarchy === "function") {
        const prepared = await provider.prepareTypeHierarchy(document, position, CancellationToken.None);
        results.push(...normalizeProviderResults(prepared));
        continue;
      }
      if (typeof provider.provideTypeHierarchyItems === "function") {
        const prepared = await provider.provideTypeHierarchyItems(document, position, CancellationToken.None);
        results.push(...normalizeProviderResults(prepared));
      }
    } catch {}
  }
  return results;
}

async function executeInlineValuesProvider(uriArg, rangeArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const range = rangeArg || new Range(0, 0, 0, 0);
  const results = [];
  for (const provider of languages._inlineValuesProviders) {
    if (!provider || typeof provider.provideInlineValues !== "function") continue;
    try {
      const value = await provider.provideInlineValues(document, range, CancellationToken.None);
      results.push(...normalizeProviderResults(value));
    } catch {}
  }
  return results;
}

function completionItemToSimple(item) {
  if (!item) return null;
  const label = typeof item.label === "string"
    ? item.label
    : item.label?.label || "";
  if (!label) return null;
  return {
    label,
    insertText: typeof item.insertText === "string" ? item.insertText : undefined,
    detail: typeof item.detail === "string" ? item.detail : undefined,
    documentation: typeof item.documentation === "string"
      ? item.documentation
      : typeof item.documentation?.value === "string"
        ? item.documentation.value
        : undefined,
    kind: typeof item.kind === "number" ? item.kind : undefined,
  };
}

function normalizeCompletionProviderOutput(output) {
  if (output == null) return [];
  const items = Array.isArray(output)
    ? output
    : Array.isArray(output.items)
      ? output.items
      : [];
  return items.map(completionItemToSimple).filter(Boolean);
}

async function executeCompletionItemProvider(uriArg, positionArg, triggerChar, contextArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = [];
  for (const provider of languages._completionProviders) {
    if (!provider || typeof provider.provideCompletionItems !== "function") continue;
    try {
      const value = await provider.provideCompletionItems(
        document,
        position,
        CancellationToken.None,
        { triggerKind: 0, triggerCharacter: triggerChar, ...contextArg },
      );
      results.push(...normalizeCompletionProviderOutput(value));
    } catch {}
  }
  return results;
}

async function executeHoverProvider(uriArg, positionArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = [];
  for (const provider of languages._hoverProviders) {
    if (!provider || typeof provider.provideHover !== "function") continue;
    try {
      const value = await provider.provideHover(document, position, CancellationToken.None);
      if (value) results.push(value);
    } catch {}
  }
  return results;
}

function normalizeInlineCompletionItem(item) {
  if (!item) return null;
  return {
    insertText: typeof item.insertText === "string" ? item.insertText : item.insertText?.value || "",
    filterText: typeof item.filterText === "string" ? item.filterText : undefined,
    range: item.range,
    command: item.command,
  };
}

async function executeInlineCompletionItemProvider(uriArg, positionArg, contextArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = [];
  for (const provider of languages._inlineCompletionProviders) {
    if (!provider || typeof provider.provideInlineCompletionItems !== "function") continue;
    try {
      const value = await provider.provideInlineCompletionItems(document, position, contextArg ?? {}, CancellationToken.None);
      const items = Array.isArray(value)
        ? value
        : Array.isArray(value?.items)
          ? value.items
          : [];
      results.push(...items.map(normalizeInlineCompletionItem).filter(Boolean));
    } catch {}
  }
  return results;
}

async function executeCodeLensProvider(uriArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const results = [];
  for (const provider of languages._codeLensProviders) {
    if (!provider || typeof provider.provideCodeLenses !== "function") continue;
    try {
      const value = await provider.provideCodeLenses(document, CancellationToken.None);
      const items = Array.isArray(value)
        ? value
        : Array.isArray(value?.items)
          ? value.items
          : [];
      results.push(...items);
    } catch {}
  }
  return results;
}

async function executeLocationProvider(providers, methodName, uriArg, positionArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  return executeProviderCollection(providers, methodName, document, position, CancellationToken.None);
}

async function executeReferenceProvider(uriArg, positionArg, context = {}) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  const results = await executeProviderCollection(languages._referenceProviders, "provideReferences", document, position, context, CancellationToken.None);
  return results;
}

async function executeWorkspaceSymbolProvider(query) {
  const results = await executeProviderCollection(languages._workspaceSymbolProviders, "provideWorkspaceSymbols", String(query || ""), CancellationToken.None);
  return results;
}

async function executeDocumentSymbolProvider(uriArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  return executeProviderCollection(languages._documentSymbolProviders, "provideDocumentSymbols", document, CancellationToken.None);
}

async function executeCodeActionProvider(uriArg, rangeArg, contextArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const range = rangeArg || new Range(0, 0, 0, 0);
  const context = contextArg || { diagnostics: [] };
  return executeProviderCollection(languages._codeActionProviders, "provideCodeActions", document, range, context, CancellationToken.None);
}

async function executeSignatureHelpProvider(uriArg, positionArg, contextArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  return executeProviderCollection(languages._signatureHelpProviders, "provideSignatureHelp", document, position, CancellationToken.None, contextArg);
}

async function executeFormattingProvider(providers, methodName, uriArg, rangeArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  if (rangeArg) {
    return executeProviderCollection(providers, methodName, document, rangeArg, CancellationToken.None);
  }
  return executeProviderCollection(providers, methodName, document, CancellationToken.None);
}

async function executeDocumentHighlightProvider(uriArg, positionArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const position = positionArg || new Position(0, 0);
  return executeProviderCollection(languages._documentHighlightProviders, "provideDocumentHighlights", document, position, CancellationToken.None);
}

async function executeDocumentLinkProvider(uriArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  return executeProviderCollection(languages._documentLinkProviders, "provideDocumentLinks", document, CancellationToken.None);
}

async function executeSelectionRangeProvider(uriArg, positionsArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const positions = Array.isArray(positionsArg) ? positionsArg : [positionsArg || new Position(0, 0)];
  return executeProviderCollection(languages._selectionRangeProviders, "provideSelectionRanges", document, positions, CancellationToken.None);
}

async function executeInlayHintProvider(uriArg, rangeArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  const range = rangeArg || new Range(0, 0, 0, 0);
  return executeProviderCollection(languages._inlayHintProviders, "provideInlayHints", document, range, CancellationToken.None);
}

async function executeFoldingRangeProvider(uriArg) {
  const document = await loadTextDocumentFromArg(uriArg);
  if (!document) return [];
  return executeProviderCollection(languages._foldingRangeProviders, "provideFoldingRanges", document, {}, CancellationToken.None);
}
