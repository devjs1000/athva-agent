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

test("vscode shim executes registered commands", async () => {
  const disposable = vscode.commands.registerCommand("athva.test.echo", (value) => value);
  const commandResult = await vscode.commands.executeCommand("athva.test.echo", "hello");
  disposable.dispose();

  assert.equal(commandResult, "hello");
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

test("vscode shim executes call hierarchy, type hierarchy, and inline values providers", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "hierarchy.ts");
  writeFileSync(filePath, "function alpha() { return 1; }\n", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  const callDisposable = vscode.languages.registerCallHierarchyProvider("typescript", {
    prepareCallHierarchy(document, position) {
      return [
        new vscode.CallHierarchyItem(
          vscode.SymbolKind.Function,
          "alpha",
          "",
          document.uri,
          new vscode.Range(0, 0, 0, 30),
          new vscode.Range(0, 9, 0, 14),
        ),
      ];
    },
  });

  const typeDisposable = vscode.languages.registerTypeHierarchyProvider("typescript", {
    prepareTypeHierarchy(document, position) {
      return [
        new vscode.TypeHierarchyItem(
          vscode.SymbolKind.Class,
          "Alpha",
          "",
          document.uri,
          new vscode.Range(0, 0, 0, 30),
          new vscode.Range(0, 9, 0, 14),
        ),
      ];
    },
  });

  const inlineDisposable = vscode.languages.registerInlineValuesProvider("typescript", {
    provideInlineValues(document, range) {
      return [
        new vscode.InlineValueText(
          new vscode.Range(0, 0, 0, 0),
          "1",
        ),
      ];
    },
  });

  const callResult = await vscode.commands.executeCommand(
    "vscode.executeCallHierarchyProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(0, 9),
  );

  const typeResult = await vscode.commands.executeCommand(
    "vscode.executeTypeHierarchyProvider",
    vscode.Uri.file(filePath),
    new vscode.Position(0, 9),
  );

  const inlineResult = await vscode.commands.executeCommand(
    "vscode.executeInlineValuesProvider",
    vscode.Uri.file(filePath),
    new vscode.Range(0, 0, 0, 30),
  );

  callDisposable.dispose();
  typeDisposable.dispose();
  inlineDisposable.dispose();

  assert.equal(Array.isArray(callResult), true);
  assert.equal(callResult.length, 1);
  assert.equal(callResult[0].name, "alpha");
  assert.equal(Array.isArray(typeResult), true);
  assert.equal(typeResult.length, 1);
  assert.equal(typeResult[0].name, "Alpha");
  assert.equal(Array.isArray(inlineResult), true);
  assert.equal(inlineResult.length, 1);
  assert.equal(inlineResult[0].text, "1");
});

test("vscode shim supports tasks and debug session lifecycle", async () => {
  const taskEvents = [];
  const debugEvents = [];
  const adapterEvents = [];

  const taskDisposable = vscode.tasks.registerTaskProvider("athva", {
    provideTasks() {
      return [{ name: "build" }];
    },
  });

  const debugDisposable = vscode.debug.registerDebugConfigurationProvider("athva-debug", {
    provideDebugConfigurations() {
      return [{ type: "athva-debug", name: "Launch Athva" }];
    },
  });
  const descriptorDisposable = vscode.debug.registerDebugAdapterDescriptorFactory("athva-debug", {
    createDebugAdapterDescriptor(session) {
      adapterEvents.push(`descriptor:${session.type}`);
      return { type: "server", port: 8123 };
    },
  });
  const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory("athva-debug", {
    createDebugAdapterTracker(session) {
      adapterEvents.push(`tracker:create:${session.type}`);
      return {
        onWillStartSession() {
          adapterEvents.push("tracker:willStart");
        },
        onDidStartSession() {
          adapterEvents.push("tracker:didStart");
        },
        onWillStopSession() {
          adapterEvents.push("tracker:willStop");
        },
        onWillTerminateSession() {
          adapterEvents.push("tracker:willTerminate");
        },
        onDidTerminateSession() {
          adapterEvents.push("tracker:didTerminate");
        },
        dispose() {
          adapterEvents.push("tracker:dispose");
        },
      };
    },
  });

  const startTaskSub = vscode.tasks.onDidStartTask((event) => taskEvents.push(`start:${event.task.name}`));
  const endTaskSub = vscode.tasks.onDidEndTask((event) => taskEvents.push(`end:${event.task.name}`));
  const startDebugSub = vscode.debug.onDidStartDebugSession((session) => debugEvents.push(`start:${session?.name ?? "none"}`));
  const endDebugSub = vscode.debug.onDidTerminateDebugSession((session) => debugEvents.push(`end:${session?.name ?? "none"}`));

  const tasks = await vscode.tasks.fetchTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, "build");

  const execution = await vscode.tasks.executeTask({ name: "build" });
  await execution.terminate();

  const started = await vscode.debug.startDebugging(undefined, "athva-debug");
  assert.equal(started, true);
  assert.equal(vscode.debug.activeDebugSession?.name, "Launch Athva");
  await vscode.debug.stopDebugging();

  taskDisposable.dispose();
  debugDisposable.dispose();
  descriptorDisposable.dispose();
  trackerDisposable.dispose();
  startTaskSub.dispose();
  endTaskSub.dispose();
  startDebugSub.dispose();
  endDebugSub.dispose();

  assert.deepEqual(taskEvents, ["start:build", "end:build"]);
  assert.deepEqual(debugEvents, ["start:Launch Athva", "end:Launch Athva"]);
  assert.deepEqual(adapterEvents, [
    "descriptor:athva-debug",
    "tracker:create:athva-debug",
    "tracker:willStart",
    "tracker:didStart",
    "tracker:willStop",
    "tracker:willTerminate",
    "tracker:didTerminate",
    "tracker:dispose",
  ]);
});

test("vscode shim routes openWith to a registered custom editor provider", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const filePath = join(workspaceRoot, "custom.txt");
  writeFileSync(filePath, "custom editor content", "utf8");

  await vscode._handleMessage({
    type: "setWorkspace",
    folders: [workspaceRoot],
    configuration: {},
  });

  let resolved = false;
  const disposable = vscode.window.registerCustomEditorProvider("athva.custom", {
    async resolveCustomTextEditor(document, webviewPanel) {
      resolved = true;
      webviewPanel.webview.html = `<p>${document.getText()}</p>`;
    },
  });

  const result = await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(filePath),
    "athva.custom",
  );

  disposable.dispose();

  assert.equal(result, true);
  assert.equal(resolved, true);
});

test("vscode shim resolves text document content providers for custom schemes", async () => {
  const scheme = `athva-test-${Date.now()}`;
  const disposable = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) {
      return `content for ${uri.scheme}`;
    },
  });

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:/virtual/doc.txt`));

  disposable.dispose();

  assert.equal(doc.getText(), `content for ${scheme}`);
  assert.equal(doc.uri.scheme, scheme);
});

test("vscode shim deserializes notebooks through a registered serializer", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "athva-vscode-shim-"));
  const notebookPath = join(workspaceRoot, "notebook.nb");
  writeFileSync(notebookPath, "serialized notebook", "utf8");

  let deserialized = false;
  let statusBarCalls = 0;
  let kernelSourceCalls = 0;
  const disposable = vscode.workspace.registerNotebookSerializer("athva-notebook", {
    deserializeNotebook(data) {
      deserialized = true;
      return {
        cells: [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "print(1)", "python"),
        ],
        metadata: { source: String(data) },
      };
    },
  });
  const statusBarDisposable = vscode.notebooks.registerNotebookCellStatusBarItemProvider("athva-notebook", {
    async provideCellStatusBarItems(cell) {
      statusBarCalls += 1;
      return [
        new vscode.NotebookCellStatusBarItem(
          `cell:${cell.value}`,
          vscode.NotebookCellStatusBarAlignment.Left,
        ),
      ];
    },
  });
  const kernelSourceDisposable = vscode.notebooks.registerKernelSourceActionProvider("athva-notebook", {
    async provideKernelSourceActions() {
      kernelSourceCalls += 1;
      return [
        {
          label: "Use notebook kernel",
          command: "athva.useNotebookKernel",
        },
      ];
    },
  });

  const doc = await vscode.workspace.openNotebookDocument(
    "athva-notebook",
    vscode.Uri.file(notebookPath),
  );

  disposable.dispose();
  statusBarDisposable.dispose();
  kernelSourceDisposable.dispose();

  assert.equal(deserialized, true);
  assert.equal(doc.notebookType, "athva-notebook");
  assert.equal(doc.cellCount, 1);
  assert.equal(doc.getCells().length, 1);
  assert.equal(doc.getCells()[0].value, "print(1)");
  assert.equal(statusBarCalls, 1);
  assert.equal(kernelSourceCalls, 1);
  assert.equal(doc.cellStatusBarItems[0][0].text, "cell:print(1)");
  assert.equal(doc.kernelSourceActions[0].label, "Use notebook kernel");
});

test("vscode shim routes internal scheme URIs through registered uri handlers", async () => {
  let handled = "";
  const disposable = vscode.window.registerUriHandler({
    handleUri(uri) {
      handled = uri.toString();
    },
  });

  await vscode.env.openExternal(vscode.Uri.parse("athva://deep/link"));

  disposable.dispose();

  assert.equal(handled, "athva://deep/link");
});

test("vscode shim applies a registered terminal profile when creating a terminal", async () => {
  const disposable = vscode.window.registerTerminalProfileProvider("athva-profile", {
    provideTerminalProfile() {
      return {
        name: "Athva Profile",
        options: { name: "Athva Profile", cwd: "/tmp" },
      };
    },
  });

  const terminal = vscode.window.createTerminal("Fallback");

  disposable.dispose();

  assert.equal(terminal.name, "Athva Profile");
  assert.equal(terminal.creationOptions.name, "Athva Profile");
});

test("vscode shim routes terminal link clicks through registered providers", async () => {
  const handled = [];
  const disposable = vscode.window.registerTerminalLinkProvider({
    provideTerminalLinks(context) {
      handled.push(`provide:${context.line}`);
      return [
        {
          text: context.line,
          range: new vscode.Range(0, 0, 0, context.line.length),
        },
      ];
    },
    handleLink(link) {
      handled.push(`handle:${link.text}`);
    },
  });

  await vscode._handleMessage({
    type: "terminalLink",
    id: "terminal-link-test",
    uri: "https://example.com",
  });

  disposable.dispose();

  assert.deepEqual(handled, [
    "provide:https://example.com",
    "handle:https://example.com",
  ]);
});

test("vscode shim selects language models and refreshes MCP server definitions from providers", async () => {
  const lmDisposable = vscode.lm.registerLanguageModelChatProvider("custom-provider", {
    async provideLanguageModelChatInformation() {
      return [
        {
          id: "model-1",
          vendor: "custom-vendor",
          family: "custom",
          version: "1.0",
          name: "Custom Model",
          maxInputTokens: 1024,
          maxOutputTokens: 512,
        },
      ];
    },
  });

  const mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider("demo.mcp", {
    async provideMcpServerDefinitions() {
      return [
        {
          label: "Demo MCP",
          command: "node",
          args: ["server.js"],
          env: {},
          version: "1",
        },
      ];
    },
  });

  await vscode._refreshMcpServerDefinitions();

  const models = await vscode.lm.selectChatModels({ vendor: "custom-vendor" });

  assert.equal(vscode.lm.mcpServerDefinitions.length, 1);
  assert.equal(vscode.lm.mcpServerDefinitions[0].label, "Demo MCP");

  lmDisposable.dispose();
  mcpDisposable.dispose();

  await vscode._refreshMcpServerDefinitions();

  assert.equal(models.length, 1);
  assert.equal(models[0].name, "Custom Model");
  assert.equal(models[0].vendor, "custom-vendor");
  assert.equal(vscode.lm.mcpServerDefinitions.length, 0);
});

test("vscode shim resolves port attributes and suppresses localhost openExternal when ignored", async () => {
  const disposable = vscode.workspace.registerPortAttributesProvider(
    { portRange: [3000, 3001] },
    {
      providePortAttributes(attributes) {
        if (attributes.port === 3000) {
          return new vscode.PortAttributes(vscode.PortAutoForwardAction.Ignore);
        }
        return undefined;
      },
    },
  );

  const resolved = await vscode._resolvePortAttributes({ port: 3000, pid: undefined, commandLine: undefined });
  assert.equal(resolved?.autoForwardAction, vscode.PortAutoForwardAction.Ignore);

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = function write(chunk, encoding, cb) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encoding === "function") {
      return originalWrite(chunk, encoding);
    }
    return originalWrite(chunk, encoding, cb);
  };

  try {
    await vscode.env.openExternal(vscode.Uri.parse("http://localhost:3000"));
  } finally {
    process.stdout.write = originalWrite;
  }

  disposable.dispose();

  assert.equal(chunks.some((chunk) => chunk.includes('"type":"openExternal"')), false);
});
