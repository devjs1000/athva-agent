import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vscode = require("../src/extension-host/vscode-shim.cjs");

test("vscode shim exposes compatibility namespaces and aliases", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  writeFileSync(join(workspaceRoot, "match.txt"), "first line\nneedle here\nlast line", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  assert.equal(typeof vscode.languages.registerCodeActionProvider, "function");
  assert.equal(typeof vscode.workspace.findTextInFiles, "function");
  assert.equal(typeof vscode.scm.createSourceControl, "function");
  assert.equal(typeof vscode.comments.createCommentController, "function");

  const files = await vscode.workspace.findFiles("**/*.txt", undefined, 10);
  assert.equal(files.length, 1);
  assert.equal(files[0].fsPath, join(workspaceRoot, "match.txt"));

  const results = await vscode.workspace.findTextInFiles("needle", {
    include: "**/*.txt",
    maxResults: 10,
  });

  assert.equal(Array.isArray(results), true);
  assert.equal(results.length, 1);
  assert.equal(results[0].uri.fsPath, join(workspaceRoot, "match.txt"));
  assert.equal(results[0].ranges[0].start.line, 1);
  assert.equal(results[0].ranges[0].start.character, 0);
});

test("vscode shim executes registered language providers", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "provider.ts");
  writeFileSync(filePath, "const value = 1;\nvalue;\n", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  const disposable = vscode.languages.registerDefinitionProvider("typescript", {
    provideDefinition(document, position) {
      return [
        new vscode.Location(
          document.uri,
          new vscode.Range(position.line, 0, position.line, 5),
        ),
      ];
    },
  });

  const result = await vscode.commands.executeCommand(
    "vscode.executeDefinitionProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(1, 0),
  );

  disposable.dispose();

  assert.equal(Array.isArray(result), true);
  assert.equal(result.length, 1);
  assert.equal(result[0].uri.fsPath, filePath);
  assert.equal(result[0].range.start.line, 1);
  assert.equal(result[0].range.start.character, 0);
});

test("vscode shim executes completion and hover providers", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "complete.ts");
  writeFileSync(filePath, "const value = 1;\nvalue.\n", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  const completionDisposable = vscode.languages.registerCompletionItemProvider("typescript", {
    provideCompletionItems() {
      return [
        new vscode.CompletionItem("alpha"),
        new vscode.CompletionItem("beta"),
      ];
    },
  });

  const hoverDisposable = vscode.languages.registerHoverProvider("typescript", {
    provideHover() {
      return new vscode.Hover([new vscode.MarkdownString("hello hover")]);
    },
  });

  const completionResult = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(1, 0),
  );

  const hoverResult = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(1, 0),
  );

  completionDisposable.dispose();
  hoverDisposable.dispose();

  assert.equal(Array.isArray(completionResult), true);
  assert.equal(completionResult.length, 2);
  assert.equal(completionResult[0].label, "alpha");
  assert.equal(completionResult[1].label, "beta");
  assert.equal(Array.isArray(hoverResult), true);
  assert.equal(hoverResult.length, 1);
  assert.equal(hoverResult[0].contents[0].value, "hello hover");
});

test("vscode shim executes inline completion and code lens providers", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "lenses.ts");
  writeFileSync(filePath, "const answer = 42;\nanswer\n", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  const inlineDisposable = vscode.languages.registerInlineCompletionItemProvider("typescript", {
    provideInlineCompletionItems() {
      return [
        new vscode.InlineCompletionItem("console.log(answer);"),
      ];
    },
  });

  const codeLensDisposable = vscode.languages.registerCodeLensProvider("typescript", {
    provideCodeLenses(document) {
      return [
        { range: new vscode.Range(0, 0, 0, 5), command: { title: document.uri.fsPath, command: "noop" } },
      ];
    },
  });

  const inlineResult = await vscode.commands.executeCommand(
    "vscode.executeInlineCompletionItemProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(1, 0),
    {},
  );

  const codeLensResult = await vscode.commands.executeCommand(
    "vscode.executeCodeLensProvider",
    vscode.Uri.file(filePath),
  );

  inlineDisposable.dispose();
  codeLensDisposable.dispose();

  assert.equal(Array.isArray(inlineResult), true);
  assert.equal(inlineResult.length, 1);
  assert.equal(inlineResult[0].insertText, "console.log(answer);");
  assert.equal(Array.isArray(codeLensResult), true);
  assert.equal(codeLensResult.length, 1);
  assert.equal(codeLensResult[0].command.title, filePath);
});

test("vscode shim executes linked editing and declaration providers", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "symbols.ts");
  writeFileSync(filePath, "class Alpha {}\n", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  const linkedDisposable = vscode.languages.registerLinkedEditingRangeProvider("typescript", {
    provideLinkedEditingRanges(document) {
      return new vscode.LinkedEditingRanges([
        new vscode.Range(0, 6, 0, 11),
      ]);
    },
  });

  const declarationDisposable = vscode.languages.registerDeclarationProvider("typescript", {
    provideDeclaration(document, position) {
      return [
        new vscode.Location(document.uri, new vscode.Range(position.line, 0, position.line, 5)),
      ];
    },
  });

  const linkedResult = await vscode.commands.executeCommand(
    "vscode.executeLinkedEditingRangeProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(0, 6),
  );

  const declarationResult = await vscode.commands.executeCommand(
    "vscode.executeDeclarationProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(0, 0),
  );

  linkedDisposable.dispose();
  declarationDisposable.dispose();

  assert.equal(linkedResult.ranges.length, 1);
  assert.equal(linkedResult.ranges[0].start.character, 6);
  assert.equal(Array.isArray(declarationResult), true);
  assert.equal(declarationResult.length, 1);
  assert.equal(declarationResult[0].uri.fsPath, filePath);
});
