"use strict";

// Athva Extension Host — runs as a child Node.js process.
// Loads a single VS Code extension and bridges it to the renderer over stdio IPC.
//
// argv: node host.cjs <extensionMainPath> <extensionId> <installPath>

const path = require("path");
const os = require("os");
const fs = require("fs");
const { send, onMessage } = require("./ipc.cjs");

const [,, extMain, extId, installPath] = process.argv;

if (!extMain) {
  send({ type: "error", message: "host.cjs requires <extensionMainPath> as first arg" });
  process.exit(1);
}

// Override require('vscode') before loading the extension
const Module = require("module");
const origLoad = Module._load;
const shimPath = path.resolve(__dirname, "vscode-shim.cjs");
const vscode = require(shimPath);

Module._load = function (req, parent, isMain) {
  if (req === "vscode") return vscode;
  return origLoad.call(this, req, parent, isMain);
};

// Buffer messages that arrive before the extension is activated.
// setWorkspace fires workspaceFoldersEmitter which extensions listen to —
// if it arrives before _initDefaults is called, config lookups return undefined.
let _activated = false;
const _msgQueue = [];
onMessage(async (msg) => {
  if (!_activated) { _msgQueue.push(msg); return; }
  await vscode._handleMessage(msg);
});

function flushQueue() {
  _activated = true;
  for (const msg of _msgQueue) {
    vscode._handleMessage(msg).catch(() => {});
  }
  _msgQueue.length = 0;
}

// Build a Uri-like object from a filesystem path
function makeUri(fsPath) {
  return {
    scheme: "file",
    authority: "",
    path: fsPath,
    query: "",
    fragment: "",
    fsPath,
    toString: () => `file://${fsPath}`,
    with: (change) => makeUri(change.path ?? fsPath),
  };
}

// Resolve system binaries that extensions may need (ripgrep, etc.)
function resolveSystemBinaries() {
  const rg = process.platform === "win32" ? "rg.exe" : "rg";

  // Bundled binary lives next to host.cjs (works in both dev and production)
  const bundled = path.join(__dirname, rg);
  if (fs.existsSync(bundled)) return { "todo-tree.ripgrep.ripgrep": bundled };

  // Try to find via shell with augmented PATH
  try {
    const { execSync } = require("child_process");
    const augPath = "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/opt/ripgrep/bin";
    const found = execSync(
      `PATH="${augPath}:$PATH" command -v ${rg} 2>/dev/null`,
      { encoding: "utf8", timeout: 2000, shell: "/bin/sh" }
    ).trim();
    if (found && fs.existsSync(found)) return { "todo-tree.ripgrep.ripgrep": found };
  } catch {}

  // Static fallbacks
  for (const p of [`/opt/homebrew/bin/${rg}`, `/usr/local/bin/${rg}`, `/usr/bin/${rg}`]) {
    if (fs.existsSync(p)) return { "todo-tree.ripgrep.ripgrep": p };
  }
  return {};
}

// Extract default values from contributes.configuration schema
function extractConfigDefaults(packageJSON) {
  const defaults = {};
  const configs = packageJSON?.contributes?.configuration;
  if (!configs) return defaults;
  const sections = Array.isArray(configs) ? configs : [configs];
  for (const section of sections) {
    for (const [key, def] of Object.entries(section.properties || {})) {
      if ("default" in def) defaults[key] = def.default;
    }
  }
  return defaults;
}

// Load and activate the extension
async function main() {
  try {
    // Read package.json for metadata and schema defaults
    let packageJSON = {};
    const pkgCandidates = [
      path.join(installPath, "package.json"),
      path.join(installPath, "..", "package.json"),
    ];
    for (const p of pkgCandidates) {
      try { packageJSON = JSON.parse(fs.readFileSync(p, "utf8")); break; } catch {}
    }

    // Seed the shim with schema-defined config defaults so extensions get
    // correct zero-values (e.g. {} for tagGroups) rather than undefined.
    // System binaries (e.g. ripgrep) are resolved and merged in so extensions
    // that require them work without manual user configuration.
    const configDefaults = { ...extractConfigDefaults(packageJSON), ...resolveSystemBinaries() };
    vscode._initDefaults(configDefaults);

    const ext = require(path.resolve(extMain));
    if (!ext || typeof ext.activate !== "function") {
      send({ type: "error", message: "Extension has no activate() export" });
      return;
    }

    const safeId = extId.replace(/[^a-z0-9]/gi, "_");
    const storagePath = path.join(os.tmpdir(), `athva-ext-${safeId}`);
    const globalStoragePath = path.join(os.tmpdir(), `athva-ext-global-${safeId}`);
    const logPath = path.join(os.tmpdir(), `athva-ext-log-${safeId}`);

    // Ensure storage dirs exist — some extensions mkdir on their own, others assume it exists
    for (const dir of [storagePath, globalStoragePath, logPath]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }

    const context = {
      subscriptions: {
        _items: [],
        push(...items) { this._items.push(...items); },
      },
      extensionPath: installPath,
      extensionUri: makeUri(installPath),
      storagePath,
      storageUri: makeUri(storagePath),
      globalStoragePath,
      globalStorageUri: makeUri(globalStoragePath),
      logPath,
      logUri: makeUri(logPath),
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
      extension: { id: extId, extensionPath: installPath, isActive: true, packageJSON },
      languageModelAccessInformation: { canSendRequest: () => undefined, onDidChange: () => ({ dispose: () => {} }) },
    };

    await ext.activate(context);
    flushQueue();
    send({ type: "activated", extensionId: extId });
  } catch (e) {
    flushQueue();
    const msg = e && typeof e.message === "string" ? e.message : String(e);
    const stack = e && typeof e.stack === "string"
      ? e.stack.split("\n").slice(0, 25).join("\n")
      : "";
    send({ type: "error", message: msg, stack });
  }
}

main();
