"use strict";

// Athva Extension Host — runs as a child Node.js process.
// Loads a single VS Code extension and bridges it to the renderer over stdio IPC.
//
// argv: node host.js <extensionMainPath> <extensionId> <installPath>

const path = require("path");
const { send, onMessage } = require("./ipc");

const [,, extMain, extId, installPath] = process.argv;

if (!extMain) {
  send({ type: "error", message: "host.js requires <extensionMainPath> as first arg" });
  process.exit(1);
}

// Override require('vscode') before loading the extension
const Module = require("module");
const origLoad = Module._load;
const shimPath = path.resolve(__dirname, "vscode-shim.js");
// Load shim first so it can call require('./ipc') correctly
const vscode = require(shimPath);

Module._load = function (req, parent, isMain) {
  if (req === "vscode") return vscode;
  return origLoad.call(this, req, parent, isMain);
};

// Handle messages from renderer
onMessage(async (msg) => {
  await vscode._handleMessage(msg);
});

// Load and activate the extension
async function main() {
  try {
    const ext = require(path.resolve(extMain));
    if (!ext || typeof ext.activate !== "function") {
      send({ type: "error", message: "Extension has no activate() export" });
      return;
    }

    const context = {
      subscriptions: {
        _items: [],
        push(...items) { this._items.push(...items); },
      },
      extensionPath: installPath,
      extensionUri: { fsPath: installPath, scheme: "file", path: installPath, toString: () => installPath },
      storagePath: path.join(require("os").tmpdir(), "athva-ext-" + extId.replace(/[^a-z0-9]/gi, "_")),
      globalStoragePath: path.join(require("os").tmpdir(), "athva-ext-global-" + extId.replace(/[^a-z0-9]/gi, "_")),
      logPath: path.join(require("os").tmpdir(), "athva-ext-log-" + extId.replace(/[^a-z0-9]/gi, "_")),
      extensionMode: 1, // Production
      workspaceState: {
        _data: {},
        get(key, defaultValue) { return this._data[key] ?? defaultValue; },
        update(key, value) { this._data[key] = value; return Promise.resolve(); },
        keys() { return Object.keys(this._data); },
      },
      globalState: {
        _data: {},
        get(key, defaultValue) { return this._data[key] ?? defaultValue; },
        update(key, value) { this._data[key] = value; return Promise.resolve(); },
        setKeysForSync(keys) {},
        keys() { return Object.keys(this._data); },
      },
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: { event: () => ({ dispose: () => {} }) },
      },
      asAbsolutePath(relativePath) { return path.join(installPath, relativePath); },
      environmentVariableCollection: {
        persistent: false, description: undefined,
        replace() {}, append() {}, prepend() {}, get() { return undefined; },
        forEach() {}, delete() {}, clear() {},
        getScoped() { return this; }, [Symbol.iterator]() { return [][Symbol.iterator](); },
      },
      extension: { id: extId, extensionPath: installPath, isActive: true, packageJSON: {} },
      languageModelAccessInformation: { canSendRequest: () => undefined, onDidChange: () => ({ dispose: () => {} }) },
    };

    await ext.activate(context);
    send({ type: "activated", extensionId: extId });
  } catch (e) {
    send({ type: "error", message: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") });
  }
}

main();
