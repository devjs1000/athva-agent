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
